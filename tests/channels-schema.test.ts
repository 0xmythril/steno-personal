import { describe, it, expect, beforeEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { connections, chats, messages } from '@/lib/db/schema'
import { searchIndex } from '@/lib/db/fts'
import { resetDb } from './helpers/db'
import { makeConnection, makeChat, addMessage } from './helpers/fixtures'

const indexRows = () => db.select({ messageId: searchIndex.messageId, body: searchIndex.body }).from(searchIndex)

describe('channel tables', () => {
  beforeEach(resetDb)

  it('a fresh connection defaults to pending with empty login columns', async () => {
    const [row] = await db.insert(connections).values({ channel: 'telegram' }).returning()
    expect(row.status).toBe('pending')
    expect(row.loginNeedsPassword).toBe(false)
    expect(row.loginQrToken).toBeNull()
    expect(row.loginSecretCiphertext).toBeNull()
    expect(row.revokedAt).toBeNull()
    expect(row.createdAt).toBeInstanceOf(Date)
  })

  it('allows only one LIVE connection per channel, and frees the slot on revoke', async () => {
    const first = await makeConnection({ channel: 'telegram' })
    await expect(db.insert(connections).values({ channel: 'telegram' })).rejects.toThrow()
    // a different channel is unaffected
    await db.insert(connections).values({ channel: 'whatsapp' })
    await db.update(connections).set({ status: 'revoked', revokedAt: new Date() }).where(eq(connections.id, first.id))
    const [second] = await db.insert(connections).values({ channel: 'telegram' }).returning()
    expect(second.id).not.toBe(first.id)
  })

  it('allows one live recovery row beside the live archive row, and only one', async () => {
    // Recovery pairs the same account a second time to prove ownership; the
    // archive connection must not be disturbed by it, so the slot is per
    // (channel, purpose), not per channel.
    await makeConnection({ channel: 'telegram' })
    const [rec] = await db.insert(connections).values({ channel: 'telegram', purpose: 'recovery' }).returning()
    expect(rec.purpose).toBe('recovery')
    expect(rec.recoveryOutcome).toBeNull()
    expect(rec.recoveryKeyId).toBeNull()
    await expect(db.insert(connections).values({ channel: 'telegram', purpose: 'recovery' })).rejects.toThrow()
    await db.update(connections).set({ status: 'revoked', revokedAt: new Date() }).where(eq(connections.id, rec.id))
    await db.insert(connections).values({ channel: 'telegram', purpose: 'recovery' })
  })

  it('a connection is an archive connection unless it says otherwise', async () => {
    const [row] = await db.insert(connections).values({ channel: 'whatsapp' }).returning()
    expect(row.purpose).toBe('archive')
  })

  it('enforces chat and message identity', async () => {
    const conn = await makeConnection()
    await makeChat(conn, { externalChatId: '5' })
    await expect(makeChat(conn, { externalChatId: '5' })).rejects.toThrow()
    const chat = await makeChat(conn, { externalChatId: '6' })
    await addMessage(chat, { externalMessageId: '1' })
    await expect(addMessage(chat, { externalMessageId: '1' })).rejects.toThrow()
  })

  it('cascades chats and messages when a connection row is deleted', async () => {
    const conn = await makeConnection()
    const chat = await makeChat(conn)
    await addMessage(chat)
    await db.delete(connections).where(eq(connections.id, conn.id))
    expect(await db.select().from(chats)).toEqual([])
    expect(await db.select().from(messages)).toEqual([])
  })
})

describe('search_index triggers', () => {
  beforeEach(resetDb)

  it('indexes on insert, re-indexes on a text edit, and prunes on delete', async () => {
    const chat = await makeChat(await makeConnection())
    const m = await addMessage(chat, { text: 'the dentist appointment' })
    expect(await indexRows()).toEqual([{ messageId: m.id, body: 'the dentist appointment' }])

    await db.update(messages).set({ text: 'the plumber appointment' }).where(eq(messages.id, m.id))
    expect(await indexRows()).toEqual([{ messageId: m.id, body: 'the plumber appointment' }])

    await db.delete(messages).where(eq(messages.id, m.id))
    expect(await indexRows()).toEqual([])
  })

  it('stores an empty body for a message with no text', async () => {
    const chat = await makeChat(await makeConnection())
    const m = await addMessage(chat, { text: null, type: 'image' })
    expect(await indexRows()).toEqual([{ messageId: m.id, body: '' }])
  })

  it('prunes the index when a message is removed by cascade, not by a direct delete', async () => {
    const conn = await makeConnection()
    await addMessage(await makeChat(conn), { text: 'cascade me' })
    await db.delete(connections).where(eq(connections.id, conn.id))
    expect(await indexRows()).toEqual([])
  })

  it('MATCH finds an indexed message', async () => {
    const chat = await makeChat(await makeConnection())
    const m = await addMessage(chat, { text: 'ring the dentist on monday' })
    const hits = await db.select({ messageId: searchIndex.messageId }).from(searchIndex)
      .where(sql`search_index MATCH ${'"dentist"'}`)
    expect(hits).toEqual([{ messageId: m.id }])
  })
})
