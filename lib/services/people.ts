import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import {
  channelContacts, chats, dismissedSuggestions, messages, people, personIdentities,
} from '@/lib/db/schema'
import type { Channel } from '@/lib/channels/port'

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
// Phone numbers live in this file and in the database, never in a log
// (invariant: log through lib/log with errorShape only) and never in an agent
// response (that mapping is Task 6's).

export type IdentityRef = { channel: Channel; externalId: string }
export type IdentitySource = 'manual' | 'phone_match' | 'name_match'

// What a channel binding hands back from listContacts(). `phone` is +digits
// or null; syncContacts normalises anything looser.
export type ChannelContact = { externalId: string; displayName: string | null; phone: string | null }

export type PersonView = {
  id: string
  name: string
  notes: string | null
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
  const out = new Map<string, number>(personIds.map(id => [id, 0]))
  if (personIds.length === 0) return out

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

  const seen = new Map<string, Set<string>>()
  for (const row of [...dmRows, ...senderRows]) {
    let set = seen.get(row.personId)
    if (!set) seen.set(row.personId, set = new Set())
    set.add(row.chatId)
  }
  for (const id of personIds) out.set(id, seen.get(id)?.size ?? 0)
  return out
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
    identities: identities.get(r.id) ?? [], chatCount: counts.get(r.id) ?? 0,
  }))
}

export async function listPeople(): Promise<PersonView[]> {
  // lower() so 'ada' and 'Ada' sort together; SQLite's default byte order puts
  // every capital before every lower-case letter, which reads as random.
  const rows = await db.select().from(people).orderBy(asc(sql`lower(${people.name})`), asc(people.id))
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
}

export async function publicPeople(): Promise<PublicPerson[]> {
  return (await listPeople()).map(p => ({
    id: p.id,
    name: p.name,
    notes: p.notes,
    channels: [...new Set(p.identities.map(i => i.channel))].sort(),
    chatCount: p.chatCount,
  }))
}

export async function getPerson(id: string): Promise<PersonView | null> {
  const rows = await db.select().from(people).where(eq(people.id, id)).limit(1)
  if (rows.length === 0) return null
  return (await toViews(rows))[0]
}

export async function createPerson(input: { name: string; notes?: string | null }): Promise<{ id: string }> {
  const [row] = await db.insert(people)
    .values({ name: cleanName(input.name), notes: cleanText(input.notes) })
    .returning({ id: people.id })
  return { id: row.id }
}

// Absent field = leave alone, `notes: null` = clear it. Returns false when
// there is no such person, so a caller acting on a stale page gets a "gone"
// rather than a silent success.
export async function updatePerson(
  id: string, input: { name?: string; notes?: string | null },
): Promise<boolean> {
  const values: Partial<typeof people.$inferInsert> = {}
  if (input.name !== undefined) values.name = cleanName(input.name)
  if ('notes' in input) values.notes = cleanText(input.notes)
  if (Object.keys(values).length === 0) {
    const rows = await db.select({ id: people.id }).from(people).where(eq(people.id, id)).limit(1)
    return rows.length > 0
  }
  values.updatedAt = new Date()
  const rows = await db.update(people).set(values).where(eq(people.id, id)).returning({ id: people.id })
  return rows.length > 0
}

