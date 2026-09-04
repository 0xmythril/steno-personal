import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { channelContacts, chats, connections, messages, people, personIdentities } from '@/lib/db/schema'
import { resetDb } from './helpers/db'
import { makeConnection, makeChat, addMessage } from './helpers/fixtures'
import {
  archivePerson, confirmSuggestion, createPerson, dismissSuggestion, getPerson,
  linkIdentity, listArchivedPeople, listIdentityCandidates, listMergeSuggestions, listPeople,
  mergePeople, personForIdentity, populatePeople, publicPeople, resetName, restorePerson,
  syncContacts, unlinkIdentity, updatePerson,
} from '@/lib/services/people'

const ADA_JID = '447700900123@s.whatsapp.net'
const GRACE_JID = '447700900999@s.whatsapp.net'

describe('people', () => {
  beforeEach(resetDb)

  it('creates, reads, renames and hides a person', async () => {
    const { id } = await createPerson({ name: '  Ada  ', notes: '   ' })
    const person = await getPerson(id)
    expect(person).toMatchObject({ name: 'Ada', notes: null, identities: [], chatCount: 0 })

    await createPerson({ name: 'bob' })
    // lower-cased sort, so 'bob' does not jump ahead of 'Ada' on byte order
    expect((await listPeople()).map(p => p.name)).toEqual(['Ada', 'bob'])

    expect(await updatePerson(id, { name: 'Ada L', notes: 'from the archive' })).toBe(true)
    expect(await getPerson(id)).toMatchObject({ name: 'Ada L', notes: 'from the archive' })
    expect(await updatePerson(id, { notes: null })).toBe(true)
    expect((await getPerson(id))!.notes).toBeNull()
    expect(await updatePerson('no-such-person', { name: 'x' })).toBe(false)

    expect(await archivePerson(id)).toBe(true)
    // Archiving twice is one answer given twice, not two.
    expect(await archivePerson(id)).toBe(false)
    expect(await getPerson(id)).toBeNull()
  })

  it('refuses an empty or oversized name', async () => {
    await expect(createPerson({ name: '   ' })).rejects.toThrow(RangeError)
    await expect(createPerson({ name: 'x'.repeat(101) })).rejects.toThrow(RangeError)
    const { id } = await createPerson({ name: 'x'.repeat(100) })
    await expect(updatePerson(id, { name: '' })).rejects.toThrow(RangeError)
  })

  it('links an identity once and unlinks it by id', async () => {
    const { id } = await createPerson({ name: 'Ada' })
    expect(await linkIdentity(id, {
      channel: 'telegram', externalId: '42', displayName: ' Ada ', phone: '+44 7700 900123',
    })).toEqual({ ok: true })

    const [identity] = (await getPerson(id))!.identities
    expect(identity).toMatchObject({
      channel: 'telegram', externalId: '42', displayName: 'Ada',
      phone: '+447700900123', source: 'manual',
    })

    // unique(channel, external_id): the same person, and another person, both
    // get already_linked rather than a second row.
    expect(await linkIdentity(id, { channel: 'telegram', externalId: '42' }))
      .toEqual({ ok: false, reason: 'already_linked' })
    const other = await createPerson({ name: 'Bob' })
    expect(await linkIdentity(other.id, { channel: 'telegram', externalId: '42' }))
      .toEqual({ ok: false, reason: 'already_linked' })
    expect(await db.select().from(personIdentities)).toHaveLength(1)

    expect(await linkIdentity('no-such-person', { channel: 'telegram', externalId: '7' }))
      .toEqual({ ok: false, reason: 'no_person' })

    expect(await unlinkIdentity(identity.id)).toBe(true)
    expect(await unlinkIdentity(identity.id)).toBe(false)
    expect((await getPerson(id))!.identities).toEqual([])
  })

  it('derives a phone number from a WhatsApp JID when the caller has none', async () => {
    const { id } = await createPerson({ name: 'Ada' })
    await linkIdentity(id, { channel: 'whatsapp', externalId: ADA_JID })
    expect((await getPerson(id))!.identities[0].phone).toBe('+447700900123')

    const { id: group } = await createPerson({ name: 'Some group' })
    await linkIdentity(group, { channel: 'whatsapp', externalId: '12345-67@g.us' })
    expect((await getPerson(group))!.identities[0].phone).toBeNull()
  })

  it('counts the chats a person appears in, by DM and by sender', async () => {
    const tg = await makeConnection({ channel: 'telegram' })
    const dm = await makeChat(tg, { kind: 'dm', externalChatId: '42', title: 'Ada' })
    await addMessage(dm, { senderExternalId: '42' })
    const group = await makeChat(tg, { kind: 'group', externalChatId: '-100', title: 'Group' })
    await addMessage(group, { senderExternalId: '42' })
    await addMessage(group, { senderExternalId: '42' })
    const quiet = await makeChat(tg, { kind: 'group', externalChatId: '-200', title: 'Quiet' })
    // an unsent message keeps nobody in a chat
    await addMessage(quiet, { senderExternalId: '42', deletedAt: new Date() })
    // …and neither does the owner's own line
    await addMessage(quiet, { senderExternalId: '42', fromOwner: true })
    // a WhatsApp chat with the same external id is a different identity
    const wa = await makeConnection({ channel: 'whatsapp' })
    await makeChat(wa, { kind: 'dm', externalChatId: '42', title: 'Not Ada' })

    const { id } = await createPerson({ name: 'Ada' })
    await linkIdentity(id, { channel: 'telegram', externalId: '42' })
    expect((await getPerson(id))!.chatCount).toBe(2)
    expect((await listPeople())[0].chatCount).toBe(2)
  })

  it('upserts contacts for a connection and normalises the phone number', async () => {
    const conn = await makeConnection({ channel: 'telegram' })
    expect(await syncContacts(conn.id, 'telegram', [
      { externalId: '42', displayName: ' Ada ', phone: '+44 7700 900123' },
      { externalId: '43', displayName: null, phone: '' },
      { externalId: '42', displayName: 'a repeat in the same batch', phone: null },
    ])).toEqual({ upserted: 2 })

    const rows = await db.select().from(channelContacts).orderBy(channelContacts.externalId)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ externalId: '42', displayName: 'Ada', phone: '+447700900123' })
    expect(rows[1]).toMatchObject({ externalId: '43', displayName: null, phone: null })

    expect(await syncContacts(conn.id, 'telegram', [
      { externalId: '42', displayName: 'Ada Lovelace', phone: '+44-7700-900123' },
    ])).toEqual({ upserted: 1 })
    const after = await db.select().from(channelContacts).where(eq(channelContacts.externalId, '42'))
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ displayName: 'Ada Lovelace', phone: '+447700900123' })
    // the contact the second sync did not mention is kept, not deleted
    expect(await db.select().from(channelContacts)).toHaveLength(2)
  })

  it('offers every identity once, contact name first, with the person it belongs to', async () => {
    const tg = await makeConnection({ channel: 'telegram' })
    await syncContacts(tg.id, 'telegram', [{ externalId: '42', displayName: 'Ada', phone: '+447700900123' }])
    const dm = await makeChat(tg, { kind: 'dm', externalChatId: '42', title: 'Ada (chat subject)' })
    await addMessage(dm, { senderExternalId: '42', senderName: 'Ada (message)' })
    const group = await makeChat(tg, { kind: 'group', externalChatId: '-100', title: 'Group' })
    await addMessage(group, { senderExternalId: '99', senderName: 'Zed', sentAt: new Date(1) })
    await addMessage(group, { senderExternalId: '99', senderName: 'Zed renamed', sentAt: new Date(2) })
    await addMessage(group, { senderExternalId: null, senderName: 'nobody' })
    await addMessage(group, { senderExternalId: '7', senderName: 'Owner', fromOwner: true })

    const candidates = await listIdentityCandidates('telegram')
    expect(candidates.map(c => c.externalId)).toEqual(['42', '99'])
    expect(candidates[0]).toEqual({
      channel: 'telegram', externalId: '42', displayName: 'Ada',
      phone: '+447700900123', kind: 'contact', personId: null,
    })
    // the most recent name a sender wrote under, and no phone for Telegram
    // outside the contact list
    expect(candidates[1]).toMatchObject({ displayName: 'Zed renamed', kind: 'sender', phone: null })

    const { id } = await createPerson({ name: 'Ada' })
    await linkIdentity(id, { channel: 'telegram', externalId: '42' })
    expect((await listIdentityCandidates('telegram'))[0].personId).toBe(id)
  })

  it('reads a WhatsApp candidate phone number out of the JID', async () => {
    const wa = await makeConnection({ channel: 'whatsapp' })
    await makeChat(wa, { kind: 'dm', externalChatId: ADA_JID, title: null })
    const [candidate] = await listIdentityCandidates('whatsapp')
    expect(candidate).toMatchObject({
      externalId: ADA_JID, displayName: null, phone: '+447700900123', kind: 'dm',
    })
  })

  it('deleting a connection drops its contact cache and keeps the person links', async () => {
    const tg = await makeConnection({ channel: 'telegram' })
    await syncContacts(tg.id, 'telegram', [{ externalId: '42', displayName: 'Ada', phone: '+447700900123' }])
    const { id } = await createPerson({ name: 'Ada' })
    await linkIdentity(id, { channel: 'telegram', externalId: '42' })

    await db.delete(connections).where(eq(connections.id, tg.id))
    expect(await db.select().from(channelContacts)).toEqual([])
    // the address book is the owner's own annotation, not the channel's
    expect((await getPerson(id))!.identities).toHaveLength(1)
  })

  it('answers who an identity is, and only for an exact channel and id', async () => {
    const { id } = await createPerson({ name: 'Ada' })
    await linkIdentity(id, { channel: 'telegram', externalId: '42' })
    expect(await personForIdentity({ channel: 'telegram', externalId: '42' })).toEqual({ id, name: 'Ada' })
    expect(await personForIdentity({ channel: 'whatsapp', externalId: '42' })).toBeNull()
    expect(await personForIdentity({ channel: 'telegram', externalId: '43' })).toBeNull()
  })

  it('hiding a person keeps their links and leaves the archive alone', async () => {
    const tg = await makeConnection({ channel: 'telegram' })
    const dm = await makeChat(tg, { kind: 'dm', externalChatId: '42', title: 'Ada' })
    await addMessage(dm, { senderExternalId: '42', text: 'still here' })
    const { id } = await createPerson({ name: 'Ada' })
    await linkIdentity(id, { channel: 'telegram', externalId: '42' })

    expect(await archivePerson(id)).toBe(true)
    // The identity row stays — it is the record of "not this one", and
    // without it the next contact sync would make the person again
    // (addendum 2, decision 14) — and the chats and messages never moved.
    expect(await db.select().from(personIdentities)).toHaveLength(1)
    expect(await db.select().from(chats)).toHaveLength(1)
    const rows = await db.select().from(messages)
    expect(rows).toHaveLength(1)
    expect(rows[0].text).toBe('still here')
  })
})

