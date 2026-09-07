import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { chats, connections, messages } from '@/lib/db/schema'
import { FORMAT, type Batch } from '@/lib/services/import'
import { pushersForMessages, type ChatKind } from '@/lib/services/queries'

// Provenance is a debugging concern, not a reading one (see the plan doc):
// the transcript drops the per-message `pushedBy`, and this is where the
// whole truth goes instead — one file, downloaded on demand, never rendered.
//
// The batch shape is reused field for field from lib/services/import.ts, so
// stripping `provenance` off every entry and posting `messages`/`deletes`
// straight to the push door re-imports this chat unchanged.
export type BatchMessage = Batch['messages'][number]

export type ChatExport = {
  format: typeof FORMAT
  exportedAt: string
  source: { type: string; id: string | null; label: string | null; mode: 'live' | 'push' }
  chat: { id: string; title: string | null; kind: ChatKind; messageCount: number }
  messages: Array<BatchMessage & {
    provenance: { pushedBy: string | null; conflictedAt: string | null; editedAt: string | null }
  }>
  // Deleted stays deleted: a tombstoned row contributes only its two ids
  // here, in the batch's own delete shape, and nothing else about it —
  // never its text, never why it was removed.
  deletes: Array<{ externalChatId: string; externalMessageId: string }>
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null)

export async function exportChat(chatId: string): Promise<ChatExport | null> {
  const [chatRow] = await db.select({
    id: chats.id, connectionId: chats.connectionId, channel: chats.channel,
    kind: chats.kind, title: chats.title, externalChatId: chats.externalChatId,
  }).from(chats).where(eq(chats.id, chatId))
  if (!chatRow) return null

  const [source] = await db.select({
    mode: connections.mode, externalAccountId: connections.externalAccountId, label: connections.displayName,
  }).from(connections).where(eq(connections.id, chatRow.connectionId))

  // Every live row's own columns, oldest first: the batch fields the push
  // door already validates, plus the two facts (conflictedAt, editedAt) a
  // debugging read needs and provenance carries. No LIMIT — this is the
  // whole chat, not one page of it.
  const rows = await db.select({
    id: messages.id,
    externalMessageId: messages.externalMessageId,
    senderExternalId: messages.senderExternalId,
    senderName: messages.senderName,
    fromOwner: messages.fromOwner,
    sentAt: messages.sentAt,
    type: messages.type,
    text: messages.text,
    replyToExternalId: messages.replyToExternalId,
    editedAt: messages.editedAt,
    conflictedAt: messages.conflictedAt,
    raw: messages.raw,
  }).from(messages)
    .where(and(eq(messages.chatId, chatId), isNull(messages.deletedAt)))
    .orderBy(asc(messages.sentAt), asc(messages.id))

  // The delivering key's label, resolved the same way the transcript and the
  // MCP tools already do — never a key value, hash or prefix, only what the
  // owner called it.
  const pushedById = await pushersForMessages(rows.map(r => r.id))

  const exportedMessages = rows.map(r => ({
    externalChatId: chatRow.externalChatId,
    chatKind: chatRow.kind,
    chatTitle: chatRow.title,
    externalMessageId: r.externalMessageId,
    senderExternalId: r.senderExternalId,
    senderName: r.senderName,
    fromOwner: r.fromOwner,
    sentAt: r.sentAt.toISOString(),
    type: r.type,
    text: r.text,
    replyToExternalId: r.replyToExternalId,
    editedAt: iso(r.editedAt),
    // Ingest always stores a plain object here (the channel's own payload, or
    // toIncoming's fallback) — never a key or anything push-door-secret.
    raw: r.raw as Record<string, unknown>,
    provenance: {
      pushedBy: pushedById.get(r.id) ?? null,
      conflictedAt: iso(r.conflictedAt),
      editedAt: iso(r.editedAt),
    },
  }))

  // Tombstoned rows contribute their two ids and nothing more — never
  // selected alongside text, so there is no text in memory to leak even by
  // accident.
  const deletedRows = await db.select({ externalMessageId: messages.externalMessageId })
    .from(messages)
    .where(and(eq(messages.chatId, chatId), isNotNull(messages.deletedAt)))

  const [{ messageCount }] = await db.select({ messageCount: sql<number>`count(*)` })
    .from(messages)
    .where(and(eq(messages.chatId, chatId), isNull(messages.deletedAt)))

  return {
    format: FORMAT,
    exportedAt: new Date().toISOString(),
    source: {
      type: chatRow.channel,
      // Never a channel account identifier: a live connection's
      // externalAccountId is the paired phone number or Telegram id once
      // login completes, and no agent surface returns that (see
      // agentConnections). A pushed source's externalAccountId is only the
      // slug the pusher itself chose to name the source, which is never a
      // secret — the whole point of exposing it here is to let a reader
      // repush into the same source.
      id: source?.mode === 'push' ? (source.externalAccountId ?? null) : null,
      label: source?.label ?? null,
      mode: source?.mode ?? 'live',
    },
    chat: { id: chatRow.id, title: chatRow.title, kind: chatRow.kind, messageCount },
    messages: exportedMessages,
    deletes: deletedRows.map(d => ({ externalChatId: chatRow.externalChatId, externalMessageId: d.externalMessageId })),
  }
}
