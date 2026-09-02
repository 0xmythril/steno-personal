import { describe, it, expect, beforeEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { chats, messages } from '@/lib/db/schema'
import { searchIndex } from '@/lib/db/fts'
import { resetDb } from './helpers/db'
import { makeConnection } from './helpers/fixtures'
import { recordMessage, applyEdit, applyDelete, type IncomingMessage } from '@/lib/services/ingest'

const msg = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  externalChatId: '-100123', chatKind: 'group', chatTitle: 'Family', externalMessageId: '1',
  senderExternalId: '42', senderName: 'Mum', fromOwner: false, sentAt: new Date('2026-08-01T00:00:00Z'),
  type: 'text', text: 'hello', media: null, raw: {}, ...over,
})

describe('ingest', () => {
  beforeEach(resetDb)

  it('records a chat and a message, and reports the insert', async () => {
    const conn = await makeConnection()
    const res = await recordMessage(conn.id, 'telegram', msg())
    expect(res.inserted).toBe(true)
    const [chat] = await db.select().from(chats)
    expect(chat.id).toBe(res.chatId)
    expect(chat.channel).toBe('telegram')
    expect(chat.kind).toBe('group')
    expect(chat.title).toBe('Family')
    const [row] = await db.select().from(messages)
    expect(row.id).toBe(res.messageId)
    expect(row.text).toBe('hello')
    expect(row.hasMedia).toBe(false)
  })

  it('is first-writer-wins on a re-ingest and reports inserted: false', async () => {
    const conn = await makeConnection()
    const first = await recordMessage(conn.id, 'telegram', msg({ text: 'hello' }))
    const again = await recordMessage(conn.id, 'telegram', msg({ text: 'CHANGED' }))
    expect(again.inserted).toBe(false)
    expect(again.messageId).toBe(first.messageId)
    const [row] = await db.select().from(messages)
    expect(row.text).toBe('hello')
  })

  it('moves last_message_at forward only, and never blanks a known title', async () => {
    const conn = await makeConnection()
    await recordMessage(conn.id, 'telegram', msg({ externalMessageId: '9', sentAt: new Date('2026-08-10T00:00:00Z') }))
    await recordMessage(conn.id, 'telegram', msg({ externalMessageId: '1', sentAt: new Date('2026-08-01T00:00:00Z'), chatTitle: null }))
    const [chat] = await db.select().from(chats)
    expect(chat.lastMessageAt).toEqual(new Date('2026-08-10T00:00:00Z'))
    expect(chat.title).toBe('Family')
  })

  it('flags a message that carries an attachment', async () => {
    const conn = await makeConnection()
    await recordMessage(conn.id, 'telegram', msg({
      type: 'image',
      text: null,
      media: { mimeType: 'image/jpeg', sizeBytes: 1024, isVoiceNote: false, durationSeconds: null },
    }))
    const [row] = await db.select().from(messages)
    expect(row.hasMedia).toBe(true)
    expect(row.type).toBe('image')
  })

  it('applyEdit updates the text, stamps edited_at, and re-indexes it for search', async () => {
    const conn = await makeConnection()
    await recordMessage(conn.id, 'telegram', msg({ text: 'original' }))
    await applyEdit(conn.id, 'telegram', msg({ text: 'edited' }))
    const [row] = await db.select().from(messages)
    expect(row.text).toBe('edited')
    expect(row.editedAt).toBeInstanceOf(Date)
    expect(await db.select({ body: searchIndex.body }).from(searchIndex)).toEqual([{ body: 'edited' }])
  })

  it('applyEdit records a message it has never seen rather than dropping it', async () => {
    const conn = await makeConnection()
    await applyEdit(conn.id, 'telegram', msg({ externalMessageId: '7', text: 'appeared via edit' }))
    const rows = await db.select().from(messages)
    expect(rows).toHaveLength(1)
    expect(rows[0].text).toBe('appeared via edit')
  })

  it('applyDelete tombstones a message scoped by chat', async () => {
    const conn = await makeConnection()
    await recordMessage(conn.id, 'telegram', msg({ externalChatId: '-100123', externalMessageId: '1' }))
    await applyDelete(conn.id, { externalChatId: '-100123', externalMessageId: '1' })
    const [row] = await db.select().from(messages)
    expect(row.deletedAt).toBeInstanceOf(Date)
  })

  it('a delete with no chat id stays in the common id space', async () => {
    const conn = await makeConnection()
    // A DM lives in the common id space; a channel's marked id is an unrelated
    // sequence that also starts small, so both can hold message id "2".
    await recordMessage(conn.id, 'telegram', msg({ externalChatId: '555', chatKind: 'dm', chatTitle: 'Bob', externalMessageId: '2' }))
    await recordMessage(conn.id, 'telegram', msg({ externalChatId: '-1001234567890', chatKind: 'channel', chatTitle: 'News', externalMessageId: '2' }))
    await applyDelete(conn.id, { externalMessageId: '2' })

    const all = await db.select().from(chats)
    const dm = all.find(c => c.externalChatId === '555')!
    const channel = all.find(c => c.externalChatId === '-1001234567890')!
    const [dmMsg] = await db.select().from(messages).where(and(eq(messages.chatId, dm.id), eq(messages.externalMessageId, '2')))
    const [chMsg] = await db.select().from(messages).where(and(eq(messages.chatId, channel.id), eq(messages.externalMessageId, '2')))
    expect(dmMsg.deletedAt).not.toBeNull()
    expect(chMsg.deletedAt).toBeNull()
  })

  it('a delete for an unknown chat or message is a no-op, not an error', async () => {
    const conn = await makeConnection()
    await recordMessage(conn.id, 'telegram', msg())
    await applyDelete(conn.id, { externalChatId: 'nope', externalMessageId: '1' })
    await applyDelete(conn.id, { externalMessageId: 'nope' })
    const [row] = await db.select().from(messages)
    expect(row.deletedAt).toBeNull()
  })
})