describe('publicPeople — the one mapping both agent surfaces use', () => {
  beforeEach(resetDb)

  it('carries the id, name, notes, channels, chat count and the chats themselves, and nothing else', async () => {
    const tg = await makeConnection({ channel: 'telegram' })
    const dm = await makeChat(tg, { kind: 'dm', externalChatId: '42', title: 'Ada' })
    await addMessage(dm, { senderExternalId: '42', text: 'hello' })

    const { id } = await createPerson({ name: 'Ada', notes: 'from the archive' })
    await linkIdentity(id, {
      channel: 'telegram', externalId: '42', displayName: 'Ada', phone: '+44 7700 900123',
    })
    await linkIdentity(id, { channel: 'whatsapp', externalId: ADA_JID, displayName: 'Ada' })

    const [person] = await publicPeople()
    expect(person).toEqual({
      id, name: 'Ada', notes: 'from the archive',
      channels: ['telegram', 'whatsapp'], chatCount: 1,
      // The chat under the title the chat list shows, with nothing but the
      // fields an agent can act on: the id get_messages takes, and how to
      // recognise it. No external id, no phone.
      chats: [{ id: dm.id, title: 'Ada', channel: 'telegram', kind: 'dm' }],
    })
    expect(Object.keys(person).sort()).toEqual(['channels', 'chatCount', 'chats', 'id', 'name', 'notes'])
    expect(Object.keys(person.chats[0]).sort()).toEqual(['channel', 'id', 'kind', 'title'])
  })

  it('never serves a phone number or a channel identifier, however the person was linked', async () => {
    // The whole point of the mapping: PersonView carries `phone`, `externalId`
    // and each identity's channel display name, and an agent gets none of the
    // three (people design decision 6). A WhatsApp JID *is* a phone number, so
    // leaking the identity would leak the number even with `phone` dropped.
    const { id } = await createPerson({ name: 'Ada' })
    await linkIdentity(id, { channel: 'telegram', externalId: '42', phone: '+447700900123' })
    await linkIdentity(id, { channel: 'whatsapp', externalId: ADA_JID })
    const grace = await createPerson({ name: 'Grace' })
    await linkIdentity(grace.id, { channel: 'whatsapp', externalId: GRACE_JID })

    const json = JSON.stringify(await publicPeople())
    expect(json).not.toMatch(/\+\d/)
    expect(json).not.toContain('@s.whatsapp.net')
    expect(json).not.toContain('447700900123')
    expect(json).not.toContain('447700900999')
    expect(json).not.toContain('externalId')
    expect(json).not.toContain('phone')
  })

  it('lists each channel once, sorted, and an unlinked person as an empty list', async () => {
    const { id } = await createPerson({ name: 'Ada' })
    await linkIdentity(id, { channel: 'telegram', externalId: '42' })
    await linkIdentity(id, { channel: 'telegram', externalId: '43' })
    await createPerson({ name: 'Bob' })

    expect((await publicPeople()).map(p => p.channels)).toEqual([['telegram'], []])
  })
})

