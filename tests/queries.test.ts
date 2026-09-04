import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from './helpers/db'
import { makeConnection, makeChat, addMessage } from './helpers/fixtures'
import { listChats, getMessages, recentMessages, searchMessages } from '@/lib/services/queries'
import { archivePerson, createPerson, linkIdentity, syncContacts } from '@/lib/services/people'
import { db } from '@/lib/db/client'
import { channelContacts, connections, messages } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

describe('listChats', () => {
  beforeEach(resetDb)

  it('orders by most recent activity and counts live messages only', async () => {
    const conn = await makeConnection()
    const older = await makeChat(conn, { title: 'Old', lastMessageAt: new Date('2026-01-01T00:00:00Z') })
    const newer = await makeChat(conn, { title: 'New', lastMessageAt: new Date('2026-08-01T00:00:00Z') })
    await addMessage(older); await addMessage(older, { deletedAt: new Date() })
    const out = await listChats()
    expect(out.map(c => c.id)).toEqual([newer.id, older.id])
    expect(out.map(c => c.messageCount)).toEqual([0, 1])
    expect(out[1]).toMatchObject({ channel: 'telegram', kind: 'dm', title: 'Old' })
  })

  it('filters by channel when asked, and lists everything otherwise', async () => {
    const tg = await makeChat(await makeConnection({ channel: 'telegram' }), { title: 'TG' })
    const wa = await makeChat(await makeConnection({ channel: 'whatsapp' }), { title: 'WA' })
    expect((await listChats()).map(c => c.id).sort()).toEqual([tg.id, wa.id].sort())
    expect((await listChats({ channel: 'whatsapp' })).map(c => c.id)).toEqual([wa.id])
    expect((await listChats({ channel: 'telegram' })).map(c => c.id)).toEqual([tg.id])
  })

  it('names a direct chat after the person on the other side', async () => {
    const conn = await makeConnection({ channel: 'whatsapp' })
    await db.update(connections).set({ displayName: 'Me Myself' }).where(eq(connections.id, conn.id))
    // No title at all: the latest non-owner sender names it.
    const untitled = await makeChat(conn, { title: null })
    await addMessage(untitled, { senderName: 'Me Myself', fromOwner: true, sentAt: new Date('2026-01-03T00:00:00Z') })
    await addMessage(untitled, { senderName: 'Old Name', sentAt: new Date('2026-01-01T00:00:00Z') })
    await addMessage(untitled, { senderName: 'Bob', sentAt: new Date('2026-01-02T00:00:00Z') })
    await addMessage(untitled, { senderName: 'Deleted Person', sentAt: new Date('2026-01-04T00:00:00Z'), deletedAt: new Date() })
    // Titled with the owner's own name: same fallback.
    const mine = await makeChat(conn, { title: 'Me Myself' })
    await addMessage(mine, { senderName: 'Carol' })
    // A real counterparty title stays.
    const named = await makeChat(conn, { title: 'Dave (saved contact)' })
    await addMessage(named, { senderName: 'dave push name' })
    // Only the owner has ever spoken and there is no name anywhere: a WhatsApp
    // DM still has the phone number that is its id.
    const oneSided = await makeChat(conn, { title: null, externalChatId: '15551230000@s.whatsapp.net' })
    await addMessage(oneSided, { senderName: 'Me Myself', fromOwner: true })
    // A Telegram DM's id is an opaque user id, so it stays untitled.
    const tgConn = await makeConnection({ channel: 'telegram' })
    const tgOneSided = await makeChat(tgConn, { title: null, externalChatId: '123456789' })
    await addMessage(tgOneSided, { senderName: null, fromOwner: true })
    // Groups keep a null subject rather than borrowing a member's name.
    const group = await makeChat(conn, { kind: 'group', title: null })
    await addMessage(group, { senderName: 'Erin' })

    const byId = new Map((await listChats()).map(c => [c.id, c.title]))
    expect(byId.get(untitled.id)).toBe('Bob')
    expect(byId.get(mine.id)).toBe('Carol')
    expect(byId.get(named.id)).toBe('Dave (saved contact)')
    expect(byId.get(oneSided.id)).toBe('+15551230000')
    expect(byId.get(tgOneSided.id)).toBeNull()
    expect(byId.get(group.id)).toBeNull()
    // The transcript header agrees with the list.
    expect((await getMessages(untitled.id))?.chat.title).toBe('Bob')
  })

  it('falls back to created_at for a chat that has never had a message', async () => {
    const conn = await makeConnection()
    const chat = await makeChat(conn, { title: 'Empty' })
    const out = await listChats()
    expect(out.map(c => c.id)).toEqual([chat.id])
    expect(out[0].lastMessageAt).toBeNull()
  })
})

