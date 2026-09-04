import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import {
  channelContacts, chats, connections, dismissedSuggestions, messages, people, personIdentities,
} from '@/lib/db/schema'
import type { Channel } from '@/lib/channels/port'
import { chatSummaries, type ChatKind } from '@/lib/services/queries'

// The address book. Everything here is the owner's own annotation over
// identities the archive already stores: nothing in this file talks to a
// channel, and nothing it writes is ever sent back to one.
//
// Suggestions are COMPUTED on every call, never stored (people design
// decision 4). Only a dismissal is remembered, because "no, not the same
// person" is an answer the matcher would otherwise forget on the next page
// load. A suggestion never links anything on its own — confirmSuggestion is
// the only path from a match to a row, and the owner is the one who calls it.
//
// populatePeople (bottom of the file) does write without being asked, and the
// line it keeps is the same one: it may only record what the archive already
// says — this contact has this name — and may only claim two channels are one
// person when their phone numbers are equal (addendum 2, decisions 11–12). A
// name match is still nothing but a suggestion.
//
// Phone numbers live in this file and in the database, never in a log
// (invariant: log through lib/log with errorShape only) and never in an agent
// response (that mapping is Task 6's).

export type IdentityRef = { channel: Channel; externalId: string }
// 'auto' is the populater's own source (decision 11); the rest record an
// answer the owner gave.
export type IdentitySource = 'manual' | 'phone_match' | 'name_match' | 'auto'
// Who chose the name. 'channel' follows the contact list on every later sync;
// 'owner' is an alias the owner typed and no sync overwrites it (decision 13).
export type NameSource = 'channel' | 'owner'

// What a channel binding hands back from listContacts(). `phone` is +digits
// or null; syncContacts normalises anything looser.
export type ChannelContact = { externalId: string; displayName: string | null; phone: string | null }

export type PersonView = {
  id: string
  name: string
  notes: string | null
  nameSource: NameSource
  archivedAt: Date | null
  identities: Array<{
    id: string; channel: Channel; externalId: string
    displayName: string | null; phone: string | null; source: IdentitySource
  }>
  chatCount: number
}

// A name is a label in a list and a heading on a page, not a document: one
// line, and long enough for any real name plus a disambiguating word.
const MAX_NAME = 100

function cleanName(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length < 1 || trimmed.length > MAX_NAME) {
    throw new RangeError(`person name must be 1..${MAX_NAME} characters`)
  }
  return trimmed
}

// For a name the machine derived rather than the owner typed: a display name
// from a channel has no length contract, and refusing to create the person
// over it would be a worse answer than trimming it.
const clampName = (name: string): string => name.trim().slice(0, MAX_NAME)

const cleanText = (v: string | null | undefined): string | null => {
  const trimmed = v?.trim()
  return trimmed ? trimmed : null
}

// One shape for a phone number everywhere it is stored or compared: '+' and
// digits. '+44 7700 900123' and '+44-7700-900123' are the same number and must
// compare equal, and a contact with no number at all reads as null rather than
// as the empty string (which would match every other empty string).
function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null
  const digits = input.replace(/\D/g, '')
  return digits ? `+${digits}` : null
}

// A WhatsApp identity IS a phone number: the canonical JID is <digits>@s.whatsapp.net
// (people design decision 3). Anything else — a LID, a group JID, a broadcast —
// carries no number and must not be guessed at.
function phoneFromJid(externalId: string): string | null {
  const m = /^(\d+)@s\.whatsapp\.net$/.exec(externalId)
  return m ? `+${m[1]}` : null
}

