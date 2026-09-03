import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { chats, media, mediaAnalysis, messages } from '@/lib/db/schema'
import { searchIndex } from '@/lib/db/fts'
import type { Channel } from '@/lib/channels/port'
import type { IncomingMessage } from '@/lib/services/ingest'

// Every read path here excludes tombstoned rows and no view type has a
// deletedAt field, so a deleted message cannot reach a page, an API response,
// or an agent even by accident (spec invariant 4).

export type ChatSummary = {
  id: string; channel: Channel; kind: 'dm' | 'group' | 'channel'
  title: string | null; lastMessageAt: Date | null; messageCount: number
}

export type MessageView = {
  id: string; externalMessageId: string; senderName: string | null; fromOwner: boolean; sentAt: Date
  type: IncomingMessage['type']; text: string | null; editedAt: Date | null
  media: { id: string; url: string; mimeType: string | null; extractedText: string | null } | null
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const DEFAULT_SEARCH_LIMIT = 50

// A raw sql`...` template does not table-qualify interpolated columns on its
// own (confirmed against drizzle-orm 0.45.2: `${messages.chatId} = ${chats.id}`
// renders as the unqualified `"chat_id" = "id"`, which SQLite resolves to
// messages.chat_id = messages.id and silently miscounts). Building the
// correlated subquery through the query builder instead keeps both sides
// correctly qualified as messages.chat_id = chats.id.
const liveMessageCount = sql<number>`(${db.select({ count: sql<number>`count(*)` }).from(messages)
  .where(and(eq(messages.chatId, chats.id), isNull(messages.deletedAt)))})`

const chatSelection = {
  id: chats.id, channel: chats.channel, kind: chats.kind,
  title: chats.title, lastMessageAt: chats.lastMessageAt, messageCount: liveMessageCount,
}

const messageSelection = {
  id: messages.id, externalMessageId: messages.externalMessageId,
  senderName: messages.senderName, fromOwner: messages.fromOwner, sentAt: messages.sentAt,
  type: messages.type, text: messages.text, editedAt: messages.editedAt,
}

// Exactly what messageSelection returns: MessageView minus the field the
// database cannot answer yet.
type MessageRow = Omit<MessageView, 'media'>

// M4 fills the second argument from mediaForMessages; it stays defaulted so
// any caller that has no media map still gets a well-formed MessageView.
const toView = (row: MessageRow, media: MessageView['media'] = null): MessageView => ({ ...row, media })

// base64url of `${sentAt}:${id}` — opaque to the caller, and a URL cursor
// never leaks a timestamp or an id into a log or a Referer in readable form.
function encodeCursor(m: { sentAt: Date; id: string }): string {
  return Buffer.from(`${m.sentAt.getTime()}:${m.id}`, 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): { sentAt: Date; id: string } | null {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8')
  const sep = raw.indexOf(':')
  if (sep <= 0) return null
  const ms = Number(raw.slice(0, sep))
  const id = raw.slice(sep + 1)
  if (!Number.isFinite(ms) || id.length === 0) return null
  return { sentAt: new Date(ms), id }
}

export async function listChats(): Promise<ChatSummary[]> {
  return db.select(chatSelection).from(chats)
    // A chat with no messages yet still belongs in the list; sort it by when
    // we learned about it rather than dropping it to the bottom forever.
    .orderBy(desc(sql`coalesce(${chats.lastMessageAt}, ${chats.createdAt})`), desc(chats.id))
}

async function chatSummary(chatId: string): Promise<ChatSummary | null> {
  const [row] = await db.select(chatSelection).from(chats).where(eq(chats.id, chatId))
  return row ?? null
}

export async function getMessages(chatId: string, opts: {
  cursor?: string; limit?: number; before?: Date; after?: Date
} = {}): Promise<{ chat: ChatSummary; messages: MessageView[]; nextCursor: string | null } | null> {
  const chat = await chatSummary(chatId)
  if (!chat) return null
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT))

  const conds = [eq(messages.chatId, chatId), isNull(messages.deletedAt)]
  if (opts.before) conds.push(lt(messages.sentAt, opts.before))
  if (opts.after) conds.push(gt(messages.sentAt, opts.after))
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null
  // A malformed cursor reads as "start at the beginning", not as an error: it
  // comes from a URL a person can edit, and an empty page would look like an
  // empty chat.
  if (cursor) {
    conds.push(or(
      lt(messages.sentAt, cursor.sentAt),
      and(eq(messages.sentAt, cursor.sentAt), lt(messages.id, cursor.id)),
    )!)
  }

  const rows = await db.select(messageSelection).from(messages)
    .where(and(...conds))
    .orderBy(desc(messages.sentAt), desc(messages.id))
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const nextCursor = rows.length > limit && page.length > 0 ? encodeCursor(page[page.length - 1]) : null
  const mediaById = await mediaForMessages(page.map(r => r.id))
  return { chat, messages: page.map(r => toView(r, mediaById.get(r.id) ?? null)), nextCursor }
}