describe('getMessages', () => {
  beforeEach(resetDb)

  it('shows a nameless WhatsApp sender as their phone number, and a nameless Telegram sender as nothing', async () => {
    const wa = await makeChat(await makeConnection({ channel: 'whatsapp' }), { kind: 'group', title: 'Team' })
    await addMessage(wa, { senderName: null, senderExternalId: '15551230000@s.whatsapp.net', text: 'synced' })
    await addMessage(wa, { senderName: 'Ada', senderExternalId: '15559990000@s.whatsapp.net', text: 'live' })
    const tg = await makeChat(await makeConnection({ channel: 'telegram' }), { kind: 'group', title: 'Team' })
    await addMessage(tg, { senderName: null, senderExternalId: '123456789', text: 'anon' })
    const waNames = (await getMessages(wa.id))!.messages.map(m => m.senderName).sort()
    expect(waNames).toEqual(['+15551230000', 'Ada'])
    expect((await getMessages(tg.id))!.messages[0].senderName).toBeNull()
    // The same rule reaches search results.
    expect((await searchMessages('synced'))[0].senderName).toBe('+15551230000')
  })

  it('reads newest-first with a working cursor and returns the chat alongside', async () => {
    const chat = await makeChat(await makeConnection(), { title: 'Mum' })
    for (let i = 0; i < 5; i++) await addMessage(chat, { text: `m${i}`, sentAt: new Date(Date.UTC(2026, 0, 1 + i)) })
    const page1 = await getMessages(chat.id, { limit: 3 })
    expect(page1!.chat.title).toBe('Mum')
    expect(page1!.messages.map(m => m.text)).toEqual(['m4', 'm3', 'm2'])
    expect(page1!.nextCursor).not.toBeNull()
    const page2 = await getMessages(chat.id, { limit: 3, cursor: page1!.nextCursor! })
    expect(page2!.messages.map(m => m.text)).toEqual(['m1', 'm0'])
    expect(page2!.nextCursor).toBeNull()
  })

  it('narrows with before and after, and returns null for an unknown or malformed id', async () => {
    const chat = await makeChat(await makeConnection())
    await addMessage(chat, { text: 'early', sentAt: new Date('2026-01-01T00:00:00Z') })
    await addMessage(chat, { text: 'late', sentAt: new Date('2026-06-01T00:00:00Z') })
    expect((await getMessages(chat.id, { after: new Date('2026-03-01T00:00:00Z') }))!.messages.map(m => m.text)).toEqual(['late'])
    expect((await getMessages(chat.id, { before: new Date('2026-03-01T00:00:00Z') }))!.messages.map(m => m.text)).toEqual(['early'])
    expect(await getMessages('not-a-real-id')).toBeNull()
  })

  it('ignores a malformed cursor rather than returning nothing', async () => {
    const chat = await makeChat(await makeConnection())
    await addMessage(chat, { text: 'only' })
    expect((await getMessages(chat.id, { cursor: 'garbage' }))!.messages.map(m => m.text)).toEqual(['only'])
  })

  it('never serves a deleted message, and no view carries a deletedAt field', async () => {
    const chat = await makeChat(await makeConnection())
    await addMessage(chat, { text: 'kept message' })
    await addMessage(chat, { text: 'unsent secret', deletedAt: new Date() })
    const page = await getMessages(chat.id)
    expect(page!.messages.map(m => m.text)).toEqual(['kept message'])
    expect(JSON.stringify(page)).not.toMatch(/deletedAt|unsent secret/)
  })

  it('carries the fields a transcript renders, with media null until M4', async () => {
    const chat = await makeChat(await makeConnection())
    await addMessage(chat, { text: 'hi', senderName: 'Bob', fromOwner: false, externalMessageId: '77' })
    const [m] = (await getMessages(chat.id))!.messages
    expect(m).toMatchObject({ externalMessageId: '77', senderName: 'Bob', fromOwner: false, type: 'text', editedAt: null, media: null })
  })
})