// better-sqlite3 raises SqliteError with a SQLITE_CONSTRAINT_* code; drizzle
// wraps it, so walk the cause chain. Used to turn the unique index on
// (channel, external_id) into `already_linked` instead of a 500, without
// swallowing every other write failure.
function isUniqueViolation(err: unknown): boolean {
  for (let e = err as { code?: unknown; message?: unknown; cause?: unknown } | null | undefined; e; e = e.cause as typeof e) {
    if (typeof e.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT')) return true
    if (typeof e.message === 'string' && /UNIQUE constraint failed/.test(e.message)) return true
  }
  return false
}

// A person "appears in" a chat when one of their identities is the
// counterparty of a DM, or the sender of at least one live message in it — the
// same two identity rules every read path uses (people design decision 3).
// Two queries and a set rather than one join with an EXISTS: the union is
// small, and a deleted message must not keep a person in a chat they only ever
// wrote a since-unsent line in.
async function chatCountsByPerson(personIds: string[]): Promise<Map<string, number>> {
  const ids = await chatIdsByPerson(personIds)
  return new Map(personIds.map(id => [id, ids.get(id)?.size ?? 0]))
}

async function chatIdsByPerson(personIds: string[]): Promise<Map<string, Set<string>>> {
  const seen = new Map<string, Set<string>>()
  if (personIds.length === 0) return seen

  const dmRows = await db.select({ personId: personIdentities.personId, chatId: chats.id })
    .from(personIdentities)
    .innerJoin(chats, and(
      eq(chats.channel, personIdentities.channel),
      eq(chats.kind, 'dm'),
      eq(chats.externalChatId, personIdentities.externalId),
    ))
    .where(inArray(personIdentities.personId, personIds))

  const senderRows = await db.select({ personId: personIdentities.personId, chatId: messages.chatId })
    .from(personIdentities)
    .innerJoin(messages, and(
      eq(messages.senderExternalId, personIdentities.externalId),
      eq(messages.fromOwner, false),
      isNull(messages.deletedAt),
    ))
    .innerJoin(chats, and(eq(chats.id, messages.chatId), eq(chats.channel, personIdentities.channel)))
    .where(inArray(personIdentities.personId, personIds))
    .groupBy(personIdentities.personId, messages.chatId)

  for (const row of [...dmRows, ...senderRows]) {
    let set = seen.get(row.personId)
    if (!set) seen.set(row.personId, set = new Set())
    set.add(row.chatId)
  }
  return seen
}

async function identitiesByPerson(personIds: string[]): Promise<Map<string, PersonView['identities']>> {
  const out = new Map<string, PersonView['identities']>(personIds.map(id => [id, []]))
  if (personIds.length === 0) return out
  const rows = await db.select().from(personIdentities)
    .where(inArray(personIdentities.personId, personIds))
    .orderBy(asc(personIdentities.channel), asc(personIdentities.createdAt), asc(personIdentities.id))
  for (const r of rows) {
    out.get(r.personId)?.push({
      id: r.id, channel: r.channel, externalId: r.externalId,
      displayName: r.displayName, phone: r.phone, source: r.source,
    })
  }
  return out
}

async function toViews(rows: Array<typeof people.$inferSelect>): Promise<PersonView[]> {
  const ids = rows.map(r => r.id)
  const [identities, counts] = [await identitiesByPerson(ids), await chatCountsByPerson(ids)]
  return rows.map(r => ({
    id: r.id, name: r.name, notes: r.notes,
    nameSource: r.nameSource, archivedAt: r.archivedAt,
    identities: identities.get(r.id) ?? [], chatCount: counts.get(r.id) ?? 0,
  }))
}

// lower() so 'ada' and 'Ada' sort together; SQLite's default byte order puts
// every capital before every lower-case letter, which reads as random.
const byName = [asc(sql`lower(${people.name})`), asc(people.id)] as const

// An archived person is invisible everywhere a person can be read — this
// listing, getPerson, publicPeople and the two identity joins in queries.ts
// (decision 14). Their identity rows stay, so the populater counts those
// identities as answered and never offers to create them again.
export async function listPeople(): Promise<PersonView[]> {
  const rows = await db.select().from(people)
    .where(isNull(people.archivedAt)).orderBy(...byName)
  return toViews(rows)
}

// The "Hidden" half of the People page. The only read that returns them.
export async function listArchivedPeople(): Promise<PersonView[]> {
  const rows = await db.select().from(people)
    .where(isNotNull(people.archivedAt)).orderBy(...byName)
  return toViews(rows)
}

// What an agent is allowed to know about a person, and the only shape that
// leaves this machine: this instance's own id, the name the owner chose, their
// notes, which channels are linked, and how many chats they appear in.
//
// A PersonView carries more — each identity's channel id, its display name on
// that channel, and its phone number — and none of it is an agent's business
// (people design decision 6). A WhatsApp identity IS a phone number, so
// dropping the `phone` field alone would not be enough: the externalId goes
// too. Both agent surfaces, the `list_people` MCP tool and GET /api/people,
// call this one function, so neither can quietly start serving a PersonView.
export type PublicPerson = {
  id: string
  name: string
  notes: string | null
  channels: Channel[]
  chatCount: number
  // The chats this person appears in — a DM with them, or a chat they have
  // written in — most recently active first, under the titles the chat list
  // shows. The ids are the ones get_messages takes, so "what did Ada say" is
  // one hop from here.
  chats: Array<{ id: string; title: string | null; channel: Channel; kind: ChatKind }>
}

// `q` is a case-insensitive substring of the name, matched here in memory:
// an address book is hundreds of rows, not millions, and the filter must see
// the same name the list shows.
export async function publicPeople(opts: { q?: string } = {}): Promise<PublicPerson[]> {
  const q = opts.q?.trim().toLowerCase()
  const views = (await listPeople()).filter(p => !q || p.name.toLowerCase().includes(q))
  const chatIds = await chatIdsByPerson(views.map(p => p.id))
  const summaries = await chatSummaries([...new Set([...chatIds.values()].flatMap(s => [...s]))])
  return views.map(p => {
    const mine = chatIds.get(p.id) ?? new Set<string>()
    return {
      id: p.id,
      name: p.name,
      notes: p.notes,
      channels: [...new Set(p.identities.map(i => i.channel))].sort(),
      chatCount: p.chatCount,
      chats: summaries.filter(c => mine.has(c.id)).map(c => ({ id: c.id, title: c.title, channel: c.channel, kind: c.kind })),
    }
  })
}

export async function getPerson(id: string): Promise<PersonView | null> {
  const rows = await db.select().from(people)
    .where(and(eq(people.id, id), isNull(people.archivedAt))).limit(1)
  if (rows.length === 0) return null
  return (await toViews(rows))[0]
}

// nameSource defaults to 'owner' because the caller of this function is the
// owner's own New person form: a name they typed is an alias from the moment
// they type it. populatePeople and confirmSuggestion, which copy a name off a
// contact list, pass 'channel' so a later sync may refresh it.
export async function createPerson(
  input: { name: string; notes?: string | null; nameSource?: NameSource },
): Promise<{ id: string }> {
  const [row] = await db.insert(people)
    .values({
      name: cleanName(input.name), notes: cleanText(input.notes),
      nameSource: input.nameSource ?? 'owner',
    })
    .returning({ id: people.id })
  return { id: row.id }
}

// Absent field = leave alone, `notes: null` = clear it. Returns false when
// there is no such person, so a caller acting on a stale page gets a "gone"
// rather than a silent success.
// Naming a person is aliasing them: the name the owner types outranks every
// contact list forever after (decision 13), so any write that carries a name
// stamps name_source='owner'. An archived person is not there to update.
export async function updatePerson(
  id: string, input: { name?: string; notes?: string | null },
): Promise<boolean> {
  const alive = and(eq(people.id, id), isNull(people.archivedAt))
  const values: Partial<typeof people.$inferInsert> = {}
  if (input.name !== undefined) {
    values.name = cleanName(input.name)
    values.nameSource = 'owner'
  }
  if ('notes' in input) values.notes = cleanText(input.notes)
  if (Object.keys(values).length === 0) {
    const rows = await db.select({ id: people.id }).from(people).where(alive).limit(1)
    return rows.length > 0
  }
  values.updatedAt = new Date()
  const rows = await db.update(people).set(values).where(alive).returning({ id: people.id })
  return rows.length > 0
}

// What "delete" now means (decision 14). The person disappears from every
// listing, every read path and every agent, and its identity rows stay: they
// are the record of the owner's "not this one", and without them the populater
// would create the person again on the next contact sync. Chats and messages
// are untouched either way — the address book is an annotation over the
// archive, never a part of it (people design decision 7).
export async function archivePerson(id: string): Promise<boolean> {
  const rows = await db.update(people).set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(people.id, id), isNull(people.archivedAt)))
    .returning({ id: people.id })
  return rows.length > 0
}

