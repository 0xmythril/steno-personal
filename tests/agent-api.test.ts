import { describe, it, expect, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { resetDb } from './helpers/db'
import { makeConnection, makeChat, addMessage } from './helpers/fixtures'
import { makeMedia } from './helpers/media-fixtures'
import { callTool, listTools, rpc } from './helpers/mcp'
import { db } from '@/lib/db/client'
import { channelContacts, media } from '@/lib/db/schema'
import { mintAccessKey } from '@/lib/services/access-keys'
import { mediaDir } from '@/lib/services/media'
import { createPerson, linkIdentity, publicPeople } from '@/lib/services/people'
import {
  getMessages, mediaView, pageChats, recentMessages, searchMessages,
} from '@/lib/services/queries'
import { MEDIA_NOT_FOUND } from '@/lib/mcp/copy'

async function agentKey(): Promise<string> {
  const r = await mintAccessKey('agent')
  if (!r.ok) throw new Error(r.reason)
  return r.rawKey
}

const at = (iso: string) => new Date(iso)

// A chat whose activity is fixed, so ordering and cursors are deterministic.
async function chatAt(conn: { id: string; channel: 'telegram' | 'whatsapp' }, title: string, iso: string, opts: {
  kind?: 'dm' | 'group' | 'channel'; text?: string | null
} = {}) {
  const chat = await makeChat(conn, { title, kind: opts.kind ?? 'dm', lastMessageAt: at(iso) })
  await addMessage(chat, { text: opts.text === undefined ? `in ${title}` : opts.text, sentAt: at(iso) })
  return chat
}

describe('pageChats — the aimed chat list', () => {
  beforeEach(resetDb)

  it('filters by channel and kind, and lists everything otherwise', async () => {
    const tg = await makeConnection({ channel: 'telegram' })
    const wa = await makeConnection({ channel: 'whatsapp' })
    const tgDm = await chatAt(tg, 'TG DM', '2026-01-01T00:00:00Z')
    const waDm = await chatAt(wa, 'WA DM', '2026-01-02T00:00:00Z')
    const waGroup = await chatAt(wa, 'WA Group', '2026-01-03T00:00:00Z', { kind: 'group' })

    const ids = (o: { chats: Array<{ id: string }> }) => o.chats.map(c => c.id)
    expect(ids(await pageChats())).toEqual([waGroup.id, waDm.id, tgDm.id])
    expect(ids(await pageChats({ channel: 'whatsapp' }))).toEqual([waGroup.id, waDm.id])
    expect(ids(await pageChats({ kind: 'group' }))).toEqual([waGroup.id])
    expect(ids(await pageChats({ channel: 'telegram', kind: 'group' }))).toEqual([])
  })

  it('matches q against the displayed title, case-insensitively, with LIKE wildcards taken literally', async () => {
    const conn = await makeConnection({ channel: 'whatsapp' })
    const air = await chatAt(conn, 'Air Asia flight', '2026-01-01T00:00:00Z')
    await chatAt(conn, 'Book club', '2026-01-02T00:00:00Z')
    const pct = await chatAt(conn, '100% done', '2026-01-03T00:00:00Z')
    // The title an agent sees is the resolved one, so a DM with no stored
    // title is still found by the name of the person who last wrote in it.
    const untitled = await makeChat(conn, { title: null, lastMessageAt: at('2026-01-04T00:00:00Z') })
    await addMessage(untitled, { senderName: 'Airi Sato', sentAt: at('2026-01-04T00:00:00Z') })

    const ids = (o: { chats: Array<{ id: string }> }) => o.chats.map(c => c.id)
    expect(ids(await pageChats({ q: 'air' }))).toEqual([untitled.id, air.id])
    expect(ids(await pageChats({ q: 'AIR ASIA' }))).toEqual([air.id])
    expect(ids(await pageChats({ q: '%' }))).toEqual([pct.id])
    expect(ids(await pageChats({ q: 'nothing like this' }))).toEqual([])
  })

  it('pages with an opaque cursor in activity order and never repeats or skips a chat', async () => {
    const conn = await makeConnection({ channel: 'telegram' })
    const made: string[] = []
    for (let i = 0; i < 5; i++) {
      made.push((await chatAt(conn, `Chat ${i}`, `2026-01-0${i + 1}T00:00:00Z`)).id)
    }
    const expected = [...made].reverse()

    const first = await pageChats({ limit: 2 })
    expect(first.chats.map(c => c.id)).toEqual(expected.slice(0, 2))
    expect(first.nextCursor).not.toBeNull()
    const second = await pageChats({ limit: 2, cursor: first.nextCursor! })
    expect(second.chats.map(c => c.id)).toEqual(expected.slice(2, 4))
    const third = await pageChats({ limit: 2, cursor: second.nextCursor! })
    expect(third.chats.map(c => c.id)).toEqual(expected.slice(4))
    expect(third.nextCursor).toBeNull()
    // The cursor is opaque: no timestamp or id in readable form.
    expect(first.nextCursor).not.toMatch(/2026|-/)
  })

  it('carries a snippet of the latest live message, or null when there is none', async () => {
    const conn = await makeConnection({ channel: 'telegram' })
    const chat = await makeChat(conn, { title: 'Mum', lastMessageAt: at('2026-01-02T00:00:00Z') })
    await addMessage(chat, { text: 'older line', sentAt: at('2026-01-01T00:00:00Z') })
    await addMessage(chat, { text: 'x'.repeat(500), sentAt: at('2026-01-02T00:00:00Z') })
    await addMessage(chat, { text: 'unsent', sentAt: at('2026-01-03T00:00:00Z'), deletedAt: new Date() })
    const empty = await makeChat(conn, { title: 'Quiet' })

    const byId = new Map((await pageChats()).chats.map(c => [c.id, c.snippet]))
    expect(byId.get(chat.id)).toBe('x'.repeat(160))
    expect(byId.get(empty.id)).toBeNull()
  })

  it('snippet names what a textless latest message is, and looks past system rows', async () => {
    const conn = await makeConnection({ channel: 'whatsapp' })
    const chat = await makeChat(conn, { kind: 'group', title: 'Air Asia group' })
    const snippet = async () => (await pageChats()).chats[0].snippet
    await addMessage(chat, { text: 'see attached', sentAt: at('2026-01-01T00:00:00Z') })
    await addMessage(chat, { text: null, type: 'image', sentAt: at('2026-01-02T00:00:00Z') })
    expect(await snippet()).toBe('[image]')
    await addMessage(chat, { text: 'a caption', type: 'image', sentAt: at('2026-01-03T00:00:00Z') })
    expect(await snippet()).toBe('a caption')
    await addMessage(chat, { text: '👍', type: 'reaction', sentAt: at('2026-01-04T00:00:00Z') })
    expect(await snippet()).toBe('Reacted 👍')
    await addMessage(chat, { text: null, type: 'unknown', sentAt: at('2026-01-05T00:00:00Z') })
    expect(await snippet()).toBe('[unsupported message]')
    // A system row (someone joined, the subject changed) is not conversation.
    await addMessage(chat, { text: null, type: 'system', sentAt: at('2026-01-06T00:00:00Z') })
    expect(await snippet()).toBe('[unsupported message]')
    const onlySystem = await makeChat(conn, { kind: 'group', title: 'New group' })
    await addMessage(onlySystem, { text: null, type: 'system', sentAt: at('2026-01-07T00:00:00Z') })
    expect((await pageChats()).chats.find(c => c.id === onlySystem.id)!.snippet).toBeNull()
  })
})

describe('recentMessages — the inbox', () => {
  beforeEach(resetDb)

  it('lists the newest messages across every chat, with the chat named on each line', async () => {
    const tg = await makeConnection({ channel: 'telegram' })
    const wa = await makeConnection({ channel: 'whatsapp' })
    const mum = await makeChat(tg, { title: 'Mum' })
    const work = await makeChat(wa, { title: 'Work', kind: 'group' })
    await addMessage(mum, { text: 'first', sentAt: at('2026-01-01T00:00:00Z') })
    await addMessage(work, { text: 'second', sentAt: at('2026-01-02T00:00:00Z') })
    await addMessage(mum, { text: 'third', sentAt: at('2026-01-03T00:00:00Z') })
    await addMessage(work, { text: 'unsent', sentAt: at('2026-01-04T00:00:00Z'), deletedAt: new Date() })

    const all = await recentMessages()
    expect(all.messages.map(m => m.text)).toEqual(['third', 'second', 'first'])
    expect(all.messages[0]).toMatchObject({ chatId: mum.id, chatTitle: 'Mum', channel: 'telegram', kind: 'dm' })
    expect(all.messages[1]).toMatchObject({ chatId: work.id, chatTitle: 'Work', channel: 'whatsapp', kind: 'group' })

    expect((await recentMessages({ channel: 'whatsapp' })).messages.map(m => m.text)).toEqual(['second'])
    expect((await recentMessages({ kind: 'dm' })).messages.map(m => m.text)).toEqual(['third', 'first'])
    expect((await recentMessages({ before: at('2026-01-02T12:00:00Z') })).messages.map(m => m.text)).toEqual(['second', 'first'])
  })

  it('pages with a cursor', async () => {
    const conn = await makeConnection({ channel: 'telegram' })
    const chat = await makeChat(conn, { title: 'Mum' })
    for (let i = 1; i <= 5; i++) await addMessage(chat, { text: `m${i}`, sentAt: at(`2026-01-0${i}T00:00:00Z`) })
    const first = await recentMessages({ limit: 2 })
    expect(first.messages.map(m => m.text)).toEqual(['m5', 'm4'])
    const second = await recentMessages({ limit: 2, cursor: first.nextCursor! })
    expect(second.messages.map(m => m.text)).toEqual(['m3', 'm2'])
    const third = await recentMessages({ limit: 2, cursor: second.nextCursor! })
    expect(third.messages.map(m => m.text)).toEqual(['m1'])
    expect(third.nextCursor).toBeNull()
  })
})

describe('searchMessages — filters', () => {
  beforeEach(resetDb)

  it('narrows by channel, kind, sender and date, and bounds the page', async () => {
    const tg = await makeConnection({ channel: 'telegram' })
    const wa = await makeConnection({ channel: 'whatsapp' })
    const mum = await makeChat(tg, { title: 'Mum' })
    const work = await makeChat(wa, { title: 'Work', kind: 'group' })
    await addMessage(mum, { text: 'dentist monday', senderName: 'Mum', sentAt: at('2026-01-01T00:00:00Z') })
    await addMessage(work, { text: 'dentist tuesday', senderName: 'Kim Smith', sentAt: at('2026-02-01T00:00:00Z') })
    await addMessage(work, { text: 'dentist wednesday', senderName: 'Kim Smith', sentAt: at('2026-03-01T00:00:00Z') })

    const texts = async (opts: Parameters<typeof searchMessages>[1]) =>
      (await searchMessages('dentist', opts)).map(h => h.text).sort()

    expect(await texts({})).toEqual(['dentist monday', 'dentist tuesday', 'dentist wednesday'])
    expect(await texts({ channel: 'telegram' })).toEqual(['dentist monday'])
    expect(await texts({ kind: 'group' })).toEqual(['dentist tuesday', 'dentist wednesday'])
    expect(await texts({ sender: 'kim' })).toEqual(['dentist tuesday', 'dentist wednesday'])
    expect(await texts({ after: at('2026-01-15T00:00:00Z'), before: at('2026-02-15T00:00:00Z') })).toEqual(['dentist tuesday'])
    expect(await texts({ chatId: mum.id })).toEqual(['dentist monday'])
    expect((await searchMessages('dentist', { limit: 1 }))).toHaveLength(1)

    const [hit] = await searchMessages('dentist', { channel: 'telegram' })
    expect(hit).toMatchObject({ chatId: mum.id, chatTitle: 'Mum', channel: 'telegram', kind: 'dm' })
  })

  it('matches sender against the address-book name too', async () => {
    const wa = await makeConnection({ channel: 'whatsapp' })
    const chat = await makeChat(wa, { title: 'Work', kind: 'group' })
    await addMessage(chat, { text: 'dentist', senderName: null, senderExternalId: '15551230000@s.whatsapp.net' })
    const { id } = await createPerson({ name: 'Ada Lovelace' })
    await linkIdentity(id, { channel: 'whatsapp', externalId: '15551230000@s.whatsapp.net' })
    expect(await searchMessages('dentist', { sender: 'lovelace' })).toHaveLength(1)
    expect(await searchMessages('dentist', { sender: 'babbage' })).toEqual([])
  })
})

describe('attachment state on a message', () => {
  beforeEach(resetDb)

  it('says whether the bytes are ready, pending, failed, or were never queued', async () => {
    const conn = await makeConnection({ channel: 'telegram' })
    const chat = await makeChat(conn, { title: 'Mum' })
    const ready = await addMessage(chat, { type: 'image', text: null, hasMedia: true, sentAt: at('2026-01-01T00:00:00Z') })
    const pending = await addMessage(chat, { type: 'image', text: null, hasMedia: true, sentAt: at('2026-01-02T00:00:00Z') })
    const failed = await addMessage(chat, { type: 'document', text: null, hasMedia: true, sentAt: at('2026-01-03T00:00:00Z') })
    const orphan = await addMessage(chat, { type: 'image', text: null, hasMedia: true, sentAt: at('2026-01-04T00:00:00Z') })
    const plain = await addMessage(chat, { text: 'hi', sentAt: at('2026-01-05T00:00:00Z') })
    const readyRow = await makeMedia(ready.id, conn.id, { mimeType: 'image/jpeg', sizeBytes: 12, storagePath: 'x.jpg', status: 'done' })
    await makeMedia(pending.id, conn.id, { mimeType: 'image/jpeg', status: 'pending' })
    await makeMedia(failed.id, conn.id, { mimeType: 'application/pdf', status: 'failed' })

    const out = (await getMessages(chat.id))!
    const byId = new Map(out.messages.map(m => [m.id, m.media]))
    expect(byId.get(ready.id)).toMatchObject({ id: readyRow.id, status: 'ready', url: `/media/${readyRow.id}`, mimeType: 'image/jpeg', sizeBytes: 12 })
    expect(byId.get(pending.id)).toMatchObject({ status: 'pending', url: null })
    expect(byId.get(failed.id)).toMatchObject({ status: 'failed', url: null, mimeType: 'application/pdf' })
    expect(byId.get(orphan.id)).toMatchObject({ id: null, status: 'unavailable', url: null })
    expect(byId.get(plain.id)).toBeNull()
  })

  it('mediaView answers for a live message only', async () => {
    const conn = await makeConnection({ channel: 'telegram' })
    const chat = await makeChat(conn, { title: 'Mum' })
    const live = await addMessage(chat, { type: 'image', text: null, hasMedia: true })
    const gone = await addMessage(chat, { type: 'image', text: null, hasMedia: true, deletedAt: new Date() })
    const a = await makeMedia(live.id, conn.id, { mimeType: 'image/png', status: 'done', storagePath: 'a.png' })
    const b = await makeMedia(gone.id, conn.id, { mimeType: 'image/png', status: 'done', storagePath: 'b.png' })
    expect(await mediaView(a.id)).toMatchObject({ id: a.id, status: 'ready', messageId: live.id, chatId: chat.id })
    expect(await mediaView(b.id)).toBeNull()
    expect(await mediaView('no-such-id')).toBeNull()
  })
})

describe('publicPeople — which chats', () => {
  beforeEach(resetDb)

  it('names the chats a person appears in, and filters by q', async () => {
    const wa = await makeConnection({ channel: 'whatsapp' })
    const dm = await makeChat(wa, { title: null, externalChatId: '15551230000@s.whatsapp.net' })
    const group = await makeChat(wa, { title: 'Work', kind: 'group' })
    await addMessage(group, { text: 'hi', senderName: null, senderExternalId: '15551230000@s.whatsapp.net' })
    await addMessage(dm, { text: 'hi', senderName: null, senderExternalId: '15551230000@s.whatsapp.net' })
    const { id } = await createPerson({ name: 'Ada Lovelace' })
    await linkIdentity(id, { channel: 'whatsapp', externalId: '15551230000@s.whatsapp.net' })
    await createPerson({ name: 'Charles Babbage' })

    const [ada] = await publicPeople({ q: 'ada' })
    expect(ada.name).toBe('Ada Lovelace')
    expect(ada.chatCount).toBe(2)
    expect(ada.chats.map(c => c.id).sort()).toEqual([dm.id, group.id].sort())
    expect(ada.chats.find(c => c.id === dm.id)).toMatchObject({ title: 'Ada Lovelace', channel: 'whatsapp', kind: 'dm' })
    expect(ada.chats.find(c => c.id === group.id)).toMatchObject({ title: 'Work', kind: 'group' })
    expect(JSON.stringify(ada)).not.toContain('1555123')
    expect((await publicPeople()).map(p => p.name).sort()).toEqual(['Ada Lovelace', 'Charles Babbage'])
    expect(await publicPeople({ q: 'nobody' })).toEqual([])
  })
})

describe('the MCP surface', () => {
  beforeEach(resetDb)

  it('lists exactly the seven read tools, each declared read-only', async () => {
    const tools = await listTools(await agentKey())
    expect(tools.map(t => t.name).sort()).toEqual([
      'get_media', 'get_messages', 'list_chats', 'list_people', 'recent_messages', 'search_messages', 'whoami',
    ])
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBe(true)
      expect(tool.annotations?.destructiveHint, `${tool.name} destructiveHint`).toBe(false)
      expect(tool.annotations?.openWorldHint, `${tool.name} openWorldHint`).toBe(false)
    }
  })

  it('list_chats takes filters and pages, and answers with chats plus a cursor', async () => {
    const conn = await makeConnection({ channel: 'whatsapp' })
    await chatAt(conn, 'Air Asia', '2026-01-01T00:00:00Z')
    await chatAt(conn, 'Book club', '2026-01-02T00:00:00Z', { kind: 'group' })
    await chatAt(conn, 'Air miles', '2026-01-03T00:00:00Z')
    const key = await agentKey()

    const all = JSON.parse(await callTool(key, 'list_chats', {})) as { chats: Array<{ title: string; snippet: string | null }>; nextCursor: string | null }
    expect(all.chats.map(c => c.title)).toEqual(['Air miles', 'Book club', 'Air Asia'])
    expect(all.chats[0].snippet).toBe('in Air miles')
    expect(all.nextCursor).toBeNull()

    const q = JSON.parse(await callTool(key, 'list_chats', { q: 'air', limit: 1 })) as { chats: Array<{ title: string }>; nextCursor: string | null }
    expect(q.chats.map(c => c.title)).toEqual(['Air miles'])
    const next = JSON.parse(await callTool(key, 'list_chats', { q: 'air', limit: 1, cursor: q.nextCursor })) as { chats: Array<{ title: string }> }
    expect(next.chats.map(c => c.title)).toEqual(['Air Asia'])

    expect(JSON.parse(await callTool(key, 'list_chats', { kind: 'group' })).chats.map((c: { title: string }) => c.title)).toEqual(['Book club'])
    expect(await callTool(key, 'list_chats', { channel: 'signal' })).toMatch(/channel/)
  })

  it('recent_messages answers with the newest lines across chats', async () => {
    const conn = await makeConnection({ channel: 'telegram' })
    const mum = await makeChat(conn, { title: 'Mum' })
    const work = await makeChat(conn, { title: 'Work', kind: 'group' })
    await addMessage(mum, { text: 'first', sentAt: at('2026-01-01T00:00:00Z') })
    await addMessage(work, { text: 'second', sentAt: at('2026-01-02T00:00:00Z') })
    const out = JSON.parse(await callTool(await agentKey(), 'recent_messages', { limit: 1 })) as {
      messages: Array<{ text: string; chatTitle: string }>; nextCursor: string | null
    }
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0]).toMatchObject({ text: 'second', chatTitle: 'Work' })
    expect(out.nextCursor).not.toBeNull()
  })

  it('search_messages takes the same filters', async () => {
    const tg = await makeConnection({ channel: 'telegram' })
    const wa = await makeConnection({ channel: 'whatsapp' })
    await addMessage(await makeChat(tg, { title: 'Mum' }), { text: 'dentist monday', senderName: 'Mum' })
    await addMessage(await makeChat(wa, { title: 'Work', kind: 'group' }), { text: 'dentist tuesday', senderName: 'Kim' })
    const key = await agentKey()
    const hits = JSON.parse(await callTool(key, 'search_messages', { query: 'dentist', channel: 'whatsapp', sender: 'kim', limit: 5 })) as Array<{ text: string }>
    expect(hits.map(h => h.text)).toEqual(['dentist tuesday'])
  })

  it('never puts the channel message id in front of an agent', async () => {
    const conn = await makeConnection({ channel: 'telegram' })
    const chat = await makeChat(conn, { title: 'Mum' })
    await addMessage(chat, { text: 'dentist', externalMessageId: 'ext-msg-4242' })
    const key = await agentKey()
    for (const [name, args] of [
      ['get_messages', { chat_id: chat.id }],
      ['search_messages', { query: 'dentist' }],
      ['recent_messages', {}],
    ] as const) {
      const out = await callTool(key, name, args)
      expect(out, name).toContain('dentist')
      expect(out, name).not.toContain('ext-msg-4242')
      expect(out, name).not.toContain('externalMessageId')
    }
  })

  it('get_media hands an image back inline and everything else as metadata', async () => {
    const conn = await makeConnection({ channel: 'telegram' })
    const chat = await makeChat(conn, { title: 'Mum' })
    const pic = await addMessage(chat, { type: 'image', text: null, hasMedia: true })
    const pdf = await addMessage(chat, { type: 'document', text: null, hasMedia: true })
    const image = await makeMedia(pic.id, conn.id, { mimeType: 'image/png', status: 'done' })
    const doc = await makeMedia(pdf.id, conn.id, { mimeType: 'application/pdf', status: 'done' })
    mkdirSync(mediaDir(), { recursive: true })
    writeFileSync(`${mediaDir()}/${image.id}.png`, 'PNGBYTES')
    writeFileSync(`${mediaDir()}/${doc.id}.pdf`, 'PDFBYTES')
    await db.update(media).set({ storagePath: `${image.id}.png`, sizeBytes: 8 }).where(eq(media.id, image.id))
    await db.update(media).set({ storagePath: `${doc.id}.pdf`, sizeBytes: 8 }).where(eq(media.id, doc.id))
    const key = await agentKey()

    const call = (id: string) => rpc(key, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_media', arguments: { media_id: id } } })

    const img = (await call(image.id)).message!.result!.content as Array<{ type: string; data?: string; mimeType?: string; text?: string }>
    const inline = img.find(c => c.type === 'image')
    expect(inline).toMatchObject({ mimeType: 'image/png', data: Buffer.from('PNGBYTES').toString('base64') })
    const meta = JSON.parse(img.find(c => c.type === 'text')!.text!) as { id: string; status: string; url: string; chatId: string }
    expect(meta).toMatchObject({ id: image.id, status: 'ready', url: `/media/${image.id}`, chatId: chat.id })

    const other = (await call(doc.id)).message!.result!.content as Array<{ type: string; text?: string }>
    expect(other.every(c => c.type === 'text')).toBe(true)
    expect(JSON.parse(other[0].text!)).toMatchObject({ id: doc.id, mimeType: 'application/pdf', url: `/media/${doc.id}` })

    expect(await callTool(key, 'get_media', { media_id: 'no-such' })).toBe(MEDIA_NOT_FOUND)
  })

  it('get_media on an attachment still downloading says so instead of guessing', async () => {
    const conn = await makeConnection({ channel: 'telegram' })
    const chat = await makeChat(conn, { title: 'Mum' })
    const pic = await addMessage(chat, { type: 'image', text: null, hasMedia: true })
    const row = await makeMedia(pic.id, conn.id, { mimeType: 'image/png', status: 'pending' })
    const out = JSON.parse(await callTool(await agentKey(), 'get_media', { media_id: row.id })) as { status: string; url: string | null }
    expect(out).toMatchObject({ status: 'pending', url: null })
  })

  it('list_people takes q and names each person’s chats', async () => {
    const wa = await makeConnection({ channel: 'whatsapp' })
    const dm = await makeChat(wa, { title: null, externalChatId: '15551230000@s.whatsapp.net' })
    await addMessage(dm, { text: 'hi', senderName: null, senderExternalId: '15551230000@s.whatsapp.net' })
    const { id } = await createPerson({ name: 'Ada Lovelace' })
    await linkIdentity(id, { channel: 'whatsapp', externalId: '15551230000@s.whatsapp.net' })
    await createPerson({ name: 'Charles Babbage' })
    const out = JSON.parse(await callTool(await agentKey(), 'list_people', { q: 'ada' })) as Array<{
      name: string; chats: Array<{ id: string; title: string | null; channel: string; kind: string }>
    }>
    expect(out.map(p => p.name)).toEqual(['Ada Lovelace'])
    expect(out[0].chats).toEqual([{ id: dm.id, title: 'Ada Lovelace', channel: 'whatsapp', kind: 'dm' }])
    expect(JSON.stringify(out)).not.toContain('1555123')
  })

  it('whoami falls back to the name the contact cache holds for the account itself', async () => {
    const conn = await makeConnection({ channel: 'whatsapp', displayName: null, externalAccountId: '15550001111@s.whatsapp.net' })
    await db.insert(channelContacts).values({
      connectionId: conn.id, channel: 'whatsapp', externalId: '15550001111@s.whatsapp.net', displayName: 'Me on WhatsApp',
    })
    const out = JSON.parse(await callTool(await agentKey(), 'whoami')) as { connections: Array<{ displayName: string | null }> }
    expect(out.connections.map(c => c.displayName)).toEqual(['Me on WhatsApp'])
    expect(JSON.stringify(out)).not.toContain('1555000')
  })
})
