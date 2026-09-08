import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { chats, connections, messages } from '@/lib/db/schema'
import { encryptSecret, decryptSecret } from './crypto'
import { recordMessageSync, applyDeleteSync, type IncomingMessage } from './ingest'
import { clearDisputes } from './disputes'
import { recordLiveChanges } from './history'
import { stateSchema, type SteleState, type SteleChange } from '@/lib/channels/stele-wire'

export function steleState(connectionId: string): SteleState {
  const row = db.select().from(connections).where(eq(connections.id, connectionId)).get()
  if (!row || row.channel !== 'wechat' || row.mode !== 'live' || row.status !== 'active' || row.revokedAt || !row.sessionCiphertext) throw new Error('Stele connection is not active.')
  return stateSchema.parse(JSON.parse(decryptSecret(row.sessionCiphertext) ?? 'null'))
}
function incoming(change: Extract<SteleChange, { type: 'upsert' }>): IncomingMessage {
  const m = change.message
  return { externalChatId: change.chat.id, chatKind: change.chat.kind, chatTitle: change.chat.title,
    externalMessageId: m.id, senderExternalId: m.sender.externalId, senderName: m.sender.displayName,
    fromOwner: m.sender.isSelf, sentAt: new Date(m.sentAt), type: 'text', text: m.text,
    media: null, replyToExternalId: null, raw: { steleRevision: m.revision } }
}
/** Record changes and the resume cursor together. Tombstones survive baseline replacement. */
export function commitSteleChanges(connectionId: string, expected: SteleState, changes: SteleChange[], cursor: string | null, baseline = false, checkpoint = true): void {
  db.transaction(tx => {
    const row = tx.select().from(connections).where(and(eq(connections.id, connectionId), eq(connections.status, 'active'), isNull(connections.revokedAt))).get()
    if (!row?.sessionCiphertext || row.channel !== 'wechat' || row.mode !== 'live') throw new Error('Stele connection is not active.')
    const current = stateSchema.parse(JSON.parse(decryptSecret(row.sessionCiphertext) ?? 'null'))
    if (current.sourceId !== expected.sourceId || current.accountId !== expected.accountId || current.cursor !== expected.cursor) throw new Error('Stele checkpoint changed.')
    let inserted = 0, edited = 0, deleted = 0
    const seen = new Set<string>()
    for (const change of changes) {
      if (change.type === 'chat') {
        tx.insert(chats).values({ connectionId, channel: 'wechat', externalChatId: change.chat.id, kind: change.chat.kind, title: change.chat.title })
          .onConflictDoUpdate({ target: [chats.connectionId, chats.externalChatId], set: { kind: change.chat.kind, title: change.chat.title } }).run()
      } else if (change.type === 'upsert') {
        const m = incoming(change)
        seen.add(JSON.stringify([m.externalChatId, m.externalMessageId]))
        const result = recordMessageSync(connectionId, 'wechat', m, {}, tx)
        if (result.inserted) inserted++
        else if (!result.existingDeleted) {
          const old = tx.select({ raw: messages.raw }).from(messages).where(eq(messages.id, result.messageId)).get()
          const previous = (old?.raw as { steleRevision?: number } | null)?.steleRevision ?? 0
          if (change.message.revision > previous) {
            tx.update(messages).set({ text: m.text, senderName: m.senderName, raw: m.raw, editedAt: new Date(), revision: change.message.revision, contentActor: 'channel', conflictedAt: null }).where(eq(messages.id, result.messageId)).run()
            clearDisputes([result.messageId], tx); edited++
          }
        }
      } else {
        // An unseen delete must also be terminal against later retries/backfill.
        recordMessageSync(connectionId, 'wechat', { externalChatId: change.chatId, chatKind: 'dm', chatTitle: null,
          externalMessageId: change.messageId, senderExternalId: null, senderName: null, fromOwner: false,
          sentAt: new Date(0), type: 'text', text: null, media: null, replyToExternalId: null, raw: {} }, {}, tx)
        deleted += applyDeleteSync(connectionId, { externalChatId: change.chatId, externalMessageId: change.messageId }, tx)
      }
    }
    if (baseline) {
      const old = tx.select({ id: messages.externalMessageId, chatId: chats.externalChatId }).from(messages).innerJoin(chats, eq(chats.id, messages.chatId))
        .where(and(eq(chats.connectionId, connectionId), isNull(messages.deletedAt))).all()
      for (const m of old) if (!seen.has(JSON.stringify([m.chatId, m.id]))) deleted += applyDeleteSync(connectionId, { externalChatId: m.chatId, externalMessageId: m.id }, tx)
    }
    if (inserted || edited || deleted) recordLiveChanges(connectionId, { inserted, edited, deleted }, tx)
    tx.update(connections).set({ sessionCiphertext: encryptSecret(JSON.stringify({ ...expected, cursor })), ...(checkpoint && cursor !== null ? { lastSyncAt: new Date() } : {}) }).where(eq(connections.id, connectionId)).run()
  })
}
