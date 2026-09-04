import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm'
import { QueryBuilder, alias } from 'drizzle-orm/sqlite-core'
import { db } from '@/lib/db/client'
import {
  channelContacts, chats, media, mediaAnalysis, messages, connections, people, personIdentities,
} from '@/lib/db/schema'
import { searchIndex } from '@/lib/db/fts'
import type { Channel } from '@/lib/channels/port'
import type { IncomingMessage } from '@/lib/services/ingest'
import { analysisMedium } from '@/lib/services/media-analysis'
import { getSettings, type Settings } from '@/lib/services/settings'

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
  // A re-paired account makes a second row for every chat it re-syncs: same
  // title, different id and count. These two tell such rows apart, and
  // connectionId is the id whoami reports — this instance's own uuid, never
  // the account identifier.
  createdAt: Date; connectionId: string
  person: PersonRef | null
  // The latest live message that says something, cut to SNIPPET_CHARS:
  // enough to tell an agent what a chat is about without opening it. A
  // textless attachment shows as a bracketed placeholder ("[image]"); system
  // rows and textless unknown rows are walked past; null only when the chat
  // has nothing else.
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
// Whether text was, or could be, extracted from the bytes. `extractedText:
// null` alone meant five things to a reader — no key in Settings, not run
// yet, nothing found, failed, or a kind of file nothing here analyses — so
// the state is named. 'off' is the enrichment switch (no OpenRouter key, or
// the medium's toggle off); 'queued' is a row the worker has not finished,
// or bytes still downloading; 'failed' is an analysis that gave up or a
// download that did; 'unsupported' is a file the pipeline never takes (a
// PDF, a song).
export type AnalysisState = 'off' | 'queued' | 'done' | 'failed' | 'skipped' | 'unsupported'
export type MediaView = {
  id: string | null; status: MediaStatus; url: string | null
  mimeType: string | null; sizeBytes: number | null
  durationSeconds: number | null; isVoiceNote: boolean | null
  extractedText: string | null; description: string | null
  analysis: AnalysisState
}

// The message a reply quotes, when the archive has it: enough to read the
// reply in context without a second call. Null for a message that is not a
// reply, for one whose target never reached the archive, and for one whose
// target was deleted — deleted stays deleted, quoted or not.
export type ReplyRef = { id: string; senderName: string | null; text: string | null }

