import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { clearDisputes } from './disputes'
import { recordLiveChanges, type Store } from './history'
import { chats, messages } from '@/lib/db/schema'

// Pure-database ingest. NO channel library code lives here — every port hands
// over already-normalised DTOs, which is what makes the whole write path
// testable with no network. Message identity is
// (chat_id, external_message_id), first-writer-wins.

// Who performed an edit or a delete, for channels whose server does not
// check that itself. WhatsApp's payload is end-to-end encrypted, so WhatsApp
// cannot, and Baileys forwards a revoke or an edit from anyone in the chat;
// official clients apply one only from the message's own author. When a port
// supplies an actor, ingest touches a row only if that actor wrote it: the
// owner's rows for an owner actor, a contact's rows for that same contact. A
// non-owner actor with no id can match nothing. Telegram's server authorises
// deletes before pushing them, so its port supplies none and is applied as
// received.
export type MessageActor = { fromOwner: boolean; senderExternalId: string | null }

export type DeleteRef = { externalChatId?: string; externalMessageId: string; actor?: MessageActor }

export type IncomingMessage = {
  externalChatId: string
  chatKind: 'dm' | 'group' | 'channel'
  chatTitle: string | null
  externalMessageId: string
  senderExternalId: string | null
  senderName: string | null
  fromOwner: boolean
  sentAt: Date
  type: 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'reaction' | 'poll' | 'location' | 'contact' | 'system' | 'unknown'
  text: string | null
  // Set when the message carries a downloadable attachment. M1 stores it on
  // the message row (has_media); M4 enqueues a media row from it.
  media: { mimeType: string | null; sizeBytes: number | null; isVoiceNote: boolean | null; durationSeconds: number | null } | null
  // The channel's id of the message this one replies to, when it is one.
  replyToExternalId?: string | null
  raw: unknown
  // Only on an edit, and only from a port that has to prove authorship.
  actor?: MessageActor
}

function authoredBy(actor: MessageActor | undefined) {
  if (!actor) return sql`1`
  if (actor.fromOwner) return eq(messages.fromOwner, true)
  if (!actor.senderExternalId) return sql`0`
  return and(eq(messages.fromOwner, false), eq(messages.senderExternalId, actor.senderExternalId))
}

// Telegram's DMs and basic groups share one "common" id space; channels and
// supergroups use a separate marked-id space that starts below this bound. A
// delete update with no chat id is Telegram's own signal that it belongs to
// the common space, so the fallback may only search there.
const MIN_COMMON_CHAT_ID = -999999999999

// last_message_at moves forward only, so out-of-order backfill cannot rewind
// it. SQLite's two-argument max() returns NULL if either side is NULL, hence
// the coalesce on the existing value.
// channel is a source type (lib/services/sources.ts): a live port's channel, or the slug a pushed source chose.
function upsertChat(connectionId: string, channel: string, m: IncomingMessage, store: Store): string {
  const row = store.insert(chats).values({
    connectionId, channel, externalChatId: m.externalChatId,
    kind: m.chatKind, title: m.chatTitle, lastMessageAt: m.sentAt,
  }).onConflictDoUpdate({
    target: [chats.connectionId, chats.externalChatId],
    set: {
      // A later message can carry a null title (some update shapes omit it);
      // coalesce so it never blanks a title we already knew.
      title: sql`coalesce(excluded.title, ${chats.title})`,
      lastMessageAt: sql`max(coalesce(${chats.lastMessageAt}, 0), excluded.last_message_at)`,
    },
  }).returning({ id: chats.id }).get()
  return row.id
}