// FTS5 treats bare words as syntax (AND, OR, NOT, NEAR, *, ^, :, quotes), so a
// person's search box would otherwise either behave surprisingly or throw a
// syntax error at them. Quoting each token as a phrase makes every token
// literal, and the implicit AND between phrases is the "all of these words"
// behaviour a search box is expected to have.
function toMatchExpression(query: string): string | null {
  const tokens = query.split(/\s+/).map(t => t.replace(/"/g, '')).filter(Boolean)
  if (tokens.length === 0) return null
  return tokens.map(t => `"${t}"`).join(' ')
}

export async function searchMessages(query: string, chatId?: string, limit = DEFAULT_SEARCH_LIMIT): Promise<Array<MessageView & { chatId: string; chatTitle: string | null }>> {
  const match = toMatchExpression(query)
  if (!match) return []

  const conds = [sql`search_index MATCH ${match}`, isNull(messages.deletedAt)]
  if (chatId) conds.push(eq(messages.chatId, chatId))

  // bm25() only evaluates inside the query that holds the MATCH constraint on
  // the fts5 table itself — SQLite raises "unable to use function bm25 in the
  // requested context" the moment it is wrapped in an outer GROUP BY, or sits
  // in a subquery the planner is free to flatten into one. A LIMIT on the
  // inner query is a standard SQLite flattening barrier (drizzle drops a
  // negative limit rather than emitting `LIMIT -1`, so this uses a limit far
  // above any real result set instead), so bm25() is computed once per
  // search_index row here...
  const ranked = db.select({
    ...messageSelection,
    chatId: messages.chatId,
    chatTitle: chats.title,
    rank: sql<number>`bm25(search_index)`.as('rank'),
  }).from(searchIndex)
    .innerJoin(messages, eq(messages.id, searchIndex.messageId))
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .where(and(...conds))
    .orderBy(sql`rank`)
    .limit(1_000_000)
    .as('ranked')

  // ...and collapsed here, one level up: a message can own several index rows
  // from M4 onwards (its own text plus each attachment's extracted text), so
  // group to one hit per message and rank it by its best-matching row. bm25
  // is more negative the better the match, hence ascending.
  const rows = await db.select({
    id: ranked.id, externalMessageId: ranked.externalMessageId, senderName: ranked.senderName,
    fromOwner: ranked.fromOwner, sentAt: ranked.sentAt, type: ranked.type, text: ranked.text,
    editedAt: ranked.editedAt, chatId: ranked.chatId, chatTitle: ranked.chatTitle,
  }).from(ranked)
    .groupBy(ranked.id)
    .orderBy(asc(sql`min(${ranked.rank})`))
    .limit(Math.max(1, Math.min(limit, MAX_LIMIT)))

  const mediaById = await mediaForMessages(rows.map(r => r.id))
  return rows.map(r => ({ ...toView(r, mediaById.get(r.id) ?? null), chatId: r.chatId, chatTitle: r.chatTitle }))
}

// One query for a whole page's attachments, so a 100-message transcript costs
// two round trips rather than 101. Only `done` rows are returned — the same
// condition /media/[id] serves under, so the transcript never renders a link
// to bytes that are not there.
export async function mediaForMessages(
  messageIds: string[],
): Promise<Map<string, NonNullable<MessageView['media']>>> {
  const out = new Map<string, NonNullable<MessageView['media']>>()
  if (messageIds.length === 0) return out
  const rows = await db.select({
    id: media.id,
    messageId: media.messageId,
    mimeType: media.mimeType,
    extractedText: mediaAnalysis.extractedText,
  })
    .from(media)
    .leftJoin(mediaAnalysis, eq(mediaAnalysis.mediaId, media.id))
    .where(and(inArray(media.messageId, messageIds), eq(media.status, 'done')))
  for (const r of rows) {
    out.set(r.messageId, {
      id: r.id,
      url: `/media/${r.id}`,
      mimeType: r.mimeType,
      extractedText: r.extractedText ?? null,
    })
  }
  return out
}