export async function restorePerson(id: string): Promise<boolean> {
  const rows = await db.update(people).set({ archivedAt: null, updatedAt: new Date() })
    .where(and(eq(people.id, id), isNotNull(people.archivedAt)))
    .returning({ id: people.id })
  return rows.length > 0
}

// unique(channel, external_id) is the rule this reports on: an identity that
// already belongs to a person — the same one or another — is `already_linked`,
// never a second row. Unlink it first if it is on the wrong person.
export async function linkIdentity(
  personId: string,
  ref: IdentityRef & { displayName?: string | null; phone?: string | null },
  source: IdentitySource = 'manual',
): Promise<{ ok: true } | { ok: false; reason: 'already_linked' | 'no_person' }> {
  const person = await db.select({ id: people.id }).from(people).where(eq(people.id, personId)).limit(1)
  if (person.length === 0) return { ok: false, reason: 'no_person' }

  const externalId = ref.externalId.trim()
  if (!externalId) return { ok: false, reason: 'already_linked' }

  const existing = await db.select({ id: personIdentities.id }).from(personIdentities)
    .where(and(eq(personIdentities.channel, ref.channel), eq(personIdentities.externalId, externalId)))
    .limit(1)
  if (existing.length > 0) return { ok: false, reason: 'already_linked' }

  const phone = normalizePhone(ref.phone) ?? (ref.channel === 'whatsapp' ? phoneFromJid(externalId) : null)
  try {
    await db.insert(personIdentities).values({
      personId, channel: ref.channel, externalId,
      displayName: cleanText(ref.displayName), phone, source,
    })
  } catch (err) {
    // The check above is not a lock; two tabs can race to the same identity.
    if (isUniqueViolation(err)) return { ok: false, reason: 'already_linked' }
    throw err
  }
  return { ok: true }
}

export async function unlinkIdentity(identityId: string): Promise<boolean> {
  const rows = await db.delete(personIdentities)
    .where(eq(personIdentities.id, identityId))
    .returning({ id: personIdentities.id })
  return rows.length > 0
}

// Rows per statement. Seven bound parameters each, so this stays far under
// SQLite's variable ceiling however many contacts an account has.
const SYNC_CHUNK = 200

