import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { chats, messages } from '@/lib/db/schema'
import type { Channel } from '@/lib/channels/port'

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
  type: 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'system' | 'unknown'
  text: string | null
  // Set when the message carries a downloadable attachment. M1 stores it on
  // the message row (has_media); M4 enqueues a media row from it.
  media: { mimeType: string | null; sizeBytes: number | null; isVoiceNote: boolean | null; durationSeconds: number | null } | null
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
async function upsertChat(connectionId: string, channel: Channel, m: IncomingMessage): Promise<string> {
  const [row] = await db.insert(chats).values({
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
  }).returning({ id: chats.id })
  return row.id
}

export async function recordMessage(connectionId: string, channel: Channel, m: IncomingMessage): Promise<{ chatId: string; messageId: string; inserted: boolean }> {
  const chatId = await upsertChat(connectionId, channel, m)
  const inserted = await db.insert(messages).values({
    chatId, externalMessageId: m.externalMessageId,
    senderExternalId: m.senderExternalId, senderName: m.senderName, fromOwner: m.fromOwner,
    sentAt: m.sentAt, type: m.type, text: m.text, hasMedia: m.media !== null, raw: m.raw,
  }).onConflictDoNothing({ target: [messages.chatId, messages.externalMessageId] })
    .returning({ id: messages.id })
  if (inserted.length > 0) return { chatId, messageId: inserted[0].id, inserted: true }
  const [existing] = await db.select({ id: messages.id }).from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.externalMessageId, m.externalMessageId)))
  return { chatId, messageId: existing.id, inserted: false }
}

export async function applyEdit(connectionId: string, channel: Channel, m: IncomingMessage): Promise<void> {
  const chatId = await upsertChat(connectionId, channel, m)
  const updated = await db.update(messages)
    .set({ text: m.text, editedAt: new Date() })
    .where(and(eq(messages.chatId, chatId), eq(messages.externalMessageId, m.externalMessageId), authoredBy(m.actor)))
    .returning({ id: messages.id })
  if (updated.length > 0) return
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
  await recordMessage(connectionId, channel, m)
}

export async function applyDelete(connectionId: string, ref: DeleteRef): Promise<void> {
  const scope = await db.select({ id: chats.id, externalChatId: chats.externalChatId })
    .from(chats).where(eq(chats.connectionId, connectionId))

  const targets = ref.externalChatId
    ? scope.filter(c => c.externalChatId === ref.externalChatId)
    // No chat id: search the common id space only. Matching across both spaces
    // would tombstone same-numbered messages in every channel and supergroup
    // the user follows. The numeric guard keeps a non-numeric id (WhatsApp
    // JIDs, M2) out of the comparison entirely rather than coercing it.
    : scope.filter(c => /^-?\d+$/.test(c.externalChatId) && Number(c.externalChatId) >= MIN_COMMON_CHAT_ID)
  if (targets.length === 0) return

  const deletedAt = new Date()
  for (const chat of targets) {
    await db.update(messages).set({ deletedAt })
      .where(and(eq(messages.chatId, chat.id), eq(messages.externalMessageId, ref.externalMessageId), authoredBy(ref.actor)))
  }
}
