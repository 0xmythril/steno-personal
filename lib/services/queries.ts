import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm'
import { QueryBuilder } from 'drizzle-orm/sqlite-core'
import { db } from '@/lib/db/client'
import {
  channelContacts, chats, media, mediaAnalysis, messages, connections, people, personIdentities,
} from '@/lib/db/schema'
import { searchIndex } from '@/lib/db/fts'
import type { Channel } from '@/lib/channels/port'
import type { IncomingMessage } from '@/lib/services/ingest'

// Every read path here excludes tombstoned rows and no view type has a
// deletedAt field, so a deleted message cannot reach a page, an API response,
// or an agent even by accident (spec invariant 4).

// The address book's answer to "who is this?", carried on every read path.
// Id and name only: `id` is this instance's own uuid, never a channel
// identifier, and never a phone number (people design decision 6).
export type PersonRef = { id: string; name: string }

export type ChatChannel = 'telegram' | 'whatsapp'
export const CHAT_CHANNELS: readonly ChatChannel[] = ['telegram', 'whatsapp']
export type ChatKind = 'dm' | 'group' | 'channel'
export const CHAT_KINDS: readonly ChatKind[] = ['dm', 'group', 'channel']

export type ChatSummary = {
  id: string; channel: Channel; kind: ChatKind
  title: string | null; lastMessageAt: Date | null; messageCount: number
  person: PersonRef | null
  // The latest live non-system message, cut to SNIPPET_CHARS: enough to tell
  // an agent what a chat is about without opening it. A textless message
  // shows as a bracketed placeholder ("[image]"); null only when the chat has
  // no live message at all.
  snippet: string | null
}

// Where an attachment's bytes are. 'ready' is the only state with a url: the
// worker has the file and /media/[id] will serve it. 'pending' means queued
// or still retrying, 'failed' means the drain gave up, and 'unavailable' is a
// message that says it carried an attachment but was never queued for one
// (archived before attachments were kept). The distinction is the whole
// point: an agent looking at `type: 'image'` must be able to tell "no
// attachment" from "not downloaded yet" from "never will be".
export type MediaStatus = 'ready' | 'pending' | 'failed' | 'unavailable'
export type MediaView = {
  id: string | null; status: MediaStatus; url: string | null
  mimeType: string | null; sizeBytes: number | null
  durationSeconds: number | null; isVoiceNote: boolean | null
  extractedText: string | null; description: string | null
}

// The message a reply quotes, when the archive has it: enough to read the
// reply in context without a second call. Null for a message that is not a
// reply, for one whose target never reached the archive, and for one whose
// target was deleted — deleted stays deleted, quoted or not.
export type ReplyRef = { id: string; senderName: string | null; text: string | null }

export type MessageView = {
  id: string; externalMessageId: string; senderName: string | null; fromOwner: boolean; sentAt: Date
  type: IncomingMessage['type']; text: string | null; editedAt: Date | null
  person: PersonRef | null
  media: MediaView | null
  replyTo: ReplyRef | null
}

