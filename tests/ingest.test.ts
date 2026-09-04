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

  // Telegram's edit update carries the whole message, so a row built from it
  // is the real thing.
  it('applyEdit records a Telegram message it has never seen rather than dropping it', async () => {
    const conn = await makeConnection()
    await applyEdit(conn.id, 'telegram', msg({ externalMessageId: '7', text: 'appeared via edit' }))
    const rows = await db.select().from(messages)
    expect(rows).toHaveLength(1)
    expect(rows[0].text).toBe('appeared via edit')
  })

  // WhatsApp's does not: it is the protocol envelope, with no sender, the
  // edit's own timestamp and a protocolMessage for `raw`. Stored under the
  // original's id it would win first-writer-wins and suppress the real message
  // when the history sync delivers it — which, on WhatsApp, it does minutes
  // later while live edits are still arriving.
  it('applyEdit drops a WhatsApp edit for a message it has never seen', async () => {
    const conn = await makeConnection({ channel: 'whatsapp' })
    const edit = msg({
      externalChatId: '12345-67890@g.us', externalMessageId: 'W1',
      senderExternalId: null, senderName: null, text: 'edited text',
      raw: { message: { protocolMessage: { type: 14 } } },
    })
    await applyEdit(conn.id, 'whatsapp', edit)
    expect(await db.select().from(messages)).toEqual([])

    // …and the real message still lands, in full, when history catches up.
    await recordMessage(conn.id, 'whatsapp', msg({
      externalChatId: '12345-67890@g.us', externalMessageId: 'W1',
      senderExternalId: '15559990000@s.whatsapp.net', senderName: 'Ada', text: 'original text',
    }))
    const rows = await db.select().from(messages)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ text: 'original text', senderName: 'Ada' })
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

// WhatsApp cannot check who sent a revoke or an edit (the payload is
// end-to-end encrypted), and Baileys forwards them from anyone. Official
// clients only honour one from the message's own author; so does the archive,
// when the port says who acted. A ref without an actor (Telegram, whose
// server has already authorised the delete) is applied as before.
describe('ingest authorship', () => {
  beforeEach(resetDb)
  const CHAT = '12345-67890@g.us'
  const ada = { senderExternalId: '15559990000@s.whatsapp.net', senderName: 'Ada', fromOwner: false }
  const wa = (over: Partial<IncomingMessage> = {}) => msg({ externalChatId: CHAT, ...ada, ...over })

  async function seed() {
    const conn = await makeConnection({ channel: 'whatsapp' })
    await recordMessage(conn.id, 'whatsapp', wa({ externalMessageId: 'OWN', fromOwner: true, senderExternalId: '15551234567@s.whatsapp.net', senderName: null, text: 'mine' }))
    await recordMessage(conn.id, 'whatsapp', wa({ externalMessageId: 'ADA', text: 'hers' }))
    return conn
  }
  const rowsById = async () => Object.fromEntries((await db.select().from(messages)).map(r => [r.externalMessageId, r]))

  it('a revoke from someone other than the author leaves the row alone', async () => {
    const conn = await seed()
    const bob = { fromOwner: false, senderExternalId: '15550001111@s.whatsapp.net' }
    await applyDelete(conn.id, { externalChatId: CHAT, externalMessageId: 'OWN', actor: bob })
    await applyDelete(conn.id, { externalChatId: CHAT, externalMessageId: 'ADA', actor: bob })
    await applyDelete(conn.id, { externalChatId: CHAT, externalMessageId: 'ADA', actor: { fromOwner: false, senderExternalId: null } })
    const rows = await rowsById()
    expect(rows.OWN.deletedAt).toBeNull()
    expect(rows.ADA.deletedAt).toBeNull()
  })

  it('a revoke from the author tombstones the row, for the owner and for a contact', async () => {
    const conn = await seed()
    await applyDelete(conn.id, { externalChatId: CHAT, externalMessageId: 'OWN', actor: { fromOwner: true, senderExternalId: null } })
    await applyDelete(conn.id, { externalChatId: CHAT, externalMessageId: 'ADA', actor: { fromOwner: false, senderExternalId: ada.senderExternalId } })
    const rows = await rowsById()
    expect(rows.OWN.deletedAt).toBeInstanceOf(Date)
    expect(rows.ADA.deletedAt).toBeInstanceOf(Date)
  })

  it('an edit from someone other than the author changes nothing', async () => {
    const conn = await seed()
    await applyEdit(conn.id, 'whatsapp', wa({ externalMessageId: 'OWN', text: 'forged', actor: { fromOwner: false, senderExternalId: ada.senderExternalId } }))
    await applyEdit(conn.id, 'whatsapp', wa({ externalMessageId: 'ADA', text: 'forged', actor: { fromOwner: false, senderExternalId: '15550001111@s.whatsapp.net' } }))
    const rows = await rowsById()
    expect(rows.OWN).toMatchObject({ text: 'mine', editedAt: null })
    expect(rows.ADA).toMatchObject({ text: 'hers', editedAt: null })
  })

  it('an edit from the author is applied', async () => {
    const conn = await seed()
    await applyEdit(conn.id, 'whatsapp', wa({ externalMessageId: 'OWN', text: 'mine, fixed', actor: { fromOwner: true, senderExternalId: null } }))
    await applyEdit(conn.id, 'whatsapp', wa({ externalMessageId: 'ADA', text: 'hers, fixed', actor: { fromOwner: false, senderExternalId: ada.senderExternalId } }))
    const rows = await rowsById()
    expect(rows.OWN.text).toBe('mine, fixed')
    expect(rows.ADA.text).toBe('hers, fixed')
  })
})