// existingText and existingDeleted are populated only when inserted is false
// — the stored text and tombstone state of the row already at (chatId,
// externalMessageId) — so a caller that needs to tell a same-text replay
// from a disagreement, or a resend of something already deleted, from either
// (import's conflict count) has it without a second table reach of its own;
// recordMessage already selects the row to report messageId here.
export function recordMessageSync(connectionId: string, channel: string, m: IncomingMessage, opts: { pushKeyId?: string; editedAt?: Date | null } = {}, store: Store = db): { chatId: string; messageId: string; inserted: boolean; existingText: string | null; existingDeleted: boolean } {
  const chatId = upsertChat(connectionId, channel, m, store)
  const inserted = store.insert(messages).values({
    chatId, externalMessageId: m.externalMessageId,
    senderExternalId: m.senderExternalId, senderName: m.senderName, fromOwner: m.fromOwner,
    sentAt: m.sentAt, type: m.type, text: m.text, hasMedia: m.media !== null,
    replyToExternalId: m.replyToExternalId ?? null, pushKeyId: opts.pushKeyId ?? null, raw: m.raw,
    editedAt: opts.editedAt ?? null, contentKeyId: opts.pushKeyId ?? null, contentActor: opts.pushKeyId ? 'key' : 'channel',
  }).onConflictDoNothing({ target: [messages.chatId, messages.externalMessageId] })
    .returning({ id: messages.id }).all()
  if (inserted.length > 0) return { chatId, messageId: inserted[0].id, inserted: true, existingText: null, existingDeleted: false }
  const existing = store.select({ id: messages.id, text: messages.text, deletedAt: messages.deletedAt }).from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.externalMessageId, m.externalMessageId))).get()!
  return { chatId, messageId: existing.id, inserted: false, existingText: existing.text, existingDeleted: existing.deletedAt !== null }
}

// Marks the row a push disagreed with, by the id recordMessage already
// returned for it. importBatch is the only caller, and it only reaches this
// after checking existingDeleted itself and finding the row live — a
// tombstoned row is never passed here, so deleted stays deleted.
export async function markConflict(messageId: string): Promise<void> {
  await db.update(messages).set({ conflictedAt: new Date() }).where(eq(messages.id, messageId))
}

// Push batches can arrive out of order or be retried after a newer edit.
// Compare and write in one statement so concurrent imports also keep the
// newest source timestamp. Equal versions and tombstones are unchanged.
export function applyPushedEditSync(messageId: string, text: string | null, editedAt: Date, keyId: string | null, store: Store = db): boolean {
  const updated = store.update(messages)
    .set({ text, editedAt, conflictedAt: null, revision: sql`${messages.revision} + 1`, contentKeyId: keyId, contentActor: keyId ? 'key' : null })
    .where(and(eq(messages.id, messageId), isNull(messages.deletedAt), or(isNull(messages.editedAt), lt(messages.editedAt, editedAt))))
    .returning({ id: messages.id }).all()
  clearDisputes(updated.map(r => r.id), store)
  return updated.length > 0
}

export async function applyPushedEdit(messageId: string, text: string | null, editedAt: Date): Promise<boolean> {
  return db.transaction(tx => applyPushedEditSync(messageId, text, editedAt, null, tx))
}

function applyEditSync(connectionId: string, channel: string, m: IncomingMessage, store: Store): void {
  const chatId = upsertChat(connectionId, channel, m, store)
  // An edit is the owner's own account of what changed, so it settles any
  // outstanding disagreement in the same statement that applies it: an
  // earlier conflict is moot the moment there is a new, authored answer.
  const updated = store.update(messages)
    .set({ text: m.text, editedAt: new Date(), conflictedAt: null, revision: sql`${messages.revision} + 1`, contentActor: 'channel', contentKeyId: null })
    .where(and(eq(messages.chatId, chatId), eq(messages.externalMessageId, m.externalMessageId), isNull(messages.deletedAt), authoredBy(m.actor)))
    .returning({ id: messages.id }).all()
  if (updated.length > 0) { clearDisputes(updated.map(r => r.id), store); recordLiveChanges(connectionId, { edited: updated.length }, store); return }
  // An edit whose author could not be matched is dropped, never inserted:
  // whatever it carries is not something the archive can vouch for.
  if (m.actor) return

  // No row to edit. What to do about that is a per-channel judgement, because
  // the two channels put different things in an edit DTO.
  //
  // Telegram's edit update is the whole message — sender, timestamp, media and
  // all — so storing it beats dropping it, and the next backfill would have
  // added the same row anyway.
  //
  // WhatsApp's is not: the port has only the protocol envelope, so the DTO
  // carries no sender, the EDIT's timestamp, media: null, and a `raw` that is a
  // protocolMessage. Inserted under the original's id it would win
  // first-writer-wins — and then silently DROP the real message when the
  // history sync delivers it minutes later, leaving an unusable row in its
  // place. History streams for minutes while live edits arrive in parallel, so
  // this is an ordinary race on WhatsApp, not a corner. Drop the edit: the
  // message itself is still coming, and an edit whose text is already in the
  // pushed history changes nothing.
  if (channel === 'whatsapp') return
  const result = recordMessageSync(connectionId, channel, m, {}, store)
  if (result.inserted) recordLiveChanges(connectionId, { inserted: 1 }, store)
}