describe('replies', () => {
  beforeEach(resetDb)

  it('resolves a reply to the quoted message in the same chat, and to nothing once that is deleted', async () => {
    const conn = await makeConnection({ channel: 'whatsapp' })
    const chat = await makeChat(conn, { kind: 'group', title: 'Team' })
    const quoted = await addMessage(chat, { text: 'the deck is attached', senderName: 'Avir', externalMessageId: 'WA0', sentAt: new Date(1000) })
    const reply = await addMessage(chat, { text: 'I refer to here', externalMessageId: 'WA1', replyToExternalId: 'WA0', sentAt: new Date(2000) })
    // Same external id in ANOTHER chat is another message.
    const other = await makeChat(conn, { kind: 'group', title: 'Other' })
    await addMessage(other, { text: 'unrelated', externalMessageId: 'WA0' })
    await addMessage(other, { text: 'dangling', externalMessageId: 'WA2', replyToExternalId: 'WA-missing' })

    const page = (await getMessages(chat.id))!.messages
    expect(page.find(m => m.id === reply.id)!.replyTo).toEqual({ id: quoted.id, senderName: 'Avir', text: 'the deck is attached' })
    expect(page.find(m => m.id === quoted.id)!.replyTo).toBeNull()
    expect((await getMessages(other.id))!.messages.every(m => m.replyTo === null)).toBe(true)
    expect((await searchMessages('refer'))[0].replyTo).toMatchObject({ id: quoted.id })

    await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, quoted.id))
    expect((await getMessages(chat.id))!.messages[0].replyTo).toBeNull()
  })
})

describe('mentions', () => {
  beforeEach(resetDb)

  it('rewrites a WhatsApp @digits mention to the name the archive knows, and leaves the rest alone', async () => {
    const conn = await makeConnection({ channel: 'whatsapp' })
    const chat = await makeChat(conn, { kind: 'group', title: 'Team' })
    // A LID-addressed sender, known only by the push name on their own message.
    await addMessage(chat, { text: 'hi', senderExternalId: '100257522254022@lid', senderName: 'Alan Lui', sentAt: new Date(1000) })
    // A phone-addressed contact in the owner's contact list.
    await syncContacts(conn.id, 'whatsapp', [{ externalId: '15559990000@s.whatsapp.net', displayName: 'Saved Ada', phone: null }])
    const m = await addMessage(chat, {
      text: '@100257522254022 can you confirm with @15559990000? @999 too, and ada@example.com',
      sentAt: new Date(2000),
    })
    const page = (await getMessages(chat.id))!.messages
    expect(page.find(x => x.id === m.id)!.text)
      .toBe('@Alan Lui can you confirm with @Saved Ada? @999 too, and ada@example.com')
    // The inbox and search rewrite the same way.
    expect((await recentMessages()).messages[0].text).toContain('@Alan Lui')
    expect((await searchMessages('confirm'))[0].text).toContain('@Saved Ada')

    // The address book outranks both once the person is linked.
    const p = await createPerson({ name: 'Alan L.' })
    await linkIdentity(p.id, { channel: 'whatsapp', externalId: '100257522254022@lid' })
    expect((await getMessages(chat.id))!.messages[0].text).toContain('@Alan L. can')

    // Telegram text is never touched: its mentions are @usernames, and a
    // number after @ there is somebody's handle.
    const tg = await makeChat(await makeConnection({ channel: 'telegram' }), { kind: 'group', title: 'TG' })
    await addMessage(tg, { text: '@100257522254022 hi' })
    expect((await getMessages(tg.id))!.messages[0].text).toBe('@100257522254022 hi')
  })
})