// Refreshes the cache for one connection. An upsert, never a replace: a
// contact the channel stopped reporting is left alone rather than deleted, so
// a partial read (a rate-limited page, a reconnect mid-sync) cannot empty the
// address book's raw material. Deleting the CONNECTION is what clears it.
export async function syncContacts(
  connectionId: string, channel: Channel, contacts: ChannelContact[],
): Promise<{ upserted: number }> {
  const syncedAt = new Date()
  const seen = new Set<string>()
  const values: Array<typeof channelContacts.$inferInsert> = []
  for (const c of contacts) {
    const externalId = c.externalId?.trim()
    // One row per id per connection: a channel that reports the same contact
    // twice in one batch would otherwise make the statement conflict with
    // itself, which SQLite refuses outright.
    if (!externalId || seen.has(externalId)) continue
    seen.add(externalId)
    values.push({
      connectionId, channel, externalId,
      displayName: cleanText(c.displayName),
      phone: normalizePhone(c.phone) ?? (channel === 'whatsapp' ? phoneFromJid(externalId) : null),
      syncedAt,
    })
  }

  for (let i = 0; i < values.length; i += SYNC_CHUNK) {
    await db.insert(channelContacts).values(values.slice(i, i + SYNC_CHUNK))
      .onConflictDoUpdate({
        target: [channelContacts.connectionId, channelContacts.externalId],
        set: {
          channel: sql`excluded.channel`,
          displayName: sql`excluded.display_name`,
          phone: sql`excluded.phone`,
          syncedAt: sql`excluded.synced_at`,
        },
      })
  }
  return { upserted: values.length }
}

// One name, compared the way a person would read it: trimmed, and the same
// whichever way it was capitalised. Null for a name that is only whitespace,
// so two people with no name never match each other.
const nameKey = (name: string | null): string | null => {
  const n = name?.trim().toLowerCase()
  return n ? n : null
}

export type IdentityCandidate = IdentityRef & {
  displayName: string | null; phone: string | null
  kind: 'contact' | 'dm' | 'sender'
  personId: string | null
}

// Everyone on one channel the owner could reasonably link: the contact cache,
// the counterparty of every DM, and every non-owner who has sent a live
// message. One entry per external id — the three sources overlap heavily, and
// the contact list is the one that knows a phone number, so it wins the name.
export async function listIdentityCandidates(channel: Channel): Promise<IdentityCandidate[]> {
  const contactRows = await db.select({
    externalId: channelContacts.externalId,
    displayName: channelContacts.displayName,
    phone: channelContacts.phone,
  }).from(channelContacts).where(eq(channelContacts.channel, channel))

  // The owner's own display name comes along because a DM's stored title is
  // sometimes the WRONG SIDE of the conversation: WhatsApp has no subject for a
  // direct chat, and a history sync can leave the owner's own name in it.
  // queries.ts already guards its read path with nullif(title, ownerDisplayName)
  // for exactly this; the candidate list is where a person would otherwise be
  // CREATED under that name, and a person row wins the read path's coalesce
  // ahead of the guard — so the address book would override the defence rather
  // than merely bypass it.
  const dmRows = await db.select({
    externalId: chats.externalChatId,
    displayName: chats.title,
    ownerName: connections.displayName,
  }).from(chats)
    .innerJoin(connections, eq(connections.id, chats.connectionId))
    .where(and(eq(chats.channel, channel), eq(chats.kind, 'dm')))

  // Grouped by (id, name) with max(sent_at) so a sender who has been renamed
  // is offered under the name they most recently wrote under, deterministically
  // rather than by whichever row the planner happened to return first.
  // `sent_at` is unambiguous here: of the two joined tables only messages has it.
  const senderRows = await db.select({
    externalId: messages.senderExternalId,
    displayName: messages.senderName,
    lastAt: sql<number>`max(${messages.sentAt})`,
  }).from(messages)
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .where(and(
      eq(chats.channel, channel),
      eq(messages.fromOwner, false),
      isNull(messages.deletedAt),
      isNotNull(messages.senderExternalId),
    ))
    .groupBy(messages.senderExternalId, messages.senderName)

  const byId = new Map<string, IdentityCandidate>()
  // Insertion order IS the precedence: contact, then DM, then sender. A later
  // source only fills in what an earlier one left null.
  const put = (
    rawId: string | null, displayName: string | null,
    phone: string | null, kind: IdentityCandidate['kind'],
  ) => {
    const externalId = rawId?.trim()
    if (!externalId) return
    const existing = byId.get(externalId)
    if (existing) {
      existing.displayName ??= cleanText(displayName)
      existing.phone ??= phone
      return
    }
    byId.set(externalId, { channel, externalId, displayName: cleanText(displayName), phone, kind, personId: null })
  }

  for (const r of contactRows) put(r.externalId, r.displayName, r.phone, 'contact')
  for (const r of dmRows) {
    // Dropped rather than kept: the counterparty's own sender name may still
    // fill it in below, which is the right name for them. What must not happen
    // is the owner's name becoming somebody else's.
    const title = nameKey(r.displayName) === nameKey(r.ownerName) ? null : r.displayName
    put(r.externalId, title, null, 'dm')
  }
  // Most recent first, because the first writer for an id wins below.
  for (const r of [...senderRows].sort((a, b) => Number(b.lastAt) - Number(a.lastAt))) {
    put(r.externalId, r.displayName, null, 'sender')
  }

  const linked = new Map((await db.select({
    externalId: personIdentities.externalId, personId: personIdentities.personId,
  }).from(personIdentities).where(eq(personIdentities.channel, channel)))
    .map(r => [r.externalId, r.personId] as const))

  const out = [...byId.values()].map(c => ({
    ...c,
    // A WhatsApp id is a phone number in its own right, whether or not the
    // contact cache has heard of it.
    phone: c.phone ?? (channel === 'whatsapp' ? phoneFromJid(c.externalId) : null),
    personId: linked.get(c.externalId) ?? null,
  }))
  // By name, then id. A candidate with no name at all sorts last: it is the
  // one the owner can say least about, not the first thing they should see.
  return out.sort((a, b) => {
    if ((a.displayName === null) !== (b.displayName === null)) return a.displayName === null ? 1 : -1
    const byName = (a.displayName ?? '').localeCompare(b.displayName ?? '', undefined, { sensitivity: 'base' })
    return byName !== 0 ? byName : a.externalId.localeCompare(b.externalId)
  })
}