// A message with its chat named on the same line, for the read paths that
// cross chats: search hits and the inbox.
export type MessageInChat = MessageView & {
  chatId: string; chatTitle: string | null; channel: Channel; kind: ChatKind
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const DEFAULT_SEARCH_LIMIT = 50
// An agent's first call must be answerable: a chat list or an inbox defaults
// to one screenful, and the cursor is there for the rest.
const DEFAULT_CHAT_LIMIT = 20
const DEFAULT_RECENT_LIMIT = 20
const SNIPPET_CHARS = 160

const clampLimit = (limit: number | undefined, fallback: number): number =>
  Math.max(1, Math.min(limit ?? fallback, MAX_LIMIT))

// A raw sql`...` template does not table-qualify interpolated columns on its
// own (confirmed against drizzle-orm 0.45.2: `${messages.chatId} = ${chats.id}`
// renders as the unqualified `"chat_id" = "id"`, which SQLite resolves to
// messages.chat_id = messages.id and silently miscounts). Building the
// correlated subquery through the query builder instead keeps both sides
// correctly qualified as messages.chat_id = chats.id.
//
// A standalone QueryBuilder, not `db.select`: this runs at module load, and
// `db` is lazy precisely so that importing the app (as `next build` does in
// parallel page-data workers) opens nothing. Touching `db` here would create
// and WAL-switch a fresh data/steno.db from several workers at once and fail
// the build with SQLITE_BUSY; tests/build-time-imports.test.ts guards this.
const liveMessageCount = sql<number>`(${new QueryBuilder().select({ count: sql<number>`count(*)` }).from(messages)
  .where(and(eq(messages.chatId, chats.id), isNull(messages.deletedAt)))})`

// Same rendering rule from the other side. When a select has one table in its
// FROM, drizzle drops the table prefix from the columns of a selection field —
// but only from that field's OUTERMOST chunks; a nested sql object keeps its
// qualified names. That is why `case when "kind" = 'dm'` below is legal, and
// why a subquery selecting from two tables that both have an `id` is only
// unambiguous one level down. Every raw subquery here is wrapped before it is
// selected, so it renders the same whether it is a field or part of one.
const nested = <T>(query: SQL<T>): SQL<T> => sql<T>`${query}`

// A direct chat is named after the person on the other side. Channels do not
// always hand us that: WhatsApp has no subject for a DM and a history sync can
// leave the title null, and a title that equals the owner's own display name
// is the wrong side of the conversation. So for a DM the title yields to the
// most recent non-owner sender name whenever it is null or the owner's, and a
// WhatsApp DM with no name at all falls back to the phone number that is its
// id — a number beats "Untitled chat". Groups and channels keep their subject.
const ownerDisplayName = sql`(select ${connections.displayName} from ${connections} where ${connections.id} = ${chats.connectionId})`
const latestCounterparty = sql`(select ${messages.senderName} from ${messages}
  where ${messages.chatId} = ${chats.id} and ${messages.fromOwner} = 0
    and ${messages.senderName} is not null and ${messages.deletedAt} is null
  order by ${messages.sentAt} desc limit 1)`
const whatsappNumber = sql`case when ${chats.channel} = 'whatsapp' and ${chats.externalChatId} like '%@s.whatsapp.net'
  then '+' || substr(${chats.externalChatId}, 1, instr(${chats.externalChatId}, '@') - 1) end`
// A DM's counterparty identity is (chats.channel, chats.external_chat_id)
// (people design decision 3), and unique(channel, external_id) on
// person_identities makes that a one-row answer. Only a DM has one: a group is
// a room, not someone, so its subject and its person are left alone even if
// its id happens to be linked.
const dmIdentity = sql`${chats.kind} = 'dm'
  and ${personIdentities.channel} = ${chats.channel}
  and ${personIdentities.externalId} = ${chats.externalChatId}`
// A hidden person is nobody on every read path (people design addendum 2,
// decision 14): the identity row stays linked — that is what stops the
// populater recreating them — but it resolves to no name and no id here, so
// the chat falls back to whatever the channel calls it. Both columns join
// `people` for that reason; neither may answer without the other.
const dmPersonId = nested(sql<string | null>`(select ${personIdentities.personId} from ${personIdentities}
  inner join ${people} on ${people.id} = ${personIdentities.personId}
  where ${dmIdentity} and ${people.archivedAt} is null)`)
const dmPersonName = nested(sql<string | null>`(select ${people.name} from ${personIdentities}
  inner join ${people} on ${people.id} = ${personIdentities.personId}
  where ${dmIdentity} and ${people.archivedAt} is null)`)

// What the owner decided to call this person outranks every name a channel
// supplied: the address book is the answer they wrote down themselves.
const displayTitle = sql<string | null>`case when ${chats.kind} = 'dm'
  then coalesce(${dmPersonName}, nullif(${chats.title}, ${ownerDisplayName}), ${latestCounterparty}, ${whatsappNumber}, ${chats.title})
  else ${chats.title} end`

// The latest live message's text, already cut to size in SQL so a chat list
// never drags a whole essay per row out of the database. A message with no
// text still says what it is — "[image]", "Reacted 👍" — because a blank
// snippet beside a busy chat read as a bug, and system rows (a join, a
// subject change) are skipped because they are not conversation.
const snippetText = sql`coalesce(substr(${messages.text}, 1, ${SNIPPET_CHARS}),
  case ${messages.type}
    when 'image' then '[image]' when 'video' then '[video]' when 'audio' then '[audio]'
    when 'document' then '[document]' when 'sticker' then '[sticker]' when 'location' then '[location]'
    when 'contact' then '[contact]' when 'poll' then '[poll]' when 'unknown' then '[unsupported message]' end)`
const latestSnippet = nested(sql<string | null>`(select case when ${messages.type} = 'reaction'
    then 'Reacted ' || coalesce(${messages.text}, '') else ${snippetText} end
  from ${messages}
  where ${messages.chatId} = ${chats.id} and ${messages.deletedAt} is null and ${messages.type} <> 'system'
  order by ${messages.sentAt} desc, ${messages.id} desc limit 1)`)

// A chat with no messages yet still belongs in the list; sort it by when we
// learned about it rather than dropping it to the bottom forever. Selected as
// well as ordered by, because the page cursor is built from it.
const activityAt = sql<number>`coalesce(${chats.lastMessageAt}, ${chats.createdAt})`

const chatSelection = {
  id: chats.id, channel: chats.channel, kind: chats.kind,
  title: displayTitle, lastMessageAt: chats.lastMessageAt, messageCount: liveMessageCount,
  personId: dmPersonId, personName: dmPersonName,
  snippet: latestSnippet, activityAt: nested(activityAt),
}

// Exactly what chatSelection returns: the person arrives as two columns and
// leaves as one nested object, so no caller has to know the join.
type ChatRow = Omit<ChatSummary, 'person'> & { personId: string | null; personName: string | null; activityAt: number }

const personRef = (id: string | null, name: string | null): PersonRef | null =>
  id !== null && name !== null ? { id, name } : null

const toSummary = ({ personId, personName, activityAt: _activity, ...row }: ChatRow): ChatSummary =>
  ({ ...row, person: personRef(personId, personName) })

// The chat a message sits in decides its channel and its connection; both are
// needed to look a sender up by (channel, external id).
const senderChannel = sql`(select ${chats.channel} from ${chats} where ${chats.id} = ${messages.chatId})`
const senderConnection = sql`(select ${chats.connectionId} from ${chats} where ${chats.id} = ${messages.chatId})`

// The owner's own contact list knows names a history sync never carried. It is
// matched on (channel, external_id), preferring the chat's own connection and
// otherwise taking any connection on that channel — reconnecting an account
// makes a new connection row, and the names the old one read are still the
// owner's contacts.
const contactName = sql`(select ${channelContacts.displayName} from ${channelContacts}
  where ${channelContacts.channel} = ${senderChannel}
    and ${channelContacts.externalId} = ${messages.senderExternalId}
    and ${channelContacts.displayName} is not null
  order by case when ${channelContacts.connectionId} = ${senderConnection} then 0 else 1 end,
    ${channelContacts.syncedAt} desc
  limit 1)`

// A message's sender identity is (the chat's channel, sender_external_id). The
// owner is never one of them: from_owner is the archive's own answer to "who
// wrote this", and it wins even if the owner's id is in the address book.
const senderIdentity = sql`${messages.fromOwner} = 0
  and ${personIdentities.channel} = ${senderChannel}
  and ${personIdentities.externalId} = ${messages.senderExternalId}`
const senderPersonId = nested(sql<string | null>`(select ${personIdentities.personId} from ${personIdentities}
  inner join ${people} on ${people.id} = ${personIdentities.personId}
  where ${senderIdentity} and ${people.archivedAt} is null)`).as('person_id')
// Unaliased, because the sender filter below uses it in a WHERE, where an
// alias would render as a column that does not exist.
const senderPersonNameSql = nested(sql<string | null>`(select ${people.name} from ${personIdentities}
  inner join ${people} on ${people.id} = ${personIdentities.personId}
  where ${senderIdentity} and ${people.archivedAt} is null)`)
const senderPersonName = senderPersonNameSql.as('person_name')

// The latest push name this sender put on ANY live message on this channel.
// A history sync carries no push name and a live message does, so without
// this the same person read as "Avir" in one chat and "+1555…" in the next,
// and an agent matching names across calls could not tell they were one.
// Table aliases are spelled out because the outer query is `messages` too.
const latestPushName = sql`(select m2.sender_name from ${messages} m2
  inner join ${chats} c2 on c2.id = m2.chat_id
  where m2.sender_external_id = ${messages.senderExternalId}
    and c2.channel = ${senderChannel}
    and m2.sender_name is not null and m2.deleted_at is null
  order by m2.sent_at desc, m2.id desc limit 1)`

// What a reader sees as the sender, in one expression so every read path and
// the sender filter agree: the name the owner wrote in the address book (the
// rule a direct chat's title already follows), then the push name this
// message carried, then the latest one the sender ever carried, then the
// owner's contact list, and for WhatsApp the number that is the id — a number
// beats "Unknown". Telegram ids are opaque, so a nameless Telegram sender
// stays null.
const senderLabelSql = sql<string | null>`coalesce(${senderPersonNameSql}, ${messages.senderName}, ${latestPushName}, ${contactName},
  case when ${senderChannel} = 'whatsapp' and ${messages.senderExternalId} like '%@s.whatsapp.net'
    then '+' || substr(${messages.senderExternalId}, 1, instr(${messages.senderExternalId}, '@') - 1) end)`
// Aliased: searchMessages selects this inside a subquery, and drizzle refuses
// an unaliased raw column there.
const senderLabel = senderLabelSql.as('sender_name')

// The quoted message, looked up by (this chat, the channel's id it carries).
// (chat_id, external_message_id) is the messages unique index, so each is one
// probe per row. Aliased `r` because the outer query is `messages` too. The
// quoted text is cut like a snippet: the reply needs its context, not the
// whole essay it answered.
const quoted = (column: SQL): SQL => sql`(select ${column} from ${messages} r
  where r.chat_id = ${messages.chatId} and r.external_message_id = ${messages.replyToExternalId}
    and r.deleted_at is null)`
const replyToId = nested(sql<string | null>`${quoted(sql`r.id`)}`).as('reply_to_id')
const replyToSender = nested(sql<string | null>`${quoted(sql`r.sender_name`)}`).as('reply_to_sender')
const replyToText = nested(sql<string | null>`${quoted(sql`substr(r.text, 1, ${SNIPPET_CHARS})`)}`).as('reply_to_text')

const messageSelection = {
  id: messages.id, externalMessageId: messages.externalMessageId,
  senderName: senderLabel, fromOwner: messages.fromOwner, sentAt: messages.sentAt,
  type: messages.type, text: messages.text, editedAt: messages.editedAt,
  personId: senderPersonId, personName: senderPersonName,
  hasMedia: messages.hasMedia,
  replyToId, replyToSender, replyToText,
}

// Exactly what messageSelection returns: MessageView minus the field the
// database cannot answer yet, with the person and the reply still in their
// columns.
type MessageRow = Omit<MessageView, 'media' | 'person' | 'replyTo'> & {
  personId: string | null; personName: string | null; hasMedia: boolean
  replyToId: string | null; replyToSender: string | null; replyToText: string | null
}

// Every message has a media row from the moment ingest sees an attachment,
// but not every archive was built that way; a message that says has_media
// with no row behind it still tells the reader an attachment existed.
const unavailableMedia = (): MediaView => ({
  id: null, status: 'unavailable', url: null, mimeType: null, sizeBytes: null,
  durationSeconds: null, isVoiceNote: null, extractedText: null, description: null,
})

const toView = ({ personId, personName, hasMedia, replyToId, replyToSender, replyToText, ...row }: MessageRow, media?: MediaView): MessageView => ({
  ...row,
  person: personRef(personId, personName),
  media: media ?? (hasMedia ? unavailableMedia() : null),
  replyTo: replyToId !== null ? { id: replyToId, senderName: replyToSender, text: replyToText } : null,
})

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

// A substring the caller typed, as a LIKE pattern that means exactly that:
// the wildcards and the escape are escaped so "100%" finds "100%", not
// everything starting with 100. SQLite's LIKE is already case-insensitive.
const LIKE_ESCAPE = '\\'
const likePattern = (q: string): string =>
  `%${q.replace(/[\\%_]/g, ch => LIKE_ESCAPE + ch)}%`
const like = (column: SQL, q: string): SQL => sql`${column} like ${likePattern(q)} escape ${LIKE_ESCAPE}`

export async function listChats(opts: { channel?: ChatChannel } = {}): Promise<ChatSummary[]> {
  const rows = await db.select(chatSelection).from(chats)
    .where(opts.channel ? eq(chats.channel, opts.channel) : undefined)
    .orderBy(desc(activityAt), desc(chats.id))
  return rows.map(toSummary)
}

export type ChatFilters = {
  channel?: ChatChannel
  kind?: ChatKind
  // Matched against the title the reader sees — the resolved one, so a DM
  // with no stored title is still found by the name of the person in it.
  q?: string
}

// The chat list an agent can aim: filtered, one screenful at a time, with the
// same cursor discipline as a transcript. listChats above stays whole for the
// portal, which renders every chat on one page.
export async function pageChats(
  opts: ChatFilters & { limit?: number; cursor?: string } = {},
): Promise<{ chats: ChatSummary[]; nextCursor: string | null }> {
  const limit = clampLimit(opts.limit, DEFAULT_CHAT_LIMIT)
  const conds: SQL[] = []
  if (opts.channel) conds.push(eq(chats.channel, opts.channel))
  if (opts.kind) conds.push(eq(chats.kind, opts.kind))
  const q = opts.q?.trim()
  if (q) conds.push(like(displayTitle, q))
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null
  if (cursor) {
    const ms = cursor.sentAt.getTime()
    conds.push(or(
      sql`${activityAt} < ${ms}`,
      and(sql`${activityAt} = ${ms}`, lt(chats.id, cursor.id)),
    )!)
  }
  const rows = await db.select(chatSelection).from(chats)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(activityAt), desc(chats.id))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  const nextCursor = rows.length > limit && last
    ? encodeCursor({ sentAt: new Date(last.activityAt), id: last.id })
    : null
  return { chats: page.map(toSummary), nextCursor }
}