describe('searchMessages', () => {
  beforeEach(resetDb)

  it('finds matches across chats and can be scoped to one', async () => {
    const conn = await makeConnection()
    const a = await makeChat(conn, { title: 'A' })
    const b = await makeChat(conn, { title: 'B' })
    await addMessage(a, { text: 'the dentist appointment is monday' })
    await addMessage(b, { text: 'dentist bills again' })
    const all = await searchMessages('dentist')
    expect(all).toHaveLength(2)
    expect(all.every(h => h.chatTitle === 'A' || h.chatTitle === 'B')).toBe(true)
    const scoped = await searchMessages('dentist', { chatId: a.id })
    expect(scoped).toHaveLength(1)
    expect(scoped[0].text).toContain('monday')
    expect(scoped[0].chatId).toBe(a.id)
  })

  it('matches every token, and returns nothing for a miss', async () => {
    const chat = await makeChat(await makeConnection())
    await addMessage(chat, { text: 'ring the dentist on monday' })
    expect(await searchMessages('dentist monday')).toHaveLength(1)
    expect(await searchMessages('dentist tuesday')).toEqual([])
    expect(await searchMessages('zebra')).toEqual([])
  })

  it('treats FTS operators as literal text instead of syntax', async () => {
    const chat = await makeChat(await makeConnection())
    await addMessage(chat, { text: 'dentist appointment' })
    // A bare "OR"/"NEAR"/quote from a person's search box must not become an
    // FTS expression — or, worse, a syntax error thrown at the reader.
    expect(await searchMessages('dentist OR zebra')).toEqual([])
    expect(await searchMessages('"dentist')).toHaveLength(1)
    expect(await searchMessages('   ')).toEqual([])
  })

  it('never returns a deleted message', async () => {
    const chat = await makeChat(await makeConnection())
    await addMessage(chat, { text: 'unsent secret', deletedAt: new Date() })
    expect(await searchMessages('unsent')).toEqual([])
  })

  it('honours the limit', async () => {
    const chat = await makeChat(await makeConnection())
    for (let i = 0; i < 5; i++) await addMessage(chat, { text: `dentist ${i}` })
    expect(await searchMessages('dentist', { limit: 2 })).toHaveLength(2)
  })
})

