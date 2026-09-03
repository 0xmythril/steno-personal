import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from './helpers/db'
import { makeConnection, makeChat, addMessage } from './helpers/fixtures'
import { listChats, getMessages, searchMessages } from '@/lib/services/queries'
import { db } from '@/lib/db/client'
import { connections } from '@/lib/db/schema'
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
    // Only the owner has ever spoken: nothing better than the stored title.
    const oneSided = await makeChat(conn, { title: null })
    await addMessage(oneSided, { senderName: 'Me Myself', fromOwner: true })
    // Groups keep a null subject rather than borrowing a member's name.
    const group = await makeChat(conn, { kind: 'group', title: null })
    await addMessage(group, { senderName: 'Erin' })

    const byId = new Map((await listChats()).map(c => [c.id, c.title]))
    expect(byId.get(untitled.id)).toBe('Bob')
    expect(byId.get(mine.id)).toBe('Carol')
    expect(byId.get(named.id)).toBe('Dave (saved contact)')
    expect(byId.get(oneSided.id)).toBeNull()
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
    const scoped = await searchMessages('dentist', a.id)
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
    expect(await searchMessages('dentist', undefined, 2)).toHaveLength(2)
  })
})