// Returns the number of rows actually tombstoned, so a caller (importBatch)
// can tell a real delete from a no-op on an unknown chat or a message never
// recorded. The session manager, ingest's other caller, ignores it.
export function applyDeleteSync(connectionId: string, ref: DeleteRef, store: Store = db): number {
  const scope = store.select({ id: chats.id, externalChatId: chats.externalChatId })
    .from(chats).where(eq(chats.connectionId, connectionId)).all()

  const targets = ref.externalChatId
    ? scope.filter(c => c.externalChatId === ref.externalChatId)
    // No chat id: search the common id space only. Matching across both spaces
    // would tombstone same-numbered messages in every channel and supergroup
    // the user follows. The numeric guard keeps a non-numeric id (WhatsApp
    // JIDs, M2) out of the comparison entirely rather than coercing it.
    : scope.filter(c => /^-?\d+$/.test(c.externalChatId) && Number(c.externalChatId) >= MIN_COMMON_CHAT_ID)
  if (targets.length === 0) return 0

  const deletedAt = new Date()
  let count = 0
  for (const chat of targets) {
    const updated = store.update(messages).set({ deletedAt, conflictedAt: null, revision: sql`${messages.revision} + 1` })
      .where(and(eq(messages.chatId, chat.id), eq(messages.externalMessageId, ref.externalMessageId), isNull(messages.deletedAt), authoredBy(ref.actor)))
      .returning({ id: messages.id }).all()
    clearDisputes(updated.map(r => r.id), store)
    count += updated.length
  }
  return count
}


export async function recordMessage(connectionId: string, channel: string, m: IncomingMessage, opts: { pushKeyId?: string; editedAt?: Date | null; backfill?: boolean } = {}) {
  return db.transaction(tx => {
    const result = recordMessageSync(connectionId, channel, m, opts, tx)
    if (result.inserted && !opts.pushKeyId && !opts.backfill) recordLiveChanges(connectionId, { inserted: 1 }, tx)
    return result
  })
}
export async function applyEdit(connectionId: string, channel: string, m: IncomingMessage): Promise<void> {
  db.transaction(tx => applyEditSync(connectionId, channel, m, tx))
}
export async function applyDelete(connectionId: string, ref: DeleteRef): Promise<number> {
  return db.transaction(tx => {
    const count = applyDeleteSync(connectionId, ref, tx)
    if (count) recordLiveChanges(connectionId, { deleted: count }, tx)
    return count
  })
}

export function markChatPushes(sourceId: string, keyId: string, touched: Set<string>, deleteChatIds: string[], now: Date, store: Store) {
  for (const externalId of deleteChatIds) {
    const chat = store.select({ id: chats.id }).from(chats).where(and(eq(chats.connectionId, sourceId), eq(chats.externalChatId, externalId))).get()
    if (chat) touched.add(chat.id)
  }
  for (const id of touched) store.update(chats).set({ lastPushAt: now, lastPushKeyId: keyId }).where(eq(chats.id, id)).run()
}