// The address book is an annotation over the archive: a person never changes
// which rows a read path returns, only what they are called. These tests pin
// the precedence, and that a person is looked up per channel — an id string
// means nothing on its own.
describe('people on chats and messages', () => {
  beforeEach(resetDb)

  const ADA = '15551230000@s.whatsapp.net'

  it('names one sender the same in every chat: the address book first, then any push name they ever carried', async () => {
    const conn = await makeConnection({ channel: 'whatsapp' })
    const live = await makeChat(conn, { kind: 'group', title: 'Air Asia' })
    const synced = await makeChat(conn, { kind: 'group', title: 'Old group' })
    // A live message carries the push name; a history-synced one never does.
    // The reader must not meet "Avir" in one chat and "+1555…" in the next.
    await addMessage(live, { text: 'slide attached', senderExternalId: ADA, senderName: 'Avir', sentAt: new Date(2000) })
    await addMessage(synced, { text: 'older', senderExternalId: ADA, senderName: null, sentAt: new Date(1000) })
    expect((await getMessages(synced.id))!.messages[0].senderName).toBe('Avir')
    // A push name on the other channel is somebody else's.
    const tg = await makeChat(await makeConnection({ channel: 'telegram' }), { kind: 'group', title: 'TG' })
    await addMessage(tg, { text: 'tg', senderExternalId: ADA, senderName: null })
    expect((await getMessages(tg.id))!.messages[0].senderName).toBeNull()

    // What the owner wrote in the address book outranks every channel name,
    // the same rule a direct chat's title already follows.
    const p = await createPerson({ name: 'Avir Shah' })
    await linkIdentity(p.id, { channel: 'whatsapp', externalId: ADA })
    expect((await getMessages(live.id))!.messages[0].senderName).toBe('Avir Shah')
    expect((await getMessages(synced.id))!.messages[0].senderName).toBe('Avir Shah')
    // And the sender filter matches what is shown.
    expect((await searchMessages('older', { sender: 'shah' })).map(m => m.text)).toEqual(['older'])
    expect((await searchMessages('slide', { sender: 'avir' })).map(m => m.text)).toEqual(['slide attached'])
  })

  it('names a direct chat after the linked person, ahead of every other rule', async () => {
    const conn = await makeConnection({ channel: 'whatsapp' })
    // Every weaker rule is available: a title, a counterparty push name, and
    // the number in the id. The person still wins.
    const dm = await makeChat(conn, { title: 'Saved as A. Lovelace', externalChatId: ADA })
    await addMessage(dm, { senderName: 'ada push name', senderExternalId: ADA })
    // A group whose subject is untouched even though its id is linked.
    const group = await makeChat(conn, { kind: 'group', title: 'Team', externalChatId: '99999@g.us' })
    await addMessage(group, { senderName: 'Someone' })

    const { id } = await createPerson({ name: 'Ada Lovelace' })
    await linkIdentity(id, { channel: 'whatsapp', externalId: ADA })
    const groupPerson = await createPerson({ name: 'Not A Chat Name' })
    await linkIdentity(groupPerson.id, { channel: 'whatsapp', externalId: '99999@g.us' })

    const byId = new Map((await listChats()).map(c => [c.id, c]))
    expect(byId.get(dm.id)).toMatchObject({ title: 'Ada Lovelace', person: { id, name: 'Ada Lovelace' } })
    // A group keeps its subject and carries no person: a group is not someone.
    expect(byId.get(group.id)).toMatchObject({ title: 'Team', person: null })
    // The transcript header agrees with the list.
    expect((await getMessages(dm.id))!.chat).toMatchObject({ title: 'Ada Lovelace', person: { id, name: 'Ada Lovelace' } })
  })

  it('leaves an unlinked chat exactly as it was', async () => {
    const conn = await makeConnection({ channel: 'whatsapp' })
    const dm = await makeChat(conn, { title: null, externalChatId: ADA })
    await addMessage(dm, { senderName: null, senderExternalId: ADA })
    const [row] = await listChats()
    expect(row).toMatchObject({ title: '+15551230000', person: null })
  })

  it('puts the person on a message by its sender identity, and never on the owner\'s own', async () => {
    const conn = await makeConnection({ channel: 'telegram' })
    const group = await makeChat(conn, { kind: 'group', title: 'Team' })
    await addMessage(group, { senderName: 'Ada', senderExternalId: '123456789', text: 'from ada' })
    await addMessage(group, { senderName: 'Me', senderExternalId: '987654321', fromOwner: true, text: 'from me' })

    const ada = await createPerson({ name: 'Ada Lovelace' })
    await linkIdentity(ada.id, { channel: 'telegram', externalId: '123456789' })
    // Even an owner identity that IS in the address book stays anonymous on
    // the owner's own lines: from_owner is the archive's answer to "who".
    const me = await createPerson({ name: 'The Owner' })
    await linkIdentity(me.id, { channel: 'telegram', externalId: '987654321' })

    const byText = new Map((await getMessages(group.id))!.messages.map(m => [m.text, m.person]))
    expect(byText.get('from ada')).toEqual({ id: ada.id, name: 'Ada Lovelace' })
    expect(byText.get('from me')).toBeNull()
  })

  it('does not cross a telegram identity with a whatsapp one that spells the same id', async () => {
    const tgConn = await makeConnection({ channel: 'telegram' })
    const tgGroup = await makeChat(tgConn, { kind: 'group', title: 'TG' })
    await addMessage(tgGroup, { senderName: 'Ada', senderExternalId: '123456789', text: 'telegram line' })
    const waConn = await makeConnection({ channel: 'whatsapp' })
    const waGroup = await makeChat(waConn, { kind: 'group', title: 'WA', externalChatId: '123456789@g.us' })
    await addMessage(waGroup, { senderName: 'Ada', senderExternalId: '123456789', text: 'whatsapp line' })
    const waDm = await makeChat(waConn, { title: 'WA DM', externalChatId: '123456789' })

    const ada = await createPerson({ name: 'Ada Lovelace' })
    await linkIdentity(ada.id, { channel: 'telegram', externalId: '123456789' })

    expect((await getMessages(tgGroup.id))!.messages[0].person).toEqual({ id: ada.id, name: 'Ada Lovelace' })
    expect((await getMessages(waGroup.id))!.messages[0].person).toBeNull()
    const byId = new Map((await listChats()).map(c => [c.id, c]))
    expect(byId.get(waDm.id)).toMatchObject({ title: 'WA DM', person: null })
  })

  it('labels a sender from the contact cache when the message carries no name', async () => {
    const conn = await makeConnection({ channel: 'whatsapp' })
    await syncContacts(conn.id, 'whatsapp', [
      { externalId: ADA, displayName: 'Saved Contact', phone: null },
      { externalId: '15559990000@s.whatsapp.net', displayName: 'Also Saved', phone: null },
    ])
    const group = await makeChat(conn, { kind: 'group', title: 'Team' })
    await addMessage(group, { senderName: null, senderExternalId: ADA, text: 'nameless' })
    // A stored push name is what the archive actually recorded; it wins.
    await addMessage(group, { senderName: 'Push Name', senderExternalId: '15559990000@s.whatsapp.net', text: 'pushed' })
    // Nobody knows this one: the number in the id is still better than nothing.
    await addMessage(group, { senderName: null, senderExternalId: '15550000000@s.whatsapp.net', text: 'stranger' })

    const byText = new Map((await getMessages(group.id))!.messages.map(m => [m.text, m.senderName]))
    expect(byText.get('nameless')).toBe('Saved Contact')
    expect(byText.get('pushed')).toBe('Push Name')
    expect(byText.get('stranger')).toBe('+15550000000')
  })

  it('reads the contact cache of any connection on the channel, not only the chat\'s own', async () => {
    // Reconnecting an account makes a new connection row; the names the old
    // one read are still the owner's own contacts.
    const old = await makeConnection({ channel: 'whatsapp', status: 'revoked' })
    await syncContacts(old.id, 'whatsapp', [{ externalId: ADA, displayName: 'Saved Contact', phone: null }])
    const conn = await makeConnection({ channel: 'whatsapp' })
    const group = await makeChat(conn, { kind: 'group', title: 'Team' })
    await addMessage(group, { senderName: null, senderExternalId: ADA, text: 'nameless' })
    expect((await getMessages(group.id))!.messages[0].senderName).toBe('Saved Contact')
  })

  // The contact cache is keyed per connection, and reconnecting an account
  // makes a new one. Both rows are the owner's own contacts, so both are
  // usable — but the chat's own connection is the one that was reading that
  // account when the message arrived, and it wins even when the other row is
  // the fresher read.
  it("prefers the chat's own connection when two of them know the same contact", async () => {
    const conn = await makeConnection({ channel: 'whatsapp' })
    await syncContacts(conn.id, 'whatsapp', [{ externalId: ADA, displayName: 'This Connection', phone: null }])
    const other = await makeConnection({ channel: 'whatsapp', status: 'revoked' })
    await syncContacts(other.id, 'whatsapp', [{ externalId: ADA, displayName: 'Another Connection', phone: null }])
    // Stamped explicitly rather than relying on call order: the other row is
    // unambiguously the more recent read, so only the own-connection rule can
    // decide this.
    await db.update(channelContacts).set({ syncedAt: new Date(Date.now() + 60_000) })
      .where(eq(channelContacts.connectionId, other.id))

    const group = await makeChat(conn, { kind: 'group', title: 'Team' })
    await addMessage(group, { senderName: null, senderExternalId: ADA, text: 'the dentist appointment' })
    expect((await getMessages(group.id))!.messages[0].senderName).toBe('This Connection')
    // The same expression, through the other read path.
    expect((await searchMessages('dentist'))[0].senderName).toBe('This Connection')
  })

  // A search hit and the chat list are two views of the same chat; they must
  // not disagree about its name. searchMessages used to return the raw
  // chats.title column, which for a WhatsApp DM is routinely null or the
  // owner's own name.
  it('titles a search hit exactly as the chat list titles the chat', async () => {
    const conn = await makeConnection({ channel: 'whatsapp' })
    await db.update(connections).set({ displayName: 'Me Myself' }).where(eq(connections.id, conn.id))
    const dm = await makeChat(conn, { title: 'Me Myself', externalChatId: ADA })
    await addMessage(dm, { senderName: 'Bo', senderExternalId: ADA, text: 'the dentist appointment' })

    const listed = () => listChats().then(cs => cs.find(c => c.id === dm.id)!.title)
    expect(await listed()).toBe('Bo')
    expect((await searchMessages('dentist'))[0].chatTitle).toBe('Bo')

    // …and once the owner names them, both say the name the owner chose.
    const ada = await createPerson({ name: 'Ada Lovelace' })
    await linkIdentity(ada.id, { channel: 'whatsapp', externalId: ADA })
    expect(await listed()).toBe('Ada Lovelace')
    expect((await searchMessages('dentist'))[0].chatTitle).toBe('Ada Lovelace')
  })

  it('a hidden person names nothing: every read path falls back', async () => {
    // Addendum 2 decision 14. The identity row stays linked — that is what
    // stops the populater making the person again — so this is the join, not
    // the link, that has to know about archived_at.
    const conn = await makeConnection({ channel: 'whatsapp' })
    const dm = await makeChat(conn, { title: 'Saved as A. Lovelace', externalChatId: ADA })
    await addMessage(dm, { senderName: 'ada push name', senderExternalId: ADA, text: 'the dentist' })
    const { id } = await createPerson({ name: 'Ada Lovelace' })
    await linkIdentity(id, { channel: 'whatsapp', externalId: ADA })
    expect((await listChats())[0]).toMatchObject({ title: 'Ada Lovelace', person: { id } })

    expect(await archivePerson(id)).toBe(true)
    expect((await listChats())[0]).toMatchObject({ title: 'Saved as A. Lovelace', person: null })
    expect((await getMessages(dm.id))!.chat).toMatchObject({ title: 'Saved as A. Lovelace', person: null })
    expect((await getMessages(dm.id))!.messages[0].person).toBeNull()
    expect((await searchMessages('dentist'))[0].person).toBeNull()
  })

  it('carries the person and the contact name into search results', async () => {
    const conn = await makeConnection({ channel: 'whatsapp' })
    await syncContacts(conn.id, 'whatsapp', [{ externalId: ADA, displayName: 'Saved Contact', phone: null }])
    const group = await makeChat(conn, { kind: 'group', title: 'Team' })
    await addMessage(group, { senderName: null, senderExternalId: ADA, text: 'the dentist appointment' })
    const ada = await createPerson({ name: 'Ada Lovelace' })
    await linkIdentity(ada.id, { channel: 'whatsapp', externalId: ADA })

    // The address-book name is the sender label once the person is linked
    // (the contact name was, until then); the person rides alongside.
    const [hit] = await searchMessages('dentist')
    expect(hit).toMatchObject({ senderName: 'Ada Lovelace', person: { id: ada.id, name: 'Ada Lovelace' } })
    await archivePerson(ada.id)
    expect((await searchMessages('dentist'))[0]).toMatchObject({ senderName: 'Saved Contact', person: null })
  })
})
