import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { channelContacts, chats, connections, messages, personIdentities } from '@/lib/db/schema'
import { resetDb } from './helpers/db'
import { makeConnection, makeChat, addMessage } from './helpers/fixtures'
import {
  confirmSuggestion, createPerson, deletePerson, dismissSuggestion, getPerson,
  linkIdentity, listIdentityCandidates, listPeople, listSuggestions, personForIdentity,
  publicPeople, syncContacts, unlinkIdentity, updatePerson,
} from '@/lib/services/people'

const ADA_JID = '447700900123@s.whatsapp.net'
const GRACE_JID = '447700900999@s.whatsapp.net'

describe('people', () => {
  beforeEach(resetDb)

  it('creates, reads, renames and deletes a person', async () => {
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

    expect(await deletePerson(id)).toBe(true)
    expect(await deletePerson(id)).toBe(false)
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

  it('suggests a pair by phone and by name, and never one already answered', async () => {
    const tg = await makeConnection({ channel: 'telegram' })
    const wa = await makeConnection({ channel: 'whatsapp' })
    await syncContacts(tg.id, 'telegram', [
      { externalId: '42', displayName: 'Ada', phone: '+44 7700 900123' },
      { externalId: '7', displayName: 'Grace', phone: null },
      { externalId: '8', displayName: 'Nobody in WhatsApp', phone: '+15550000000' },
    ])
    await makeChat(wa, { kind: 'dm', externalChatId: ADA_JID, title: 'Ada Lovelace' })
    await makeChat(wa, { kind: 'dm', externalChatId: GRACE_JID, title: ' grace ' })

    const suggestions = await listSuggestions()
    expect(suggestions.map(s => [s.telegram.externalId, s.whatsapp.externalId, s.reason])).toEqual([
      ['42', ADA_JID, 'phone'],
      ['7', GRACE_JID, 'name'],
    ])

    // a dismissal is remembered; the other suggestion is untouched
    await dismissSuggestion('7', GRACE_JID)
    await dismissSuggestion('7', GRACE_JID)
    expect((await listSuggestions()).map(s => s.reason)).toEqual(['phone'])

    // an identity that already belongs to a person has an answer
    const { id } = await createPerson({ name: 'Ada' })
    await linkIdentity(id, { channel: 'whatsapp', externalId: ADA_JID })
    expect(await listSuggestions()).toEqual([])
  })

  it('confirms a suggestion into one person with both identities', async () => {
    const tg = await makeConnection({ channel: 'telegram' })
    const wa = await makeConnection({ channel: 'whatsapp' })
    await syncContacts(tg.id, 'telegram', [{ externalId: '42', displayName: 'Ada', phone: '+447700900123' }])
    await makeChat(wa, { kind: 'dm', externalChatId: ADA_JID, title: 'Ada Lovelace' })

    const created = await confirmSuggestion('42', ADA_JID)
    expect(created).not.toBeNull()
    const person = (await getPerson(created!.id))!
    expect(person.name).toBe('Ada')
    expect(person.identities.map(i => [i.channel, i.externalId, i.source])).toEqual([
      ['telegram', '42', 'phone_match'],
      ['whatsapp', ADA_JID, 'phone_match'],
    ])
    expect(await listSuggestions()).toEqual([])

    // a stale form post must not invent a second person
    expect(await confirmSuggestion('42', ADA_JID)).toBeNull()
    expect(await listPeople()).toHaveLength(1)
  })

  it('refuses to confirm a pair that does not match', async () => {
    const tg = await makeConnection({ channel: 'telegram' })
    const wa = await makeConnection({ channel: 'whatsapp' })
    await syncContacts(tg.id, 'telegram', [{ externalId: '42', displayName: 'Ada', phone: '+447700900123' }])
    await makeChat(wa, { kind: 'dm', externalChatId: GRACE_JID, title: 'Grace' })
    expect(await confirmSuggestion('42', GRACE_JID)).toBeNull()
    expect(await confirmSuggestion('nope', GRACE_JID)).toBeNull()
    expect(await listPeople()).toEqual([])
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

  it('deleting a person leaves the archive alone', async () => {
    const tg = await makeConnection({ channel: 'telegram' })
    const dm = await makeChat(tg, { kind: 'dm', externalChatId: '42', title: 'Ada' })
    await addMessage(dm, { senderExternalId: '42', text: 'still here' })
    const { id } = await createPerson({ name: 'Ada' })
    await linkIdentity(id, { channel: 'telegram', externalId: '42' })

    expect(await deletePerson(id)).toBe(true)
    // the identity rows go with the person; the chats and messages do not
    expect(await db.select().from(personIdentities)).toEqual([])
    expect(await db.select().from(chats)).toHaveLength(1)
    const rows = await db.select().from(messages)
    expect(rows).toHaveLength(1)
    expect(rows[0].text).toBe('still here')
  })
})

describe('publicPeople — the one mapping both agent surfaces use', () => {
  beforeEach(resetDb)

  it('carries the id, name, notes, channels and chat count, and nothing else', async () => {
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
    })
    expect(Object.keys(person).sort()).toEqual(['channels', 'chatCount', 'id', 'name', 'notes'])
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
