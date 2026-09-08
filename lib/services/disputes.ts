import { createHash } from 'node:crypto'
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { accessKeys, chats, connections, messageDisputes, messages } from '@/lib/db/schema'
import { keyActor, recordEvent, safeHistoryLabel, type HistoryActor, type Store } from './history'

// 512 MiB of UTF-8 candidate text plus at most 10,000 rows of metadata.
// An import exceeding either limit rolls back, including earlier batch rows.
export const MAX_PENDING_BYTES = 512 * 1024 * 1024
export const MAX_PENDING_CANDIDATES = 10_000
export class DisputeCapacityError extends Error { constructor() { super('dispute_capacity'); this.name = 'DisputeCapacityError' } }
export function captureDispute(messageId: string, incomingKeyId: string, incomingText: string | null, store: Store, budget?: { n: number; bytes: number }) {
  const message = store.select({ id: messages.id, chatId: messages.chatId, revision: messages.revision, text: messages.text, sentAt: messages.sentAt, senderName: messages.senderName, editedAt: messages.editedAt, conflictedAt: messages.conflictedAt, contentActor: messages.contentActor, contentKeyId: messages.contentKeyId }).from(messages).where(and(eq(messages.id, messageId), isNull(messages.deletedAt))).get()
  if (!message || message.text === incomingText) return
  const fingerprint = createHash('sha256').update(JSON.stringify(incomingText)).digest('hex')
  const existing = store.select().from(messageDisputes).where(and(eq(messageDisputes.messageId, messageId), eq(messageDisputes.revision, message.revision), eq(messageDisputes.incomingKeyId, incomingKeyId), eq(messageDisputes.fingerprint, fingerprint))).get()
  if (existing) {
    if (existing.incomingText !== incomingText) throw new Error('candidate_identity_collision')
    store.update(messageDisputes).set({ occurrences: existing.occurrences + 1, lastSeenAt: new Date() }).where(eq(messageDisputes.id, existing.id)).run()
  } else {
    const usage = budget ?? store.select({ n: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(length(cast(incoming_text as blob))), 0)` }).from(messageDisputes).get()!
    if (budget && (usage.n >= MAX_PENDING_CANDIDATES || usage.bytes + Buffer.byteLength(incomingText ?? '') > MAX_PENDING_BYTES)) Object.assign(usage, pendingBudget(store))
    if (usage.n >= MAX_PENDING_CANDIDATES || usage.bytes + Buffer.byteLength(incomingText ?? '') > MAX_PENDING_BYTES) throw new DisputeCapacityError()
    store.insert(messageDisputes).values({ messageId, incomingKeyId, incomingText, fingerprint, revision: message.revision }).run()
    if (budget) { budget.n++; budget.bytes += Buffer.byteLength(incomingText ?? '') }
  }
  store.update(messages).set({ conflictedAt: new Date() }).where(eq(messages.id, messageId)).run()
}
export function clearDisputes(messageIds: string[], store: Store) {
  if (messageIds.length) store.delete(messageDisputes).where(inArray(messageDisputes.messageId, messageIds)).run()
}
export function disputeList(sourceId?: string, keyId?: string, cursor?: string) {
  const rows = db.select({ id: messages.id, chatId: chats.id, title: chats.title, senderName: messages.senderName, sourceId: connections.id,
    sourceLabel: connections.displayName, channel: connections.channel, conflictedAt: messages.conflictedAt,
  }).from(messages).innerJoin(chats, eq(chats.id, messages.chatId)).innerJoin(connections, eq(connections.id, chats.connectionId))
    .where(and(isNull(messages.deletedAt), isNotNull(messages.conflictedAt), sourceId ? eq(connections.id, sourceId) : undefined,
      keyId ? sql`exists(select 1 from message_disputes d where d.message_id = ${messages.id} and d.incoming_key_id = ${keyId})` : undefined,
      cursor ? sql`${messages.id} < ${cursor}` : undefined))
    .orderBy(desc(messages.id)).limit(51).all()
  return { rows: rows.slice(0, 50), next: rows.length > 50 ? rows[49].id : null }
}
export function pendingDisputeCount(sourceId?: string) {
  return db.select({ n: sql<number>`count(*)` }).from(messages).innerJoin(chats, eq(chats.id, messages.chatId)).where(and(isNull(messages.deletedAt), isNotNull(messages.conflictedAt), sourceId ? eq(chats.connectionId, sourceId) : undefined)).get()!.n
}
function candidateToken(message: Pick<typeof messages.$inferSelect, 'revision' | 'conflictedAt'>, candidates: Array<typeof messageDisputes.$inferSelect>) {
  return createHash('sha256').update(JSON.stringify([message.revision, message.conflictedAt, candidates.map(c => [c.id, c.occurrences, c.lastSeenAt])])).digest('hex')
}
export function getDispute(messageId: string, store: Store = db) {
  const message = store.select({ id: messages.id, chatId: messages.chatId, revision: messages.revision, text: messages.text, sentAt: messages.sentAt, senderName: messages.senderName, editedAt: messages.editedAt, conflictedAt: messages.conflictedAt, contentActor: messages.contentActor, contentKeyId: messages.contentKeyId }).from(messages).where(and(eq(messages.id, messageId), isNull(messages.deletedAt), isNotNull(messages.conflictedAt))).get()
  if (!message) return null
  const chat = store.select().from(chats).where(eq(chats.id, message.chatId)).get()!
  const source = store.select({ id: connections.id, displayName: connections.displayName, channel: connections.channel }).from(connections).where(eq(connections.id, chat.connectionId)).get()!
  const candidates = store.select().from(messageDisputes).where(eq(messageDisputes.messageId, messageId)).orderBy(messageDisputes.id).all()
  return { message, chat, source, candidates: candidates.map(c => ({ ...c, actor: keyActor(c.incomingKeyId, store).label })), token: candidateToken(message, candidates),
    storedActor: message.contentActor === 'owner' ? 'Owner' : message.contentActor === 'channel' ? 'Paired account' : message.contentKeyId ? keyActor(message.contentKeyId, store).label : 'Unknown (before History)',
  }
}
export function resolveDispute(input: { messageId: string; token: string; action: 'keep' | 'accept' | 'delete'; candidateId?: string }, actor: HistoryActor) {
  return db.transaction(tx => {
    const current = getDispute(input.messageId, tx)
    if (!current || current.token !== input.token) return { ok: false as const, reason: 'stale' }
    const selected = current.candidates.find(c => c.id === input.candidateId)
    if (input.action === 'accept' && !selected) return { ok: false as const, reason: 'candidate_missing' }
    const changes: Partial<typeof messages.$inferInsert> = { conflictedAt: null, revision: current.message.revision + 1 }
    if (input.action === 'accept') Object.assign(changes, { text: selected!.incomingText, editedAt: new Date(Math.max(Date.now(), current.message.editedAt?.getTime() ?? 0)), contentKeyId: selected!.incomingKeyId, contentActor: 'key' })
    if (input.action === 'delete') Object.assign(changes, { deletedAt: new Date() })
    tx.update(messages).set(changes).where(eq(messages.id, input.messageId)).run()
    clearDisputes([input.messageId], tx)
    recordEvent({ kind: 'resolution', operation: input.action === 'delete' ? 'delete_message' : input.action, actor, sourceIds: [current.source.id], counts: { candidates: current.candidates.length, ...(input.action === 'delete' ? { deleted: 1 } : {}) } }, tx)
    return { ok: true as const, chatId: current.chat.id }
  }, { behavior: 'immediate' })
}

export function revokedPushKeys() {
  return db.select({ id: accessKeys.id, label: accessKeys.label, revokedAt: accessKeys.revokedAt,
    messageCount: sql<number>`(select count(*) from messages m where m.push_key_id = ${accessKeys.id} and m.deleted_at is null)`,
    candidateCount: sql<number>`(select count(*) from message_disputes d where d.incoming_key_id = ${accessKeys.id})`,
  }).from(accessKeys).where(and(eq(accessKeys.canPush, true), isNotNull(accessKeys.revokedAt))).orderBy(desc(accessKeys.revokedAt)).all()
}
export function purgePreview(keyId: string, store: Store = db) {
  const key = store.select({ id: accessKeys.id, label: accessKeys.label, revokedAt: accessKeys.revokedAt, canPush: accessKeys.canPush }).from(accessKeys).where(eq(accessKeys.id, keyId)).get()
  if (!key?.revokedAt || !key.canPush) return null
  const rows = store.select({ id: messages.id, revision: messages.revision, sourceId: chats.connectionId }).from(messages).innerJoin(chats, eq(chats.id, messages.chatId)).where(and(eq(messages.pushKeyId, keyId), isNull(messages.deletedAt))).orderBy(messages.id).all()
  const candidates = store.select({ id: messageDisputes.id, messageId: messageDisputes.messageId, revision: messageDisputes.revision, sourceId: chats.connectionId }).from(messageDisputes).innerJoin(messages, eq(messages.id, messageDisputes.messageId)).innerJoin(chats, eq(chats.id, messages.chatId)).where(sql`${messageDisputes.incomingKeyId} = ${keyId} or exists(select 1 from messages m where m.id = ${messageDisputes.messageId} and m.push_key_id = ${keyId})`).orderBy(messageDisputes.id).all()
  const sources = [...new Set([...rows.map(r => r.sourceId), ...candidates.map(c => c.sourceId)])].map(id => {
    const source = store.select({ id: connections.id, displayName: connections.displayName, channel: connections.channel }).from(connections).where(eq(connections.id, id)).get()!
    const remaining = store.select({ n: sql<number>`count(*)` }).from(messages).innerJoin(chats, eq(chats.id, messages.chatId)).where(and(eq(chats.connectionId, id), isNull(messages.deletedAt), sql`(${messages.pushKeyId} is null or ${messages.pushKeyId} != ${keyId})`)).get()!.n
    return { id, label: safeHistoryLabel(source.displayName, source.channel), remove: rows.filter(r => r.sourceId === id).length, keep: remaining }
  })
  return { key, rows, candidates, sources, token: createHash('sha256').update(JSON.stringify([rows, candidates])).digest('hex') }
}

export function purgeRevokedKey(keyId: string, actor: HistoryActor, expectedToken?: string) {
  return db.transaction(tx => {
    const preview = purgePreview(keyId, tx)
    if (!preview) return { ok: false as const, reason: 'not_found', messagesDeleted: 0, sourcesDeleted: 0 }
    if (expectedToken && preview.token !== expectedToken) return { ok: false as const, reason: 'stale', messagesDeleted: 0, sourcesDeleted: 0 }
    const incomingTargets = tx.selectDistinct({ id: messageDisputes.messageId }).from(messageDisputes).where(eq(messageDisputes.incomingKeyId, keyId)).all()
    tx.delete(messageDisputes).where(eq(messageDisputes.incomingKeyId, keyId)).run()
    for (const m of incomingTargets) {
      const remaining = tx.select({ id: messageDisputes.id }).from(messageDisputes).where(eq(messageDisputes.messageId, m.id)).limit(1).get()
      if (!remaining) tx.update(messages).set({ conflictedAt: null, revision: sql`${messages.revision} + 1` }).where(eq(messages.id, m.id)).run()
    }
    // Original delivering key determines message removal. Existing tombstones
    // and their sources must survive, exactly as in merged PR #7.
    const removed = tx.delete(messages).where(and(eq(messages.pushKeyId, keyId), isNull(messages.deletedAt))).returning({ id: messages.id }).all()
    const eventId = removed.length || preview.candidates.length ? recordEvent({ kind: 'purge', operation: 'purge', actor, subjectKeyId: keyId, sourceIds: preview.sources.map(s => s.id), counts: { deleted: removed.length, candidates: preview.candidates.length, sources: preview.sources.length } }, tx) : null
    let sourcesDeleted = 0
    for (const source of preview.sources) {
      const n = tx.select({ n: sql<number>`count(*)` }).from(messages).innerJoin(chats, eq(chats.id, messages.chatId)).where(eq(chats.connectionId, source.id)).get()!.n
      if (n === 0) {
        recordEvent({ kind: 'connection', operation: 'source_deleted', actor, sourceIds: [source.id] }, tx)
        tx.delete(connections).where(and(eq(connections.id, source.id), eq(connections.mode, 'push'))).run()
        sourcesDeleted++
      }
    }
    return { ok: true as const, messagesDeleted: removed.length, sourcesDeleted, eventId }
  }, { behavior: 'immediate' })
}


export function pendingBudget(store: Store) {
  return store.select({ n: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(length(cast(incoming_text as blob))), 0)` }).from(messageDisputes).get()!
}