// A pair of PEOPLE the owner might want to be one person.
//
// The address book fills itself in now, so an identity that matches another
// identity is not the interesting case any more: the populater has already
// given both of them a row. What is left over is two ROWS for one human — one
// found on Telegram, one on WhatsApp, both named the same thing and with no
// phone number to prove it. Decision 12 will not merge those by itself and
// should not; this is where the owner is asked.
export type MergeSuggestion = {
  from: { id: string; name: string }
  into: { id: string; name: string }
  reason: 'name'
}

// A plain, printable separator. It was a literal NUL byte, which made `grep`
// treat this whole file as binary and skip it — a file that ordinary tooling
// cannot read is a worse trade than a separator an external id could in
// principle contain. '|' appears in no Telegram user id and in no WhatsApp JID.
const pairKey = (telegramExternalId: string, whatsappExternalId: string) =>
  `${telegramExternalId}|${whatsappExternalId}`

// A dismissal outlives the two rows it was given about: merge, hide, delete and
// re-populate, and the same two IDENTITIES come back under fresh person ids. So
// "no" is remembered by the identities, which is what dismissed_suggestions has
// always stored — the person a suggestion is phrased in terms of is only how it
// is shown. The first identity is the one the person page lists first (channel,
// then link order), so the key is stable for as long as that link exists.
type SingleChannelPerson = {
  id: string; name: string; createdAt: Date
  channel: Channel; firstExternalId: string
}