// Deletes the person and, by cascade, its identity rows. Chats and messages
// are untouched: the address book is an annotation over the archive, never a
// part of it (people design decision 7).
export async function deletePerson(id: string): Promise<boolean> {
  const rows = await db.delete(people).where(eq(people.id, id)).returning({ id: people.id })
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

  const dmRows = await db.select({ externalId: chats.externalChatId, displayName: chats.title })
    .from(chats).where(and(eq(chats.channel, channel), eq(chats.kind, 'dm')))

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
  for (const r of dmRows) put(r.externalId, r.displayName, null, 'dm')
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

export type Suggestion = { telegram: IdentityCandidate; whatsapp: IdentityCandidate; reason: 'phone' | 'name' }

const pairKey = (telegramExternalId: string, whatsappExternalId: string) =>
  `${telegramExternalId} ${whatsappExternalId}`

const nameKey = (name: string | null): string | null => {
  const n = name?.trim().toLowerCase()
  return n ? n : null
}

function matchReason(telegram: IdentityCandidate, whatsapp: IdentityCandidate): Suggestion['reason'] | null {
  // The phone number is the only identifier the two channels share, so it is
  // the only strong signal; an equal display name is a hint, and both are
  // shown to the owner rather than acted on.
  if (telegram.phone && telegram.phone === whatsapp.phone) return 'phone'
  const t = nameKey(telegram.displayName)
  if (t && t === nameKey(whatsapp.displayName)) return 'name'
  return null
}

// Pairs the owner might want to merge, strongest first. Never includes an
// identity that already belongs to a person (it has an answer), nor a pair the
// owner has dismissed (they have given one).
export async function listSuggestions(): Promise<Suggestion[]> {
  const telegram = (await listIdentityCandidates('telegram')).filter(c => c.personId === null)
  const whatsapp = (await listIdentityCandidates('whatsapp')).filter(c => c.personId === null)
  if (telegram.length === 0 || whatsapp.length === 0) return []

  const dismissed = new Set((await db.select({
    telegramExternalId: dismissedSuggestions.telegramExternalId,
    whatsappExternalId: dismissedSuggestions.whatsappExternalId,
  }).from(dismissedSuggestions)).map(r => pairKey(r.telegramExternalId, r.whatsappExternalId)))

  const byPhone = new Map<string, IdentityCandidate[]>()
  const byName = new Map<string, IdentityCandidate[]>()
  const bucket = (m: Map<string, IdentityCandidate[]>, key: string | null, c: IdentityCandidate) => {
    if (!key) return
    const list = m.get(key)
    if (list) list.push(c)
    else m.set(key, [c])
  }
  for (const w of whatsapp) {
    bucket(byPhone, w.phone, w)
    bucket(byName, nameKey(w.displayName), w)
  }

  const out: Suggestion[] = []
  const taken = new Set<string>()
  const add = (t: IdentityCandidate, w: IdentityCandidate, reason: Suggestion['reason']) => {
    const key = pairKey(t.externalId, w.externalId)
    if (taken.has(key) || dismissed.has(key)) return
    taken.add(key)
    out.push({ telegram: t, whatsapp: w, reason })
  }

  // Phone matches first, so a pair that matches both ways is offered as the
  // stronger one; `telegram` is already sorted by name, and that order carries.
  for (const t of telegram) for (const w of (t.phone ? byPhone.get(t.phone) ?? [] : [])) add(t, w, 'phone')
  for (const t of telegram) {
    const n = nameKey(t.displayName)
    for (const w of (n ? byName.get(n) ?? [] : [])) add(t, w, 'name')
  }
  return out
}

export async function dismissSuggestion(
  telegramExternalId: string, whatsappExternalId: string,
): Promise<void> {
  await db.insert(dismissedSuggestions)
    .values({ telegramExternalId, whatsappExternalId })
    .onConflictDoNothing()
}

// The owner's yes. Creates the person and links both sides with the source
// that names how the pair was found, so the address book records that this
// link came from a confirmed phone (or name) match rather than a hand entry.
// Returns null when either side has since been linked, or when the two no
// longer match at all — a stale form post must not invent a person.
export async function confirmSuggestion(
  telegramExternalId: string, whatsappExternalId: string,
): Promise<{ id: string } | null> {
  const telegram = (await listIdentityCandidates('telegram')).find(c => c.externalId === telegramExternalId)
  const whatsapp = (await listIdentityCandidates('whatsapp')).find(c => c.externalId === whatsappExternalId)
  if (!telegram || !whatsapp) return null
  if (telegram.personId !== null || whatsapp.personId !== null) return null

  const reason = matchReason(telegram, whatsapp)
  if (!reason) return null
  const source: IdentitySource = reason === 'phone' ? 'phone_match' : 'name_match'

  const name = clampName(
    telegram.displayName ?? whatsapp.displayName ?? telegram.phone ?? whatsapp.phone ?? telegram.externalId,
  )
  const { id } = await createPerson({ name })
  await linkIdentity(id, {
    channel: 'telegram', externalId: telegram.externalId,
    displayName: telegram.displayName, phone: telegram.phone,
  }, source)
  await linkIdentity(id, {
    channel: 'whatsapp', externalId: whatsapp.externalId,
    displayName: whatsapp.displayName, phone: whatsapp.phone,
  }, source)
  return { id }
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
    .where(and(eq(personIdentities.channel, ref.channel), eq(personIdentities.externalId, externalId)))
    .limit(1)
  return row ?? null
}