async function chatSummary(chatId: string): Promise<ChatSummary | null> {
  const [row] = await db.select(chatSelection).from(chats).where(eq(chats.id, chatId))
  return row ? toSummary(row) : null
}

// The summaries for a known set of ids, most recently active first. One
// query, so a caller holding many ids (the address book, naming each
// person's chats) does not make one round trip per chat.
export async function chatSummaries(ids: string[]): Promise<ChatSummary[]> {
  if (ids.length === 0) return []
  const rows = await db.select(chatSelection).from(chats)
    .where(inArray(chats.id, ids))
    .orderBy(desc(activityAt), desc(chats.id))
  return rows.map(toSummary)
}

// Newest first, cut at `limit`, with the keyset condition a cursor implies.
// Shared by the one-chat transcript and the cross-chat inbox so they page the
// same way.
function messagePageConds(opts: { cursor?: string; before?: Date; after?: Date }): SQL[] {
  const conds: SQL[] = [isNull(messages.deletedAt)]
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
  return conds
}

export async function getMessages(chatId: string, opts: {
  cursor?: string; limit?: number; before?: Date; after?: Date
} = {}): Promise<{ chat: ChatSummary; messages: MessageView[]; nextCursor: string | null } | null> {
  const chat = await chatSummary(chatId)
  if (!chat) return null
  const limit = clampLimit(opts.limit, DEFAULT_LIMIT)

  const rows = await db.select(messageSelection).from(messages)
    .where(and(eq(messages.chatId, chatId), ...messagePageConds(opts)))
    .orderBy(desc(messages.sentAt), desc(messages.id))
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const nextCursor = rows.length > limit && page.length > 0 ? encodeCursor(page[page.length - 1]) : null
  const mediaById = await mediaForMessages(page.map(r => r.id))
  return { chat, messages: page.map(r => toView(r, mediaById.get(r.id))), nextCursor }
}