async function singleChannelPeople(): Promise<SingleChannelPerson[]> {
  const rows = await db.select({
    id: people.id, name: people.name, createdAt: people.createdAt,
  }).from(people).where(isNull(people.archivedAt))
  if (rows.length === 0) return []
  const identities = await identitiesByPerson(rows.map(r => r.id))

  const out: SingleChannelPerson[] = []
  for (const r of rows) {
    const own = identities.get(r.id) ?? []
    if (own.length === 0) continue
    // Exactly one channel, or there is nothing to bridge: a person who already
    // holds both is not half of anything.
    const channels = new Set(own.map(i => i.channel))
    if (channels.size !== 1) continue
    out.push({ ...r, channel: own[0].channel, firstExternalId: own[0].externalId })
  }
  // Oldest first: `into` is the survivor of every pair below, and the older row
  // is the one the owner has had longer and the one already in any bookmark.
  return out.sort((a, b) =>
    a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
}

// Two people the owner might merge. Never acted on: an equal name is a hint and
// nothing more (decision 12), so it waits for the button. A pair the owner has
// dismissed is not offered again, and neither is one involving a hidden person
// — hiding is already an answer.
export async function listMergeSuggestions(): Promise<MergeSuggestion[]> {
  const candidates = await singleChannelPeople()
  const telegram = candidates.filter(c => c.channel === 'telegram')
  const whatsapp = candidates.filter(c => c.channel === 'whatsapp')
  if (telegram.length === 0 || whatsapp.length === 0) return []

  const dismissed = new Set((await db.select({
    telegramExternalId: dismissedSuggestions.telegramExternalId,
    whatsappExternalId: dismissedSuggestions.whatsappExternalId,
  }).from(dismissedSuggestions)).map(r => pairKey(r.telegramExternalId, r.whatsappExternalId)))

  const byName = new Map<string, SingleChannelPerson[]>()
  for (const w of whatsapp) {
    const key = nameKey(w.name)
    if (!key) continue
    const list = byName.get(key)
    if (list) list.push(w)
    else byName.set(key, [w])
  }

  const out: MergeSuggestion[] = []
  for (const t of telegram) {
    const key = nameKey(t.name)
    for (const w of (key ? byName.get(key) ?? [] : [])) {
      if (dismissed.has(pairKey(t.firstExternalId, w.firstExternalId))) continue
      // Both lists came out of one oldest-first sort, so this comparison is the
      // same one that ordered them.
      const [into, from] = t.createdAt.getTime() === w.createdAt.getTime()
        ? (t.id < w.id ? [t, w] : [w, t])
        : (t.createdAt < w.createdAt ? [t, w] : [w, t])
      out.push({
        from: { id: from.id, name: from.name },
        into: { id: into.id, name: into.name },
        reason: 'name',
      })
    }
  }
  return out
}

// The owner's "no, those two are different people", remembered by the two
// identities rather than by the two rows, so a re-population that rebuilds the
// rows does not ask again. Returns false when the pair is not one this instance
// can key — either side gone, hidden, or holding both channels already.
export async function dismissSuggestion(fromId: string, intoId: string): Promise<boolean> {
  if (!fromId || !intoId || fromId === intoId) return false
  const byId = new Map((await singleChannelPeople()).map(c => [c.id, c] as const))
  const from = byId.get(fromId)
  const into = byId.get(intoId)
  if (!from || !into || from.channel === into.channel) return false
  const telegram = from.channel === 'telegram' ? from : into
  const whatsapp = from.channel === 'whatsapp' ? from : into
  await db.insert(dismissedSuggestions)
    .values({
      telegramExternalId: telegram.firstExternalId,
      whatsappExternalId: whatsapp.firstExternalId,
    })
    .onConflictDoNothing()
  return true
}

// The owner's yes. It is a merge and nothing else: mergePeople re-checks that
// both rows are alive and unhidden inside its own transaction, so a stale form
// post — the pair already merged in another tab, one side hidden since the page
// rendered — moves nothing and says so.
export async function confirmSuggestion(fromId: string, intoId: string): Promise<boolean> {
  return mergePeople(fromId, intoId)
}

// The lookup every read path uses to put a name on a chat or a message. Id and
// name only: this instance's own uuid, never a channel identifier and never a
// phone number (people design decision 6).
export async function personForIdentity(ref: IdentityRef): Promise<{ id: string; name: string } | null> {
  const externalId = ref.externalId?.trim()
  if (!externalId) return null
  const [row] = await db.select({ id: people.id, name: people.name })
    .from(personIdentities)
    .innerJoin(people, eq(people.id, personIdentities.personId))
    .where(and(
      eq(personIdentities.channel, ref.channel),
      eq(personIdentities.externalId, externalId),
      // An archived person is nobody: their identity stays linked, but it
      // resolves to no name anywhere (decision 14).
      isNull(people.archivedAt),
    ))
    .limit(1)
  return row ?? null
}

// ---------------------------------------------------------------------------
// The self-populating half (people design addendum 2, decisions 11–13).
//
// Everything below runs unattended, after a contact sync, so it is deliberately
// timid about the one thing it cannot take back: deciding that two channel
// identities are the same human. Creating a person from a contact is
// bookkeeping — the name and the identity are already in the database, and the
// row only saves the owner from typing them. Merging two channels into one
// person is a claim about the world, so it needs the one identifier the two
// channels share (an equal phone number, decision 12). An equal NAME stays a
// suggestion, exactly as before.
// ---------------------------------------------------------------------------

// The name a channel currently gives a person, for every person at once: the
// contact cache is the only source (a chat title is a room's name, not a
// person's), and the identity that was linked first wins so the answer does
// not flip between two contact lists that disagree.
async function channelNamesFor(personIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (personIds.length === 0) return out
  const rows = await db.select({
    personId: personIdentities.personId,
    displayName: channelContacts.displayName,
    syncedAt: channelContacts.syncedAt,
    channel: personIdentities.channel,
    createdAt: personIdentities.createdAt,
    identityId: personIdentities.id,
  }).from(personIdentities)
    .innerJoin(channelContacts, and(
      eq(channelContacts.channel, personIdentities.channel),
      eq(channelContacts.externalId, personIdentities.externalId),
      isNotNull(channelContacts.displayName),
    ))
    .where(inArray(personIdentities.personId, personIds))

  // Same precedence as the identity list on the person page — channel, then
  // link order — and the most recent sync inside one identity.
  const sorted = [...rows].sort((a, b) =>
    a.channel.localeCompare(b.channel)
    || a.createdAt.getTime() - b.createdAt.getTime()
    || a.identityId.localeCompare(b.identityId)
    || b.syncedAt.getTime() - a.syncedAt.getTime())
  for (const r of sorted) {
    const name = r.displayName?.trim()
    if (name && !out.has(r.personId)) out.set(r.personId, clampName(name))
  }
  return out
}

// The owner's "no, use whatever the channel calls them". Sets the name back to
// following the contact list (decision 13) and applies it now rather than at
// the next sync, because a button that does nothing until the next six-hour
// window reads as a broken button.
export async function resetName(id: string): Promise<boolean> {
  const [row] = await db.select().from(people)
    .where(and(eq(people.id, id), isNull(people.archivedAt))).limit(1)
  if (!row) return false
  const name = (await channelNamesFor([id])).get(id)
  // The read above is not a lock: channelNamesFor is a join, and the owner (or
  // another tab) can hide this person while it runs. Every predicate the SELECT
  // relied on is repeated here, so a write that raced loses instead of
  // resurrecting a name on somebody who is no longer there.
  const rows = await db.update(people)
    .set({ nameSource: 'channel', name: name ?? row.name, updatedAt: new Date() })
    .where(and(eq(people.id, id), isNull(people.archivedAt)))
    .returning({ id: people.id })
  return rows.length > 0
}

// Decision 15. `into` keeps its name unless it is only a channel name and
// `from` carries the owner's alias, in which case the alias — the one name a
// human chose — survives the merge. Notes are carried over only into an empty
// box: `from` is hard-deleted here, and silently dropping something the owner
// wrote would be the one irreversible thing on this page.
//
// Nothing can collide: unique(channel, external_id) is on the identity, not on
// the pair, so re-pointing a person's identities never meets a duplicate.
//
// All four statements — the alive check included — run inside ONE transaction,
// and the web and the worker are two processes writing the same file. Without
// it, a portal merge and the worker's mergeByPhone can interleave on the same
// two rows: one re-points identities onto a person the other is about to
// delete, and `person_identities.person_id` is ON DELETE CASCADE, so the
// cascade would silently destroy the owner's links rather than just muddle a
// name. better-sqlite3 is synchronous, so this callback must not await and
// every statement in it ends in .all()/.run() instead.
export async function mergePeople(fromId: string, intoId: string): Promise<boolean> {
  if (!fromId || !intoId || fromId === intoId) return false
  return db.transaction(tx => {
    const rows = tx.select().from(people)
      .where(and(inArray(people.id, [fromId, intoId]), isNull(people.archivedAt))).all()
    const from = rows.find(r => r.id === fromId)
    const into = rows.find(r => r.id === intoId)
    if (!from || !into) return false

    tx.update(personIdentities).set({ personId: intoId })
      .where(eq(personIdentities.personId, fromId)).run()

    const values: Partial<typeof people.$inferInsert> = { updatedAt: new Date() }
    if (into.nameSource === 'channel' && from.nameSource === 'owner') {
      values.name = from.name
      values.nameSource = 'owner'
    }
    if (!into.notes && from.notes) values.notes = from.notes
    tx.update(people).set(values).where(eq(people.id, intoId)).run()
    tx.delete(people).where(eq(people.id, fromId)).run()
    return true
  })
}

// An identity's own copy of the name and the number goes stale the moment the
// owner renames a contact on their phone. Refreshed from the cache, never
// cleared by it: a contact list that has stopped reporting a number is a
// missing read, not a deletion.
//
// This is also what eventually makes decision 12 fire for a link made before
// the contact sync that first learned the number.
async function refreshIdentities(): Promise<void> {
  const rows = await db.select({
    identityId: personIdentities.id,
    displayName: personIdentities.displayName,
    phone: personIdentities.phone,
    contactName: channelContacts.displayName,
    contactPhone: channelContacts.phone,
    syncedAt: channelContacts.syncedAt,
  }).from(personIdentities)
    .innerJoin(channelContacts, and(
      eq(channelContacts.channel, personIdentities.channel),
      eq(channelContacts.externalId, personIdentities.externalId),
    ))

  const latest = new Map<string, typeof rows[number]>()
  for (const r of rows) {
    const seen = latest.get(r.identityId)
    if (!seen || r.syncedAt.getTime() > seen.syncedAt.getTime()) latest.set(r.identityId, r)
  }
  for (const r of latest.values()) {
    const values: Partial<typeof personIdentities.$inferInsert> = {}
    const name = cleanText(r.contactName)
    if (name && name !== r.displayName) values.displayName = name
    if (r.contactPhone && r.contactPhone !== r.phone) values.phone = r.contactPhone
    if (Object.keys(values).length === 0) continue
    await db.update(personIdentities).set(values).where(eq(personIdentities.id, r.identityId))
  }
}

// Decision 12, and the only automatic claim in this file: two identities on
// DIFFERENT channels carrying the same phone number are the same human, so the
// people holding them become one. The older person survives — they are the one
// the owner has had longer, and their id is the one already written into any
// bookmark — and mergePeople keeps an alias over a channel name.
//
// An archived person takes no part: their "no" holds, and merging their
// identity away would quietly undo it.
async function mergeByPhone(): Promise<number> {
  const rows = await db.select({
    personId: personIdentities.personId,
    channel: personIdentities.channel,
    phone: personIdentities.phone,
    createdAt: people.createdAt,
  }).from(personIdentities)
    .innerJoin(people, eq(people.id, personIdentities.personId))
    .where(and(isNotNull(personIdentities.phone), isNull(people.archivedAt)))

  type Group = { telegram: Set<string>; whatsapp: Set<string> }
  const groups = new Map<string, Group>()
  const born = new Map<string, number>()
  for (const r of rows) {
    if (!r.phone) continue
    let g = groups.get(r.phone)
    if (!g) groups.set(r.phone, g = { telegram: new Set(), whatsapp: new Set() })
    g[r.channel].add(r.personId)
    born.set(r.personId, r.createdAt.getTime())
  }

  let merged = 0
  for (const g of groups.values()) {
    // Both channels, or there is nothing to bridge: two Telegram accounts
    // sharing a number is not what decision 12 is about.
    if (g.telegram.size === 0 || g.whatsapp.size === 0) continue
    const ids = [...new Set([...g.telegram, ...g.whatsapp])]
    if (ids.length < 2) continue
    ids.sort((a, b) => (born.get(a) ?? 0) - (born.get(b) ?? 0) || a.localeCompare(b))
    const [survivor, ...rest] = ids
    for (const id of rest) if (await mergePeople(id, survivor)) merged++
  }
  return merged
}

// Decision 13's "no sync overwrites an alias", enforced at the WRITE and not
// only at the read. The gap between the SELECT below and each UPDATE spans a
// join plus a loop of writes, and the web and the worker are two processes: in
// that window the owner can type an alias on /people/<id>, and a blind
// `where id = ?` would land on top of it and leave the row claiming the owner
// chose the channel's name — destroyed silently and never corrected by a later
// sync. Repeating both predicates in the WHERE makes the racing write a no-op.
async function refreshChannelNames(): Promise<number> {
  const rows = await db.select({ id: people.id, name: people.name }).from(people)
    .where(and(eq(people.nameSource, 'channel'), isNull(people.archivedAt)))
    // Oldest first, so the loop below runs in the same order every time rather
    // than in whatever order the planner happens to return.
    .orderBy(asc(people.createdAt), asc(people.id))
  const names = await channelNamesFor(rows.map(r => r.id))
  let renamed = 0
  for (const r of rows) {
    const next = names.get(r.id)
    if (!next || next === r.name) continue
    const written = await db.update(people).set({ name: next, updatedAt: new Date() })
      .where(and(
        eq(people.id, r.id),
        eq(people.nameSource, 'channel'),
        isNull(people.archivedAt),
      ))
      .returning({ id: people.id })
    // Counted from what actually landed, so a lost race is not reported as a
    // rename that happened.
    if (written.length > 0) renamed++
  }
  return renamed
}

// Decision 14, on the channel the owner had not paired yet. Hiding someone
// keeps their identity links, and that is what stops the next sync recreating
// them — but only on the channels they were already linked on. Pair WhatsApp
// weeks after hiding a Telegram-only person and their JID arrives with no
// person at all, so the populater would make a fresh, VISIBLE row and their
// "no" would be undone through a door they did not know existed. mergeByPhone
// cannot repair it afterwards: it excludes archived people by design.
//
// So the same phone number that would have merged the two people is used one
// step earlier, to decide the new identity belongs to the hidden person. The
// number is the only identifier the two channels share (decision 12); nothing
// weaker is allowed to reach an archived row.
async function archivedPeopleByPhone(): Promise<Map<string, string>> {
  const rows = await db.select({
    personId: personIdentities.personId,
    phone: personIdentities.phone,
    createdAt: people.createdAt,
  }).from(personIdentities)
    .innerJoin(people, eq(people.id, personIdentities.personId))
    .where(and(isNotNull(personIdentities.phone), isNotNull(people.archivedAt)))

  const out = new Map<string, string>()
  // Oldest first, so a number two hidden people somehow share resolves the
  // same way on every run.
  for (const r of [...rows].sort((a, b) =>
    a.createdAt.getTime() - b.createdAt.getTime() || a.personId.localeCompare(b.personId))) {
    if (r.phone && !out.has(r.phone)) out.set(r.phone, r.personId)
  }
  return out
}

export type PopulateResult = { created: number; merged: number; renamed: number }

// Decision 11, called by the worker after every contact sync. Idempotent: the
// second run over an unchanged archive creates nothing, merges nothing and
// renames nothing.
//
// Only `contact` and `dm` identities become people. A `sender` is someone who
// spoke in a group the owner is in — a name in a room, not a correspondent —
// and turning every one of them into an address book entry would bury the
// people the owner actually talks to. They stay linkable by hand.
export async function populatePeople(): Promise<PopulateResult> {
  const channels: Channel[] = ['telegram', 'whatsapp']
  const hiddenByPhone = await archivedPeopleByPhone()
  let created = 0
  for (const channel of channels) {
    for (const c of await listIdentityCandidates(channel)) {
      // personId is set for an ARCHIVED person's identity too, which is
      // exactly why "hidden" stays hidden across syncs (decision 14).
      if (c.personId !== null || c.kind === 'sender') continue
      const name = c.displayName?.trim()
      if (!name) continue
      // Somebody the owner hid, arriving on a second channel. Their "no" meant
      // the person, not the account, so the identity joins them where they are
      // rather than becoming a visible row of their own.
      const hidden = c.phone ? hiddenByPhone.get(c.phone) : undefined
      if (hidden) {
        await linkIdentity(
          hidden, { channel, externalId: c.externalId, displayName: c.displayName, phone: c.phone }, 'auto',
        )
        continue
      }
      const { id } = await createPerson({ name: clampName(name), nameSource: 'channel' })
      const linked = await linkIdentity(
        id, { channel, externalId: c.externalId, displayName: c.displayName, phone: c.phone }, 'auto',
      )
      // Lost a race with another writer for this identity. The person we just
      // made has nothing in it, so it goes rather than sitting there empty.
      if (!linked.ok) {
        await db.delete(people).where(eq(people.id, id))
        continue
      }
      created++
    }
  }
  await refreshIdentities()
  const merged = await mergeByPhone()
  const renamed = await refreshChannelNames()
  return { created, merged, renamed }
}
