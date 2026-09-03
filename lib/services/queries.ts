import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm'
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

export type ChatSummary = {
  id: string; channel: Channel; kind: 'dm' | 'group' | 'channel'
  title: string | null; lastMessageAt: Date | null; messageCount: number
  person: PersonRef | null
}

export type MessageView = {
  id: string; externalMessageId: string; senderName: string | null; fromOwner: boolean; sentAt: Date
  type: IncomingMessage['type']; text: string | null; editedAt: Date | null
  person: PersonRef | null
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
const dmPersonId = nested(sql<string | null>`(select ${personIdentities.personId} from ${personIdentities} where ${dmIdentity})`)
const dmPersonName = nested(sql<string | null>`(select ${people.name} from ${personIdentities}
  inner join ${people} on ${people.id} = ${personIdentities.personId} where ${dmIdentity})`)

// What the owner decided to call this person outranks every name a channel
// supplied: the address book is the answer they wrote down themselves.
const displayTitle = sql<string | null>`case when ${chats.kind} = 'dm'
  then coalesce(${dmPersonName}, nullif(${chats.title}, ${ownerDisplayName}), ${latestCounterparty}, ${whatsappNumber}, ${chats.title})
  else ${chats.title} end`

const chatSelection = {
  id: chats.id, channel: chats.channel, kind: chats.kind,
  title: displayTitle, lastMessageAt: chats.lastMessageAt, messageCount: liveMessageCount,
  personId: dmPersonId, personName: dmPersonName,
}

// Exactly what chatSelection returns: the person arrives as two columns and
// leaves as one nested object, so no caller has to know the join.
type ChatRow = Omit<ChatSummary, 'person'> & { personId: string | null; personName: string | null }

const personRef = (id: string | null, name: string | null): PersonRef | null =>
  id !== null && name !== null ? { id, name } : null

const toSummary = ({ personId, personName, ...row }: ChatRow): ChatSummary =>
  ({ ...row, person: personRef(personId, personName) })

// WhatsApp history sync carries no push name, so almost every synced message
// from someone else arrives nameless — but never id-less. A sender with no
// name shows as the phone number that is their JID rather than "Unknown";
// Telegram ids are opaque, so a nameless Telegram sender stays null.
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

// Aliased: searchMessages selects this inside a subquery, and drizzle refuses
// an unaliased raw column there.
const senderLabel = sql<string | null>`coalesce(${messages.senderName}, ${contactName},
  case when ${senderChannel} = 'whatsapp' and ${messages.senderExternalId} like '%@s.whatsapp.net'
    then '+' || substr(${messages.senderExternalId}, 1, instr(${messages.senderExternalId}, '@') - 1) end)`.as('sender_name')

// A message's sender identity is (the chat's channel, sender_external_id). The
// owner is never one of them: from_owner is the archive's own answer to "who
// wrote this", and it wins even if the owner's id is in the address book.
const senderIdentity = sql`${messages.fromOwner} = 0
  and ${personIdentities.channel} = ${senderChannel}
  and ${personIdentities.externalId} = ${messages.senderExternalId}`
const senderPersonId = nested(sql<string | null>`(select ${personIdentities.personId} from ${personIdentities}
  where ${senderIdentity})`).as('person_id')
const senderPersonName = nested(sql<string | null>`(select ${people.name} from ${personIdentities}
  inner join ${people} on ${people.id} = ${personIdentities.personId} where ${senderIdentity})`).as('person_name')

const messageSelection = {
  id: messages.id, externalMessageId: messages.externalMessageId,
  senderName: senderLabel, fromOwner: messages.fromOwner, sentAt: messages.sentAt,
  type: messages.type, text: messages.text, editedAt: messages.editedAt,
  personId: senderPersonId, personName: senderPersonName,
}

// Exactly what messageSelection returns: MessageView minus the field the
// database cannot answer yet, with the person still in its two columns.
type MessageRow = Omit<MessageView, 'media' | 'person'> & { personId: string | null; personName: string | null }

// M4 fills the second argument from mediaForMessages; it stays defaulted so
// any caller that has no media map still gets a well-formed MessageView.
const toView = ({ personId, personName, ...row }: MessageRow, media: MessageView['media'] = null): MessageView =>
  ({ ...row, person: personRef(personId, personName), media })

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

export type ChatChannel = 'telegram' | 'whatsapp'
export const CHAT_CHANNELS: readonly ChatChannel[] = ['telegram', 'whatsapp']

export async function listChats(opts: { channel?: ChatChannel } = {}): Promise<ChatSummary[]> {
  const rows = await db.select(chatSelection).from(chats)
    .where(opts.channel ? eq(chats.channel, opts.channel) : undefined)
    // A chat with no messages yet still belongs in the list; sort it by when
    // we learned about it rather than dropping it to the bottom forever.
    .orderBy(desc(sql`coalesce(${chats.lastMessageAt}, ${chats.createdAt})`), desc(chats.id))
  return rows.map(toSummary)
}

async function chatSummary(chatId: string): Promise<ChatSummary | null> {
  const [row] = await db.select(chatSelection).from(chats).where(eq(chats.id, chatId))
  return row ? toSummary(row) : null
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
  // search_index row here — and nothing else is: ids and a score only.
  const ranked = db.select({
    messageId: searchIndex.messageId,
    rank: sql<number>`bm25(search_index)`.as('rank'),
  }).from(searchIndex)
    .innerJoin(messages, eq(messages.id, searchIndex.messageId))
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
    .limit(Math.max(1, Math.min(limit, MAX_LIMIT)))
    .as('best')

  // Only now, on the page and nothing more, are the names resolved.
  // messageSelection carries four correlated subqueries per row (the sender's
  // person, the owner's contact name, and the two the display title needs);
  // inside `ranked` they ran once per FTS-matched row, which for a common word
  // is the whole corpus rather than the fifty rows anybody sees.
  //
  // chatTitle is the SAME expression the chat list uses, not chats.title: a
  // WhatsApp DM's stored title is routinely null or the owner's own name, so
  // the raw column made a search hit read as `null` in the exact chat the list
  // beside it names after a person.
  const rows = await db.select({
    ...messageSelection,
    chatId: messages.chatId,
    chatTitle: displayTitle.as('chat_title'),
  }).from(best)
    .innerJoin(messages, eq(messages.id, best.messageId))
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .orderBy(asc(best.rank))

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
    // The status is part of the JOIN, not a WHERE clause: a media row with a
    // pending, failed or skipped analysis must still come back, just without
    // extracted text. Stating it here means this query no longer depends on
    // "extracted_text is only ever written on a done row" holding elsewhere.
    .leftJoin(mediaAnalysis, and(eq(mediaAnalysis.mediaId, media.id), eq(mediaAnalysis.status, 'done')))
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