// Addendum 2: the address book fills itself in after every contact sync. The
// line these tests hold is the one the spec draws — recording a name the
// archive already has is bookkeeping and happens by itself; deciding that two
// channels are one human needs an equal phone number, and nothing here may
// undo an answer the owner gave.
describe('the self-populating address book', () => {
  beforeEach(resetDb)

  it('creates a person for every named contact and DM, never for a group sender', async () => {
    const tg = await makeConnection({ channel: 'telegram' })
    await syncContacts(tg.id, 'telegram', [
      { externalId: '42', displayName: 'Ada', phone: '+447700900123' },
      // Nameless: there is nothing to call them, so there is no person.
      { externalId: '43', displayName: null, phone: null },
    ])
    const dm = await makeChat(tg, { kind: 'dm', externalChatId: '50', title: 'Grace' })
    await addMessage(dm, { senderExternalId: '50' })
    // Someone who has only ever spoken in a room the owner is in. A name in a
    // group is not a correspondent, and the address book stays the owner's.
    const group = await makeChat(tg, { kind: 'group', externalChatId: '-100', title: 'Team' })
    await addMessage(group, { senderExternalId: '99', senderName: 'Loud In A Room' })

    expect(await populatePeople()).toEqual({ created: 2, merged: 0, renamed: 0 })
    expect((await listPeople()).map(p => p.name)).toEqual(['Ada', 'Grace'])

    const [ada] = await listPeople()
    expect(ada.nameSource).toBe('channel')
    expect(ada.identities[0]).toMatchObject({
      channel: 'telegram', externalId: '42', source: 'auto', phone: '+447700900123',
    })

    // Idempotent: the second run over an unchanged archive does nothing.
    expect(await populatePeople()).toEqual({ created: 0, merged: 0, renamed: 0 })
    expect(await listPeople()).toHaveLength(2)
  })

  // A WhatsApp history sync can leave the OWNER'S own display name in a direct
  // chat's title — it is the wrong side of the conversation, which is why
  // queries.ts titles a DM with nullif(title, ownerDisplayName). Creating a
  // person from that title would do worse than bypass the guard: a person row
  // wins the read path's coalesce ahead of it, so every message the
  // counterparty ever sent would be labelled with the owner's name, and
  // list_people would serve the owner back to an agent as a correspondent.
  it('never names anyone after the owner, however the DM title was written', async () => {
    const wa = await makeConnection({ channel: 'whatsapp', displayName: 'Cham' })
    await makeChat(wa, { kind: 'dm', externalChatId: ADA_JID, title: '  cham  ' })
    const tg = await makeConnection({ channel: 'telegram', displayName: 'Cham' })
    await makeChat(tg, { kind: 'dm', externalChatId: '42', title: 'Cham' })
    // Someone genuinely called something else is still a person, so the rule is
    // narrow rather than "skip DMs".
    await makeChat(tg, { kind: 'dm', externalChatId: '43', title: 'Grace' })

    expect((await listIdentityCandidates('whatsapp'))[0])
      .toMatchObject({ externalId: ADA_JID, displayName: null, kind: 'dm' })
    expect(await populatePeople()).toMatchObject({ created: 1 })
    expect((await listPeople()).map(p => p.name)).toEqual(['Grace'])
  })

  // …and the counterparty's own sender name is still the right name for them,
  // so dropping the title is a fallback and not a refusal.
  it('falls back to the counterparty\'s own name when the title was the owner\'s', async () => {
    const tg = await makeConnection({ channel: 'telegram', displayName: 'Cham' })
    const dm = await makeChat(tg, { kind: 'dm', externalChatId: '42', title: 'Cham' })
    await addMessage(dm, { senderExternalId: '42', senderName: 'Ada' })

    expect(await populatePeople()).toMatchObject({ created: 1 })
    expect((await listPeople()).map(p => p.name)).toEqual(['Ada'])
  })

  it('merges by phone into the older person, and the alias the owner typed wins', async () => {
    const older = await createPerson({ name: 'Ada', nameSource: 'channel' })
    await linkIdentity(older.id, { channel: 'telegram', externalId: '42', phone: '+44 7700 900123' })
    // Younger, but this is the name a human chose (createPerson's default).
    const younger = await createPerson({ name: 'Ada Lovelace' })
    await linkIdentity(younger.id, { channel: 'whatsapp', externalId: ADA_JID })
    await db.update(people).set({ createdAt: new Date(1000) }).where(eq(people.id, older.id))
    await db.update(people).set({ createdAt: new Date(2000) }).where(eq(people.id, younger.id))

    expect(await populatePeople()).toMatchObject({ created: 0, merged: 1 })
    const all = await listPeople()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ id: older.id, name: 'Ada Lovelace', nameSource: 'owner' })
    expect(all[0].identities.map(i => [i.channel, i.externalId])).toEqual([
      ['telegram', '42'], ['whatsapp', ADA_JID],
    ])
    expect(await populatePeople()).toMatchObject({ merged: 0 })
  })

  it('never merges two people who only share a name', async () => {
    const tg = await makeConnection({ channel: 'telegram' })
    const wa = await makeConnection({ channel: 'whatsapp' })
    await syncContacts(tg.id, 'telegram', [{ externalId: '42', displayName: 'Ada', phone: null }])
    await syncContacts(wa.id, 'whatsapp', [{ externalId: GRACE_JID, displayName: 'Ada', phone: null }])

    expect(await populatePeople()).toMatchObject({ created: 2, merged: 0 })
    const all = await listPeople()
    expect(all).toHaveLength(2)
    const onTelegram = all.find(p => p.identities[0].channel === 'telegram')!
    const onWhatsapp = all.find(p => p.identities[0].channel === 'whatsapp')!
    // The two rows are the same age to the millisecond here; pin them so the
    // survivor is the one the rule names and not the one the clock happened to
    // pick.
    await db.update(people).set({ createdAt: new Date(1000) }).where(eq(people.id, onWhatsapp.id))
    await db.update(people).set({ createdAt: new Date(2000) }).where(eq(people.id, onTelegram.id))

    // It stays what it always was: something to OFFER the owner. Two rows, and
    // a suggestion that says so — not silence, and not a merge.
    expect(await listMergeSuggestions()).toEqual([{
      from: { id: onTelegram.id, name: 'Ada' },
      into: { id: onWhatsapp.id, name: 'Ada' },
      reason: 'name',
    }])
  })

  it('a channel name follows the contact list; an alias never moves', async () => {
    const tg = await makeConnection({ channel: 'telegram' })
    await syncContacts(tg.id, 'telegram', [
      { externalId: '42', displayName: 'Ada', phone: null },
      { externalId: '43', displayName: 'Grace', phone: null },
    ])
    expect(await populatePeople()).toMatchObject({ created: 2 })
    const grace = (await listPeople()).find(p => p.name === 'Grace')!
    expect(await updatePerson(grace.id, { name: 'Rear Admiral Hopper' })).toBe(true)
    expect((await getPerson(grace.id))!.nameSource).toBe('owner')

    await syncContacts(tg.id, 'telegram', [
      { externalId: '42', displayName: 'Ada Lovelace', phone: null },
      { externalId: '43', displayName: 'Grace Hopper', phone: null },
    ])
    expect(await populatePeople()).toMatchObject({ created: 0, renamed: 1 })
    expect((await listPeople()).map(p => p.name)).toEqual(['Ada Lovelace', 'Rear Admiral Hopper'])
    // The identity's own copy of the name is refreshed too, so the person
    // page does not show a label the channel stopped using.
    expect((await getPerson(grace.id))!.identities[0].displayName).toBe('Grace Hopper')

    // …and the owner can hand the name back to the channel.
    expect(await resetName(grace.id)).toBe(true)
    expect(await getPerson(grace.id)).toMatchObject({ name: 'Grace Hopper', nameSource: 'channel' })
  })

  // Decision 13's hard case: the worker's refresh is a SELECT, then a join,
  // then a loop of writes, and the owner types an alias somewhere in the middle
  // of it. A trigger is the only way to land that write at a moment a test can
  // pin — it fires inside the loop, between the read that saw Ada as
  // channel-named and the write that would have renamed her.
  it('never renames a person the owner aliased while the refresh was running', async () => {
    const tg = await makeConnection({ channel: 'telegram' })
    await syncContacts(tg.id, 'telegram', [
      { externalId: '41', displayName: 'Aaa', phone: null },
      { externalId: '42', displayName: 'Ada', phone: null },
    ])
    expect(await populatePeople()).toMatchObject({ created: 2 })
    const aaa = (await listPeople()).find(p => p.name === 'Aaa')!
    const ada = (await listPeople()).find(p => p.name === 'Ada')!
    // The loop goes oldest first, so Aaa is written before Ada is reached.
    await db.update(people).set({ createdAt: new Date(1000) }).where(eq(people.id, aaa.id))
    await db.update(people).set({ createdAt: new Date(2000) }).where(eq(people.id, ada.id))
    await syncContacts(tg.id, 'telegram', [
      { externalId: '41', displayName: 'Aaa Two', phone: null },
      { externalId: '42', displayName: 'Ada Lovelace', phone: null },
    ])

    // SQLite refuses bound parameters inside a trigger, so the two ids are
    // inlined — both are uuids this test just read out of its own database.
    await db.run(sql.raw(`create trigger owner_types_an_alias after update on people
      when new.id = '${aaa.id}'
      begin update people set name = 'Ada @ work', name_source = 'owner' where id = '${ada.id}'; end`))
    try {
      // Aaa follows the contact list; Ada's write finds a row that is no longer
      // channel-named and does nothing, so the count is 1 rather than 2.
      expect(await populatePeople()).toMatchObject({ renamed: 1 })
    } finally {
      await db.run(sql.raw('drop trigger owner_types_an_alias'))
    }
    expect((await getPerson(aaa.id))!.name).toBe('Aaa Two')
    // The alias survived, and the row still says the owner chose it.
    expect(await getPerson(ada.id)).toMatchObject({ name: 'Ada @ work', nameSource: 'owner' })
  })

  // The same read-then-blind-write shape, and the same repair: the row can be
  // hidden while channelNamesFor's join runs.
  it('the write guards repeat every predicate the read relied on', () => {
    const src = readFileSync('lib/services/people.ts', 'utf8')
    const refresh = src.split('async function refreshChannelNames')[1].split('\n}')[0]
    const update = refresh.split('db.update(people)')[1]
    expect(update).toMatch(/eq\(people\.nameSource, 'channel'\)/)
    expect(update).toMatch(/isNull\(people\.archivedAt\)/)
    const reset = src.split('export async function resetName')[1].split('\n}')[0]
    expect(reset.split('db.update(people)')[1]).toMatch(/isNull\(people\.archivedAt\)/)
  })

  it('a hidden person is nobody, is never recreated, and comes back on restore', async () => {
    const tg = await makeConnection({ channel: 'telegram' })
    await syncContacts(tg.id, 'telegram', [{ externalId: '42', displayName: 'Ada', phone: null }])
    await makeChat(tg, { kind: 'dm', externalChatId: '42', title: 'Ada' })
    expect(await populatePeople()).toMatchObject({ created: 1 })
    const [ada] = await listPeople()

    expect(await archivePerson(ada.id)).toBe(true)
    expect(await listPeople()).toEqual([])
    expect(await publicPeople()).toEqual([])
    expect(await getPerson(ada.id)).toBeNull()
    expect(await personForIdentity({ channel: 'telegram', externalId: '42' })).toBeNull()
    expect(await updatePerson(ada.id, { name: 'Nope' })).toBe(false)
    expect((await listArchivedPeople()).map(p => p.name)).toEqual(['Ada'])
    // The identity is still theirs, which is what keeps them hidden.
    expect((await listIdentityCandidates('telegram'))[0].personId).toBe(ada.id)

    expect(await populatePeople()).toEqual({ created: 0, merged: 0, renamed: 0 })
    expect(await listPeople()).toEqual([])

    expect(await restorePerson(ada.id)).toBe(true)
    expect(await restorePerson(ada.id)).toBe(false)
    expect((await listPeople()).map(p => p.name)).toEqual(['Ada'])
    expect(await personForIdentity({ channel: 'telegram', externalId: '42' }))
      .toEqual({ id: ada.id, name: 'Ada' })
  })

  // PRIVACY says hiding someone "keeps their links, which is what stops the
  // next sync recreating them". Their links only cover the channels they were
  // on: pair the second one later and their number arrives attached to no
  // person at all, and mergeByPhone excludes archived people by design, so
  // nothing downstream could repair it.
  it('keeps someone hidden when a second channel finds them later', async () => {
    const tg = await makeConnection({ channel: 'telegram' })
    await syncContacts(tg.id, 'telegram', [
      { externalId: '42', displayName: 'Ada', phone: '+447700900123' },
    ])
    expect(await populatePeople()).toMatchObject({ created: 1 })
    const [ada] = await listPeople()
    expect(await archivePerson(ada.id)).toBe(true)

    // Weeks later: WhatsApp is paired and reports the same number.
    const wa = await makeConnection({ channel: 'whatsapp' })
    await syncContacts(wa.id, 'whatsapp', [
      { externalId: ADA_JID, displayName: 'Ada', phone: '+44 7700 900123' },
    ])
    expect(await populatePeople()).toMatchObject({ created: 0 })

    expect(await listPeople()).toEqual([])
    expect(await publicPeople()).toEqual([])
    const [stillHidden] = await listArchivedPeople()
    expect(stillHidden.id).toBe(ada.id)
    expect(stillHidden.identities.map(i => [i.channel, i.externalId, i.source])).toEqual([
      ['telegram', '42', 'auto'],
      ['whatsapp', ADA_JID, 'auto'],
    ])
    // Both sides resolve to nobody while she is hidden…
    expect(await personForIdentity({ channel: 'whatsapp', externalId: ADA_JID })).toBeNull()
    // …and restoring brings back one person holding both.
    expect(await restorePerson(ada.id)).toBe(true)
    const [back] = await listPeople()
    expect(back.identities.map(i => i.channel)).toEqual(['telegram', 'whatsapp'])
    expect(await personForIdentity({ channel: 'whatsapp', externalId: ADA_JID }))
      .toEqual({ id: ada.id, name: 'Ada' })
  })

  // The number is the only identifier the two channels share, so nothing
  // weaker may reach an archived row: a name match must still make a new,
  // visible person rather than quietly joining someone the owner hid.
  it('does not attach a name-only match to a hidden person', async () => {
    const tg = await makeConnection({ channel: 'telegram' })
    await syncContacts(tg.id, 'telegram', [{ externalId: '42', displayName: 'Ada', phone: null }])
    expect(await populatePeople()).toMatchObject({ created: 1 })
    const [ada] = await listPeople()
    await archivePerson(ada.id)

    const wa = await makeConnection({ channel: 'whatsapp' })
    await syncContacts(wa.id, 'whatsapp', [{ externalId: GRACE_JID, displayName: 'Ada', phone: null }])
    expect(await populatePeople()).toMatchObject({ created: 1 })
    expect((await listPeople()).map(p => p.name)).toEqual(['Ada'])
    expect((await listArchivedPeople())[0].identities).toHaveLength(1)
  })

  it('merging moves the identities and deletes the merged-from person outright', async () => {
    const from = await createPerson({ name: 'Ada on Telegram', notes: 'met at work' })
    await linkIdentity(from.id, { channel: 'telegram', externalId: '42' })
    const into = await createPerson({ name: 'Ada' })
    await linkIdentity(into.id, { channel: 'whatsapp', externalId: ADA_JID })

    expect(await mergePeople(from.id, into.id)).toBe(true)
    // A hard delete, not an archive (decision 15): the identities are the
    // other person's now, so there is nothing left to hide.
    expect(await db.select().from(people).where(eq(people.id, from.id))).toEqual([])
    expect(await listArchivedPeople()).toEqual([])

    const person = (await getPerson(into.id))!
    expect(person.name).toBe('Ada')
    // Notes are the one thing the owner wrote by hand; they move into an
    // empty box rather than disappearing with the row.
    expect(person.notes).toBe('met at work')
    expect(person.identities.map(i => [i.channel, i.externalId])).toEqual([
      ['telegram', '42'], ['whatsapp', ADA_JID],
    ])

    expect(await mergePeople(from.id, into.id)).toBe(false)
    expect(await mergePeople(into.id, into.id)).toBe(false)
  })

  it('refuses to merge a hidden person in either direction, and moves nothing', async () => {
    const hidden = await createPerson({ name: 'Hidden' })
    await linkIdentity(hidden.id, { channel: 'telegram', externalId: '42' })
    const live = await createPerson({ name: 'Live' })
    await linkIdentity(live.id, { channel: 'whatsapp', externalId: ADA_JID })
    await archivePerson(hidden.id)

    expect(await mergePeople(hidden.id, live.id)).toBe(false)
    expect(await mergePeople(live.id, hidden.id)).toBe(false)
    // The alive check and the three writes are one transaction, so a refusal
    // leaves both sides exactly as they were: no identity changed owner.
    expect((await listArchivedPeople())[0].identities.map(i => i.externalId)).toEqual(['42'])
    expect((await getPerson(live.id))!.identities.map(i => i.externalId)).toEqual([ADA_JID])
  })

  // Structural, because the hazard is a race two processes have to lose: the
  // web and the worker both write this file, person_identities.person_id is ON
  // DELETE CASCADE, and an interleaved merge would take the owner's links with
  // it. The behavioural tests above prove what one caller sees; this proves the
  // four statements cannot be pulled apart.
  it('does every merge write inside one transaction', () => {
    const src = readFileSync('lib/services/people.ts', 'utf8')
    const body = src.split('export async function mergePeople')[1].split('\n}')[0]
    expect(body).toMatch(/db\.transaction\(tx =>/)
    // The alive check is re-read INSIDE it, not carried in from before.
    expect(body).toMatch(/tx\.select\(\)\.from\(people\)/)
    expect(body).not.toMatch(/\bawait\b/)
    expect(body).not.toMatch(/\bdb\.(select|update|delete|insert)\b/)
  })
})