// chatTitle is the SAME expression the chat list uses, not chats.title: a
// WhatsApp DM's stored title is routinely null or the owner's own name, so
// the raw column would make a hit read as `null` in the exact chat the list
// beside it names after a person.
const chatColumns = {
  chatId: messages.chatId,
  chatTitle: displayTitle.as('chat_title'),
  channel: chats.channel,
  kind: chats.kind,
}

// The inbox: the newest messages across every chat, or one channel or kind of
// chat, each line naming the chat it came from. What a person sees when they
// open the app, and the one-hop answer to "what happened today".
export async function recentMessages(opts: {
  channel?: ChatChannel; kind?: ChatKind; limit?: number; cursor?: string; before?: Date; after?: Date
} = {}): Promise<{ messages: MessageInChat[]; nextCursor: string | null }> {
  const limit = clampLimit(opts.limit, DEFAULT_RECENT_LIMIT)
  const conds = messagePageConds(opts)
  if (opts.channel) conds.push(eq(chats.channel, opts.channel))
  if (opts.kind) conds.push(eq(chats.kind, opts.kind))

  const rows = await db.select({ ...messageSelection, ...chatColumns }).from(messages)
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .where(and(...conds))
    .orderBy(desc(messages.sentAt), desc(messages.id))
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const nextCursor = rows.length > limit && page.length > 0 ? encodeCursor(page[page.length - 1]) : null
  const mediaById = await mediaForMessages(page.map(r => r.id))
  return {
    messages: page.map(({ chatId, chatTitle, channel, kind, ...r }) =>
      ({ ...toView(r, mediaById.get(r.id)), chatId, chatTitle, channel, kind })),
    nextCursor,
  }
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

export type SearchOptions = {
  chatId?: string
  channel?: ChatChannel
  kind?: ChatKind
  // A substring of the sender exactly as the reader sees them — the same
  // expression senderName is built from.
  sender?: string
  before?: Date
  after?: Date
  limit?: number
}

export async function searchMessages(query: string, opts: SearchOptions = {}): Promise<MessageInChat[]> {
  const match = toMatchExpression(query)
  if (!match) return []

  const conds = [sql`search_index MATCH ${match}`, isNull(messages.deletedAt)]
  if (opts.chatId) conds.push(eq(messages.chatId, opts.chatId))
  if (opts.channel) conds.push(eq(chats.channel, opts.channel))
  if (opts.kind) conds.push(eq(chats.kind, opts.kind))
  if (opts.before) conds.push(lt(messages.sentAt, opts.before))
  if (opts.after) conds.push(gt(messages.sentAt, opts.after))
  // The one filter that costs a name lookup per matched row rather than per
  // page: it has to, because a page cut before the filter would be short.
  const sender = opts.sender?.trim()
  if (sender) conds.push(like(senderLabelSql, sender))

  // bm25() only evaluates inside the query that holds the MATCH constraint on
  // the fts5 table itself — SQLite raises "unable to use function bm25 in the
  // requested context" the moment it is wrapped in an outer GROUP BY, or sits
  // in a subquery the planner is free to flatten into one. A LIMIT on the
  // inner query is a standard SQLite flattening barrier (drizzle drops a
  // negative limit rather than emitting `LIMIT -1`, so this uses a limit far
  // above any real result set instead), so bm25() is computed once per
  // search_index row here — and nothing else is: ids and a score only.
  const ranked = db.select({
    messageId: searchIndex.messageId,
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
  // is more negative the better the match, hence ascending. This is where the
  // page is cut. An aggregate subquery under a join is not flattened by
  // SQLite, so the LIMIT here really does bound what the outer query touches.
  const best = db.select({
    messageId: ranked.messageId,
    rank: sql<number>`min(${ranked.rank})`.as('best_rank'),
  }).from(ranked)
    .groupBy(ranked.messageId)
    .orderBy(asc(sql`min(${ranked.rank})`))
    .limit(clampLimit(opts.limit, DEFAULT_SEARCH_LIMIT))
    .as('best')

  // Only now, on the page and nothing more, are the names resolved.
  // messageSelection carries four correlated subqueries per row (the sender's
  // person, the owner's contact name, and the two the display title needs);
  // inside `ranked` they ran once per FTS-matched row, which for a common word
  // is the whole corpus rather than the fifty rows anybody sees.
  const rows = await db.select({ ...messageSelection, ...chatColumns }).from(best)
    .innerJoin(messages, eq(messages.id, best.messageId))
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .orderBy(asc(best.rank))

  const mediaById = await mediaForMessages(rows.map(r => r.id))
  return rows.map(({ chatId, chatTitle, channel, kind, ...r }) =>
    ({ ...toView(r, mediaById.get(r.id)), chatId, chatTitle, channel, kind }))
}

const mediaColumns = {
  id: media.id,
  messageId: media.messageId,
  status: media.status,
  mimeType: media.mimeType,
  sizeBytes: media.sizeBytes,
  durationSeconds: media.durationSeconds,
  isVoiceNote: media.isVoiceNote,
  extractedText: mediaAnalysis.extractedText,
  description: mediaAnalysis.description,
}
type MediaRowIn = {
  id: string; messageId: string; status: 'pending' | 'done' | 'failed'
  mimeType: string | null; sizeBytes: number | null
  durationSeconds: number | null; isVoiceNote: boolean | null
  extractedText: string | null; description: string | null
}

// The url exists only for bytes /media/[id] will actually serve — the same
// `done` condition that route checks — so a transcript never links to a file
// that is not there.
function toMediaView(r: MediaRowIn): MediaView {
  const ready = r.status === 'done'
  return {
    id: r.id,
    status: r.status === 'done' ? 'ready' : r.status,
    url: ready ? `/media/${r.id}` : null,
    mimeType: r.mimeType,
    sizeBytes: r.sizeBytes,
    durationSeconds: r.durationSeconds,
    isVoiceNote: r.isVoiceNote,
    extractedText: r.extractedText ?? null,
    description: r.description ?? null,
  }
}

// The status is part of the JOIN, not a WHERE clause: a media row with a
// pending, failed or skipped analysis must still come back, just without
// extracted text. Stating it here means this query no longer depends on
// "extracted_text is only ever written on a done row" holding elsewhere.
const doneAnalysis = and(eq(mediaAnalysis.mediaId, media.id), eq(mediaAnalysis.status, 'done'))

// One query for a whole page's attachments, so a 100-message transcript costs
// two round trips rather than 101. Every row comes back whatever its state;
// toMediaView decides what each state may say.
export async function mediaForMessages(messageIds: string[]): Promise<Map<string, MediaView>> {
  const out = new Map<string, MediaView>()
  if (messageIds.length === 0) return out
  const rows = await db.select(mediaColumns)
    .from(media)
    .leftJoin(mediaAnalysis, doneAnalysis)
    .where(inArray(media.messageId, messageIds))
  for (const r of rows) out.set(r.messageId, toMediaView(r))
  return out
}

// One attachment by its own id, with the message and chat it belongs to, for
// the get_media tool. Null when there is no such row or its message has been
// deleted — a tombstoned message's attachment is as gone as its text.
export type MediaDetail = MediaView & { id: string; messageId: string; chatId: string; sentAt: Date }

export async function mediaView(id: string): Promise<MediaDetail | null> {
  const [r] = await db.select({ ...mediaColumns, chatId: messages.chatId, sentAt: messages.sentAt })
    .from(media)
    .innerJoin(messages, and(eq(messages.id, media.messageId), isNull(messages.deletedAt)))
    .leftJoin(mediaAnalysis, doneAnalysis)
    .where(eq(media.id, id))
    .limit(1)
  if (!r) return null
  return { ...toMediaView(r), id: r.id, messageId: r.messageId, chatId: r.chatId, sentAt: r.sentAt }
}