export type MessageView = {
  id: string; externalMessageId: string; senderName: string | null; fromOwner: boolean; sentAt: Date
  // What the channel called the sender — push name, contact name, number —
  // with the address book left out. senderName puts the address book first,
  // so this is where the transcript's "(Kim Smith)" hint and an agent's
  // "the name I saw last week" come from.
  channelName: string | null
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
export const MAX_LIMIT = 200
const DEFAULT_SEARCH_LIMIT = 50
// An agent's first call must be answerable: a chat list or an inbox defaults
// to one screenful, and the cursor is there for the rest.
const DEFAULT_CHAT_LIMIT = 20
const DEFAULT_RECENT_LIMIT = 20
const SNIPPET_CHARS = 160

export const clampLimit = (limit: number | undefined, fallback: number): number =>
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
// never drags a whole essay per row out of the database. An attachment with
// no caption still says what it is — "[image]" — because a blank snippet
// beside a busy chat read as a bug.
const snippetText = sql`coalesce(substr(${messages.text}, 1, ${SNIPPET_CHARS}),
  case ${messages.type}
    when 'image' then '[image]' when 'video' then '[video]' when 'audio' then '[audio]'
    when 'document' then '[document]' when 'sticker' then '[sticker]' when 'location' then '[location]'
    when 'contact' then '[contact]' when 'poll' then '[poll]' end)`
// Rows that say nothing are walked past: system rows, and any text,
// reaction or unrecognised row with no text (a context-only
// extendedTextMessage, an un-reaction, a node the parser could not name).
const latestSnippet = nested(sql<string | null>`(select case when ${messages.type} = 'reaction'
    then 'Reacted ' || ${messages.text} else ${snippetText} end
  from ${messages}
  where ${messages.chatId} = ${chats.id} and ${messages.deletedAt} is null and ${messages.type} <> 'system'
    and not (${messages.text} is null and ${messages.type} in ('text', 'reaction', 'unknown'))
  order by ${messages.sentAt} desc, ${messages.id} desc limit 1)`)

// A chat with no messages yet still belongs in the list; sort it by when we
// learned about it rather than dropping it to the bottom forever. Selected as
// well as ordered by, because the page cursor is built from it.
const activityAt = sql<number>`coalesce(${chats.lastMessageAt}, ${chats.createdAt})`

const chatSelection = {
  id: chats.id, channel: chats.channel, kind: chats.kind,
  title: displayTitle, lastMessageAt: chats.lastMessageAt, messageCount: liveMessageCount,
  createdAt: chats.createdAt, connectionId: chats.connectionId,
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
// The owner's own lines resolve to the owner's own row (people.is_owner),
// never to a contact that happens to hold the owner's id, so "what did I
// tell Ada" has an id to filter on. A hidden owner is nobody, like anyone.
const ownerRow = sql`${people.isOwner} = 1 and ${people.archivedAt} is null`
const senderPersonId = nested(sql<string | null>`case when ${messages.fromOwner} = 1
  then (select ${people.id} from ${people} where ${ownerRow} limit 1)
  else (select ${personIdentities.personId} from ${personIdentities}
    inner join ${people} on ${people.id} = ${personIdentities.personId}
    where ${senderIdentity} and ${people.archivedAt} is null) end`).as('person_id')
// Unaliased, because the sender filter below uses it in a WHERE, where an
// alias would render as a column that does not exist.
const senderPersonNameSql = nested(sql<string | null>`case when ${messages.fromOwner} = 1
  then (select ${people.name} from ${people} where ${ownerRow} limit 1)
  else (select ${people.name} from ${personIdentities}
    inner join ${people} on ${people.id} = ${personIdentities.personId}
    where ${senderIdentity} and ${people.archivedAt} is null) end`)
const senderPersonName = senderPersonNameSql.as('person_name')

// The latest push name this sender put on ANY live message on this channel.
// A history sync carries no push name and a live message does, so without
// this the same person read as "Ada" in one chat and "+1555…" in the next,
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
const channelLabelSql = sql<string | null>`coalesce(${messages.senderName}, ${latestPushName}, ${contactName},
  case when ${senderChannel} = 'whatsapp' and ${messages.senderExternalId} like '%@s.whatsapp.net'
    then '+' || substr(${messages.senderExternalId}, 1, instr(${messages.senderExternalId}, '@') - 1) end)`
const senderLabelSql = sql<string | null>`coalesce(${senderPersonNameSql}, ${channelLabelSql})`
// Aliased: searchMessages selects these inside a subquery, and drizzle
// refuses an unaliased raw column there.
const senderLabel = senderLabelSql.as('sender_name')
const channelLabel = channelLabelSql.as('channel_name')

// The quoted message, joined by (this chat, the channel's id it carries):
// (chat_id, external_message_id) is the messages unique index, so it is one
// probe per row. Every read path that selects messageSelection joins it with
// quotedJoin. The quoted text is cut like a snippet: the reply needs its
// context, not the whole essay it answered.
const quoted = alias(messages, 'quoted')
const quotedJoin = and(
  eq(quoted.chatId, messages.chatId),
  eq(quoted.externalMessageId, messages.replyToExternalId),
  isNull(quoted.deletedAt),
)!

const messageSelection = {
  id: messages.id, externalMessageId: messages.externalMessageId,
  senderName: senderLabel, channelName: channelLabel, fromOwner: messages.fromOwner, sentAt: messages.sentAt,
  type: messages.type, text: messages.text, editedAt: messages.editedAt,
  personId: senderPersonId, personName: senderPersonName,
  hasMedia: messages.hasMedia,
  replyToId: quoted.id,
  replyToSender: quoted.senderName,
  replyToText: sql<string | null>`substr(${quoted.text}, 1, ${SNIPPET_CHARS})`.as('reply_to_text'),
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
  analysis: 'unsupported',
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
): Promise<{ chats: ChatSummary[]; nextCursor: string | null; total: number }> {
  const limit = clampLimit(opts.limit, DEFAULT_CHAT_LIMIT)
  const conds: SQL[] = []
  if (opts.channel) conds.push(eq(chats.channel, opts.channel))
  if (opts.kind) conds.push(eq(chats.kind, opts.kind))
  const q = opts.q?.trim()
  if (q) conds.push(like(displayTitle, q))
  // How many match the filters — the whole set, not the page — so an agent
  // knows what it is paging through before it starts. Counted before the
  // cursor narrows the set.
  const [{ total }] = await db.select({ total: sql<number>`count(*)` }).from(chats)
    .where(conds.length > 0 ? and(...conds) : undefined)
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
  return { chats: page.map(toSummary), nextCursor, total }
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

// WhatsApp writes a mention into the text as "@<digits>" — the user part of
// a phone JID or, more and more, of a LID — and names it only in a side
// field the archive does not keep. Read as-is that is "@<digits>"
// beside a sender who is fully named, so the digits are resolved here, on
// the page only, to the same names the sender label uses: the address book,
// then the latest push name anyone with that id ever carried, then the
// owner's contact list. Stored text is untouched. Telegram is left alone: its
// mentions are @usernames, and digits after an @ there are someone's handle.
// The word boundary before the @ keeps an e-mail address whole.
const MENTION = /(^|[^\w.])@(\d{5,})/g

async function mentionNames(digits: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (digits.length === 0) return out
  const idsOf = (d: string) => [`${d}@s.whatsapp.net`, `${d}@lid`]
  const ids = digits.flatMap(idsOf)
  const digitsOf = (externalId: string) => externalId.slice(0, externalId.indexOf('@'))
  // The same precedence as the sender label — address book, then the latest
  // push name, then the contact list — applied weakest first so a stronger
  // source overwrites. The push-name query is one row per sender (SQLite
  // returns the columns of the max(sent_at) row), served by
  // messages_sender_sent_idx; the JID suffix already fixes the channel.
  const [contacts, pushed, linked] = await Promise.all([
    db.select({ externalId: channelContacts.externalId, name: channelContacts.displayName })
      .from(channelContacts)
      .where(and(eq(channelContacts.channel, 'whatsapp'), inArray(channelContacts.externalId, ids), sql`${channelContacts.displayName} is not null`))
      .orderBy(asc(channelContacts.syncedAt)),
    db.select({ externalId: messages.senderExternalId, name: messages.senderName, latest: sql<number>`max(${messages.sentAt})` })
      .from(messages)
      .where(and(inArray(messages.senderExternalId, ids), isNull(messages.deletedAt), sql`${messages.senderName} is not null`))
      .groupBy(messages.senderExternalId),
    db.select({ externalId: personIdentities.externalId, name: people.name })
      .from(personIdentities)
      .innerJoin(people, and(eq(people.id, personIdentities.personId), isNull(people.archivedAt)))
      .where(and(eq(personIdentities.channel, 'whatsapp'), inArray(personIdentities.externalId, ids))),
  ])
  for (const r of contacts) if (r.name) out.set(digitsOf(r.externalId), r.name)
  for (const r of pushed) if (r.externalId && r.name) out.set(digitsOf(r.externalId), r.name)
  for (const r of linked) out.set(digitsOf(r.externalId), r.name)
  return out
}

async function resolveMentions<T extends { text: string | null }>(items: T[], channelOf: (item: T) => Channel): Promise<T[]> {
  const digits = new Set<string>()
  for (const item of items) {
    if (channelOf(item) !== 'whatsapp' || !item.text) continue
    for (const m of item.text.matchAll(MENTION)) digits.add(m[2])
  }
  const names = await mentionNames([...digits])
  if (names.size === 0) return items
  return items.map(item => {
    if (channelOf(item) !== 'whatsapp' || !item.text) return item
    const text = item.text.replace(MENTION, (whole, before: string, d: string) => {
      const name = names.get(d)
      return name ? `${before}@${name}` : whole
    })
    return text === item.text ? item : { ...item, text }
  })
}

export async function getMessages(chatId: string, opts: {
  cursor?: string; limit?: number; before?: Date; after?: Date
} = {}): Promise<{ chat: ChatSummary; messages: MessageView[]; nextCursor: string | null } | null> {
  const chat = await chatSummary(chatId)
  if (!chat) return null
  const limit = clampLimit(opts.limit, DEFAULT_LIMIT)

  const rows = await db.select(messageSelection).from(messages)
    .leftJoin(quoted, quotedJoin)
    .where(and(eq(messages.chatId, chatId), ...messagePageConds(opts)))
    .orderBy(desc(messages.sentAt), desc(messages.id))
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const nextCursor = rows.length > limit && page.length > 0 ? encodeCursor(page[page.length - 1]) : null
  const mediaById = await mediaForMessages(page.map(r => r.id))
  const views = await resolveMentions(page.map(r => toView(r, mediaById.get(r.id))), () => chat.channel)
  return { chat, messages: views, nextCursor }
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
// open the app, and the one-hop answer to "what happened today" — which is
// why broadcast channels stay out unless asked for: a Telegram news feed
// posts more than every friend put together, and an inbox that is mostly
// announcements is not an inbox. Ask for kind: 'channel' or includeChannels
// and they are there.
export async function recentMessages(opts: {
  channel?: ChatChannel; kind?: ChatKind; includeChannels?: boolean
  limit?: number; cursor?: string; before?: Date; after?: Date
} = {}): Promise<{ messages: MessageInChat[]; nextCursor: string | null }> {
  const limit = clampLimit(opts.limit, DEFAULT_RECENT_LIMIT)
  const conds = messagePageConds(opts)
  if (opts.channel) conds.push(eq(chats.channel, opts.channel))
  if (opts.kind) conds.push(eq(chats.kind, opts.kind))
  else if (!opts.includeChannels) conds.push(sql`${chats.kind} <> 'channel'`)

  const rows = await db.select({ ...messageSelection, ...chatColumns }).from(messages)
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .leftJoin(quoted, quotedJoin)
    .where(and(...conds))
    .orderBy(desc(messages.sentAt), desc(messages.id))
    .limit(limit + 1)

  const page = rows.slice(0, limit)
  const nextCursor = rows.length > limit && page.length > 0 ? encodeCursor(page[page.length - 1]) : null
  const mediaById = await mediaForMessages(page.map(r => r.id))
  const views = page.map(({ chatId, chatTitle, channel, kind, ...r }) =>
    ({ ...toView(r, mediaById.get(r.id)), chatId, chatTitle, channel, kind }))
  return { messages: await resolveMentions(views, m => m.channel), nextCursor }
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

// How hits are ordered. Relevance is bm25, best match first, and is the
// default for a bare query; a query with a date bound is a "what was said
// then" question, so it defaults to newest first. Either can be asked for.
export type SearchOrder = 'relevance' | 'newest'
export const SEARCH_ORDERS: readonly SearchOrder[] = ['relevance', 'newest']

export type SearchOptions = {
  chatId?: string
  channel?: ChatChannel
  kind?: ChatKind
  // A substring of any name the sender has been shown under: the channel's
  // push name, the owner's contact-list name, or the address-book name.
  sender?: string
  before?: Date
  after?: Date
  limit?: number
  order?: SearchOrder
  cursor?: string
}

// A search cursor carries the order it was minted for, so a cursor from a
// relevance page handed back with order: newest reads as "start at the top"
// rather than as a keyset in the wrong dimension. Opaque to the caller.
type SearchCursor = { order: 'relevance'; rank: number; id: string } | { order: 'newest'; ms: number; id: string }

function encodeSearchCursor(c: SearchCursor): string {
  const raw = c.order === 'relevance' ? `r:${c.rank}:${c.id}` : `t:${c.ms}:${c.id}`
  return Buffer.from(raw, 'utf8').toString('base64url')
}

function decodeSearchCursor(cursor: string, order: SearchOrder): SearchCursor | null {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8')
  const [tag, num, ...rest] = raw.split(':')
  const id = rest.join(':')
  // Number('') is 0, which would read as a real keyset; an empty field is
  // not a cursor.
  const n = num ? Number(num) : NaN
  if (!Number.isFinite(n) || !id) return null
  if (tag === 'r' && order === 'relevance') return { order, rank: n, id }
  if (tag === 't' && order === 'newest') return { order, ms: n, id }
  return null
}

export async function searchMessages(
  query: string, opts: SearchOptions = {},
): Promise<{ hits: MessageInChat[]; nextCursor: string | null }> {
  const match = toMatchExpression(query)
  if (!match) return { hits: [], nextCursor: null }
  const order: SearchOrder = opts.order ?? (opts.before || opts.after ? 'newest' : 'relevance')
  const limit = clampLimit(opts.limit, DEFAULT_SEARCH_LIMIT)
  const cursor = opts.cursor ? decodeSearchCursor(opts.cursor, order) : null

  const conds = [sql`search_index MATCH ${match}`, isNull(messages.deletedAt)]
  if (opts.chatId) conds.push(eq(messages.chatId, opts.chatId))
  if (opts.channel) conds.push(eq(chats.channel, opts.channel))
  if (opts.kind) conds.push(eq(chats.kind, opts.kind))
  if (opts.before) conds.push(lt(messages.sentAt, opts.before))
  if (opts.after) conds.push(gt(messages.sentAt, opts.after))
  // The one filter that costs a name lookup per matched row rather than per
  // page: it has to, because a page cut before the filter would be short.
  // Every name the reader could have met for this sender, not only the one
  // the label settles on: the push name, the contact-list name and the
  // address-book name. An agent that learned "Kim" from an older transcript
  // still finds her after the owner named her "Mum".
  const sender = opts.sender?.trim()
  if (sender) {
    conds.push(or(like(sql`${messages.senderName}`, sender), like(contactName, sender), like(senderPersonNameSql, sender))!)
  }

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
    sentAt: sql<number>`${messages.sentAt}`.as('sent_at'),
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
  // page is cut, one row over so the caller learns whether there is more. The
  // keyset for a cursor sits in HAVING because both sort keys are aggregates
  // (sent_at is constant per message; max() is only how it passes the GROUP
  // BY). An aggregate subquery under a join is not flattened by SQLite, so
  // the LIMIT here really does bound what the outer query touches.
  const bestRank = sql<number>`min(${ranked.rank})`
  const bestSent = sql<number>`max(${ranked.sentAt})`
  const keyset = cursor === null
    ? undefined
    : cursor.order === 'relevance'
      ? sql`${bestRank} > ${cursor.rank} or (${bestRank} = ${cursor.rank} and ${ranked.messageId} > ${cursor.id})`
      : sql`${bestSent} < ${cursor.ms} or (${bestSent} = ${cursor.ms} and ${ranked.messageId} < ${cursor.id})`
  const best = db.select({
    messageId: ranked.messageId,
    rank: bestRank.as('best_rank'),
    sentAt: bestSent.as('best_sent'),
  }).from(ranked)
    .groupBy(ranked.messageId)
    .having(keyset)
    .orderBy(...(order === 'relevance'
      ? [asc(bestRank), asc(ranked.messageId)]
      : [desc(bestSent), desc(ranked.messageId)]))
    .limit(limit + 1)
    .as('best')

  // Only now, on the page and nothing more, are the names resolved.
  // messageSelection carries several correlated subqueries per row (the
  // sender's person and channel name, and the two the display title needs)
  // and the quoted-message join; inside `ranked` they would run once per
  // FTS-matched row, which for a common word is the whole corpus rather than
  // the fifty rows anybody sees. The sender filter is the one exception, and
  // it is kept to the three plain lookups for that reason.
  const rows = await db.select({ ...messageSelection, ...chatColumns, rank: best.rank }).from(best)
    .innerJoin(messages, eq(messages.id, best.messageId))
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .leftJoin(quoted, quotedJoin)
    .orderBy(...(order === 'relevance' ? [asc(best.rank), asc(best.messageId)] : [desc(best.sentAt), desc(best.messageId)]))

  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  // max(sent_at) grouped per message is that message's own sent_at.
  const nextCursor = rows.length > limit && last
    ? encodeSearchCursor(order === 'relevance'
      ? { order, rank: last.rank, id: last.id }
      : { order, ms: last.sentAt.getTime(), id: last.id })
    : null
  const mediaById = await mediaForMessages(page.map(r => r.id))
  const hits = await resolveMentions(page.map(({ chatId, chatTitle, channel, kind, rank: _rank, ...r }) =>
    ({ ...toView(r, mediaById.get(r.id)), chatId, chatTitle, channel, kind })), m => m.channel)
  return { hits, nextCursor }
}

const mediaColumns = {
  id: media.id,
  messageId: media.messageId,
  messageType: messages.type,
  status: media.status,
  mimeType: media.mimeType,
  sizeBytes: media.sizeBytes,
  durationSeconds: media.durationSeconds,
  isVoiceNote: media.isVoiceNote,
  analysisStatus: mediaAnalysis.status,
  extractedText: mediaAnalysis.extractedText,
  description: mediaAnalysis.description,
}
type MediaRowIn = {
  id: string; messageId: string; messageType: string; status: 'pending' | 'done' | 'failed'
  mimeType: string | null; sizeBytes: number | null
  durationSeconds: number | null; isVoiceNote: boolean | null
  analysisStatus: 'pending' | 'done' | 'failed' | 'skipped' | null
  extractedText: string | null; description: string | null
}

function analysisState(r: MediaRowIn, settings: Settings): AnalysisState {
  if (r.analysisStatus === 'done' || r.analysisStatus === 'failed' || r.analysisStatus === 'skipped') return r.analysisStatus
  const medium = analysisMedium(r)
  if (medium === null) return 'unsupported'
  const on = settings.hasOpenrouterKey && (medium === 'image' ? settings.analyzeImages : settings.analyzeAudio)
  if (!on) return 'off'
  // Bytes that never arrived are never analysed: the enqueue gate takes only
  // downloaded files, so a failed download is 'failed', not queued forever.
  return r.status === 'failed' ? 'failed' : 'queued'
}

// The url exists only for bytes /media/[id] will actually serve — the same
// `done` condition that route checks — so a transcript never links to a file
// that is not there. Extracted text is shown only from a done analysis row:
// a pending, failed or skipped one still comes back, as its state.
function toMediaView(r: MediaRowIn, settings: Settings): MediaView {
  const ready = r.status === 'done'
  const analysed = r.analysisStatus === 'done'
  return {
    id: r.id,
    status: r.status === 'done' ? 'ready' : r.status,
    url: ready ? `/media/${r.id}` : null,
    mimeType: r.mimeType,
    sizeBytes: r.sizeBytes,
    durationSeconds: r.durationSeconds,
    isVoiceNote: r.isVoiceNote,
    extractedText: analysed ? r.extractedText ?? null : null,
    description: analysed ? r.description ?? null : null,
    analysis: analysisState(r, settings),
  }
}

// One query for a whole page's attachments, so a 100-message transcript costs
// two round trips rather than 101. Every row comes back whatever its state;
// toMediaView decides what each state may say. The message is joined for its
// type, which the analysis predicate needs; settings are read once per page.
export async function mediaForMessages(messageIds: string[]): Promise<Map<string, MediaView>> {
  const out = new Map<string, MediaView>()
  if (messageIds.length === 0) return out
  const [rows, settings] = await Promise.all([
    db.select(mediaColumns)
      .from(media)
      .innerJoin(messages, eq(messages.id, media.messageId))
      .leftJoin(mediaAnalysis, eq(mediaAnalysis.mediaId, media.id))
      .where(inArray(media.messageId, messageIds)),
    getSettings(),
  ])
  for (const r of rows) out.set(r.messageId, toMediaView(r, settings))
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
    .leftJoin(mediaAnalysis, eq(mediaAnalysis.mediaId, media.id))
    .where(eq(media.id, id))
    .limit(1)
  if (!r) return null
  return { ...toMediaView(r, await getSettings()), id: r.id, messageId: r.messageId, chatId: r.chatId, sentAt: r.sentAt }
}