// Addendum 2, decision 12's other half. Auto-populate answers every identity,
// so a match BETWEEN IDENTITIES is never open any more — the leftover is two
// PEOPLE for one human, which is what the owner is now asked about.
describe('merge suggestions between people', () => {
  beforeEach(resetDb)

  async function twoAdas(): Promise<{ telegram: string; whatsapp: string }> {
    const tg = await makeConnection({ channel: 'telegram' })
    const wa = await makeConnection({ channel: 'whatsapp' })
    // No phone on either side: Telegram will not show a contact's number
    // unless you have each other saved, which is exactly when decision 12
    // cannot fire and a name is all there is.
    await syncContacts(tg.id, 'telegram', [{ externalId: '42', displayName: ' Ada ', phone: null }])
    await syncContacts(wa.id, 'whatsapp', [{ externalId: GRACE_JID, displayName: 'ADA', phone: null }])
    await populatePeople()
    const all = await listPeople()
    const telegram = all.find(p => p.identities[0].channel === 'telegram')!.id
    const whatsapp = all.find(p => p.identities[0].channel === 'whatsapp')!.id
    await db.update(people).set({ createdAt: new Date(1000) }).where(eq(people.id, telegram))
    await db.update(people).set({ createdAt: new Date(2000) }).where(eq(people.id, whatsapp))
    return { telegram, whatsapp }
  }

  it('offers the younger row merged into the older, once, and only across channels', async () => {
    const { telegram, whatsapp } = await twoAdas()
    // Trimmed and case-insensitive: ' Ada ' and 'ADA' are one name.
    expect(await listMergeSuggestions()).toEqual([{
      from: { id: whatsapp, name: 'ADA' },
      into: { id: telegram, name: 'Ada' },
      reason: 'name',
    }])

    // A third row with the same name on the SAME channel is offered against
    // the WhatsApp one — and never against the other Telegram row, because two
    // Telegram accounts are two accounts however they are named.
    const sameChannel = await createPerson({ name: 'Ada' })
    await linkIdentity(sameChannel.id, { channel: 'telegram', externalId: '99' })
    const two = await listMergeSuggestions()
    expect(two).toHaveLength(2)
    expect(two.every(s => [s.from.id, s.into.id].includes(whatsapp))).toBe(true)

    // Somebody who already holds both channels is not half of anything…
    const both = await createPerson({ name: 'Grace' })
    await linkIdentity(both.id, { channel: 'telegram', externalId: '77' })
    await linkIdentity(both.id, { channel: 'whatsapp', externalId: ADA_JID })
    // …nor is a row with no identity at all, nor one with a different name.
    await createPerson({ name: 'Grace' })
    await createPerson({ name: 'Somebody else' })
    expect(await listMergeSuggestions()).toHaveLength(2)
  })

  it('never offers a hidden person, and confirming is a merge', async () => {
    const { telegram, whatsapp } = await twoAdas()
    expect(await archivePerson(whatsapp)).toBe(true)
    // Hiding is already an answer.
    expect(await listMergeSuggestions()).toEqual([])
    expect(await restorePerson(whatsapp)).toBe(true)

    expect(await confirmSuggestion(whatsapp, telegram)).toBe(true)
    expect(await getPerson(whatsapp)).toBeNull()
    const survivor = (await getPerson(telegram))!
    expect(survivor.name).toBe('Ada')
    expect(survivor.identities.map(i => [i.channel, i.externalId])).toEqual([
      ['telegram', '42'], ['whatsapp', GRACE_JID],
    ])
    expect(await listMergeSuggestions()).toEqual([])
    // A second post of the same form finds the row gone and moves nothing.
    expect(await confirmSuggestion(whatsapp, telegram)).toBe(false)
  })

  it('remembers a dismissal by the identities, so a rebuilt pair stays dismissed', async () => {
    const { telegram, whatsapp } = await twoAdas()
    expect(await dismissSuggestion(whatsapp, telegram)).toBe(true)
    expect(await dismissSuggestion(whatsapp, telegram)).toBe(true)
    expect(await listMergeSuggestions()).toEqual([])

    // The rows go and come back — hidden, restored, or in this case deleted
    // outright and re-populated under brand new person ids. The owner's "no"
    // was about the two humans, not about two uuids they never saw.
    await db.delete(people)
    expect(await populatePeople()).toMatchObject({ created: 2 })
    const rebuilt = await listPeople()
    expect(rebuilt).toHaveLength(2)
    expect(rebuilt.map(p => p.id).sort()).not.toEqual([telegram, whatsapp].sort())
    expect(await listMergeSuggestions()).toEqual([])
  })

  it('refuses to key a dismissal it cannot phrase', async () => {
    const { telegram } = await twoAdas()
    const both = await createPerson({ name: 'Grace' })
    await linkIdentity(both.id, { channel: 'telegram', externalId: '77' })
    await linkIdentity(both.id, { channel: 'whatsapp', externalId: ADA_JID })

    expect(await dismissSuggestion(telegram, telegram)).toBe(false)
    expect(await dismissSuggestion(telegram, 'no-such-person')).toBe(false)
    // Same channel on both sides, and a person holding both channels: neither
    // is a Telegram/WhatsApp pair the table can hold.
    expect(await dismissSuggestion(telegram, both.id)).toBe(false)
    expect(await listMergeSuggestions()).toHaveLength(1)
  })
})
