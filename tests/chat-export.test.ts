import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'

// The route's cookie guard reads cookies() from next/headers, which only
// exists inside a request scope — same in-memory jar convention as
// tests/api-routes.test.ts.
const jar = new Map<string, string>()
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value) },
    delete: (opts: { name: string }) => { jar.delete(opts.name) },
  }),
  headers: async () => new Headers(),
}))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => { throw new Error(`redirect:${url}`) },
}))

import { db } from '@/lib/db/client'
import { accessKeys, chats } from '@/lib/db/schema'
import { resetDb } from './helpers/db'
import { seedChat, seedConnection, seedMessage } from './helpers/archive'
import { mintAccessKey } from '@/lib/services/access-keys'
import { startSession } from '@/lib/auth'
import { FORMAT, importBatch, parseBatch } from '@/lib/services/import'
import { exportChat, type ChatExport } from '@/lib/services/chat-export'
import { GET as getExport } from '@/app/api/chats/[id]/export/route'

async function pushKey(label = 'cron'): Promise<{ id: string; rawKey: string }> {
  const r = await mintAccessKey(label, { read: false, push: true })
  if (!r.ok) throw new Error(r.reason)
  return r
}

const message = (over: Record<string, unknown> = {}) => ({
  externalChatId: 'C01', chatKind: 'group', chatTitle: '#eng', externalMessageId: '1725500000.000100',
  senderExternalId: 'U01', senderName: 'Ada', fromOwner: false, sentAt: '2026-09-05T10:00:00Z',
  type: 'text', text: 'the vendor agreed to net 30', ...over,
})

const batch = (over: Record<string, unknown> = {}): unknown => ({
  format: FORMAT,
  source: { type: 'slack', id: 'acme', label: 'Slack (Acme)' },
  messages: [message()],
  ...over,
})

function parsed(input: unknown) {
  const r = parseBatch(input)
  if (!r.ok) throw new Error(JSON.stringify(r.problems))
  return r.batch
}

async function pushChatId(): Promise<{ chatId: string; connectionId: string; keyId: string; rawKey: string }> {
  const key = await pushKey('agent-a')
  const res = await importBatch(key.id, parsed(batch()))
  const [row] = await db.select({ id: chats.id }).from(chats).where(eq(chats.connectionId, res.source.id))
  return { chatId: row.id, connectionId: res.source.id, keyId: key.id, rawKey: key.rawKey }
}

const bearer = (url: string, raw: string) =>
  new Request(`http://localhost:3000${url}`, { headers: { authorization: `Bearer ${raw}` } })
const cookie = (url: string) => new Request(`http://localhost:3000${url}`)
const params = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(async () => {
  jar.clear()
  await resetDb()
})

describe('exportChat', () => {
  it('returns null for an unknown chat id', async () => {
    expect(await exportChat('nope')).toBeNull()
  })

  it('exports a pushed chat in batch shape, with provenance.pushedBy set to the delivering key label', async () => {
    const { chatId } = await pushChatId()
    const out = await exportChat(chatId)
    expect(out).not.toBeNull()
    const ex = out as ChatExport
    expect(ex.format).toBe('steno/1')
    expect(ex.source).toEqual({ type: 'slack', id: 'acme', label: 'Slack (Acme)', mode: 'push' })
    expect(ex.chat).toMatchObject({ id: chatId, kind: 'group', messageCount: 1 })
    expect(ex.messages).toHaveLength(1)
    const m = ex.messages[0]
    expect(m).toMatchObject({
      externalChatId: 'C01', chatKind: 'group', externalMessageId: '1725500000.000100',
      senderExternalId: 'U01', senderName: 'Ada', fromOwner: false,
      type: 'text', text: 'the vendor agreed to net 30', replyToExternalId: null,
    })
    expect(m.provenance).toEqual({ pushedBy: 'agent-a', conflictedAt: null, editedAt: null })
    expect(ex.deletes).toEqual([])
    // Batch-compatible: strip provenance and this is exactly what the push
    // door accepts.
    const stripped = ex.messages.map(({ provenance: _p, ...rest }) => rest)
    const reparsed = parseBatch({ format: FORMAT, source: { type: 'slack', id: 'acme-2', label: 'x' }, messages: stripped, deletes: ex.deletes })
    expect(reparsed.ok).toBe(true)
  })

  it('exports a live chat with pushedBy null and source.mode live', async () => {
    const conn = await seedConnection({ channel: 'telegram', externalAccountId: '447700900123' })
    const chatId = await seedChat(conn, { title: 'Mum', externalChatId: '42' })
    await seedMessage(chatId, { text: 'hi mum' })

    const out = await exportChat(chatId) as ChatExport
    expect(out.source).toMatchObject({ type: 'telegram', mode: 'live' })
    // Never a channel account identifier, even though the live connection
    // row genuinely carries one (the paired account's id, set the moment
    // login completes) — that is exactly what an agent surface must not leak.
    expect(out.source.id).toBeNull()
    expect(JSON.stringify(out)).not.toContain('447700900123')
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0].provenance).toEqual({ pushedBy: null, conflictedAt: null, editedAt: null })
  })

  it('a tombstoned message appears only in deletes, and none of its text is anywhere in the payload', async () => {
    const { chatId, keyId } = await pushChatId()
    await importBatch(keyId, parsed(batch({
      messages: [message({ externalMessageId: 'm2', text: 'a very secret confession' })],
    })))
    await importBatch(keyId, parsed(batch({ messages: [], deletes: [{ externalChatId: 'C01', externalMessageId: 'm2' }] })))

    const out = await exportChat(chatId) as ChatExport
    expect(out.messages.map(m => m.externalMessageId)).toEqual(['1725500000.000100'])
    expect(out.deletes).toEqual([{ externalChatId: 'C01', externalMessageId: 'm2' }])
    const text = JSON.stringify(out)
    expect(text).not.toContain('a very secret confession')
  })

  it('a conflicted message carries conflictedAt', async () => {
    const { chatId, keyId: a } = await pushChatId()
    const b = await pushKey('agent-b')
    await importBatch(b.id, parsed(batch({ messages: [message({ text: 'a different account of it' })] })))

    const out = await exportChat(chatId) as ChatExport
    const disputed = out.messages.find(m => m.externalMessageId === '1725500000.000100')!
    expect(disputed.provenance.conflictedAt).toEqual(expect.any(String))
    expect(disputed.text).toBe('the vendor agreed to net 30')
    void a
  })

  it('a live WhatsApp-shaped message exports with no raw field, and its JID never appears in the payload', async () => {
    const conn = await seedConnection({ channel: 'whatsapp', externalAccountId: '447700900999' })
    const chatId = await seedChat(conn, { channel: 'whatsapp', title: 'Ada', externalChatId: '447700900123@s.whatsapp.net' })
    const jid = '447700900456:12@s.whatsapp.net'
    await seedMessage(chatId, {
      text: 'see you then', fromOwner: true, senderExternalId: '',
      raw: { key: { remoteJid: '447700900123@s.whatsapp.net', fromMe: true, id: 'ABC123', participant: jid } },
    })

    const out = await exportChat(chatId) as ChatExport
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0]).not.toHaveProperty('raw')
    expect(JSON.stringify(out)).not.toContain(jid)
  })

  it('a pushed message keeps its raw intact, and it still round-trips through parseBatch once provenance is stripped', async () => {
    const key = await pushKey('agent-a')
    const pusherRaw = { origin: 'cron-job', attempt: 3 }
    const res = await importBatch(key.id, parsed(batch({ messages: [message({ raw: pusherRaw })] })))
    const [row] = await db.select({ id: chats.id }).from(chats).where(eq(chats.connectionId, res.source.id))

    const out = await exportChat(row.id) as ChatExport
    const m = out.messages[0]
    expect(m).toHaveProperty('raw')
    // The pusher's own data, verbatim — never re-shaped, never dropped.
    expect(m.raw).toEqual(pusherRaw)

    const stripped = out.messages.map(({ provenance: _p, ...rest }) => rest)
    const reparsed = parseBatch({ format: FORMAT, source: { type: 'slack', id: 'acme-3', label: 'x' }, messages: stripped, deletes: out.deletes })
    expect(reparsed.ok).toBe(true)
  })

  it('no key value, hash, or prefix appears anywhere in the exported JSON', async () => {
    const { chatId, keyId, rawKey } = await pushChatId()
    const [row] = await db.select().from(accessKeys).where(eq(accessKeys.id, keyId))
    const out = await exportChat(chatId) as ChatExport
    const text = JSON.stringify(out)
    expect(text).not.toContain(rawKey)
    expect(text).not.toContain(row.keyHash)
    expect(text).not.toContain(row.keyCiphertext)
    expect(text).not.toContain(row.prefix)
    // A pusher is a key label, and only that.
    expect(text).toContain('agent-a')
  })
})

describe('GET /api/chats/[id]/export', () => {
  it('401s with neither a cookie session nor a bearer key', async () => {
    const res = await getExport(cookie('/api/chats/x/export'), params('x'))
    expect(res.status).toBe(401)
  })

  it('403s a bearer key with the cookie_session_required shape', async () => {
    const { chatId } = await pushChatId()
    const k = await mintAccessKey('agent')
    if (!k.ok) throw new Error(k.reason)
    const res = await getExport(bearer(`/api/chats/${chatId}/export`, k.rawKey), params(chatId))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'cookie_session_required' })
  })

  it('404s an unknown chat over a cookie session', async () => {
    const k = await mintAccessKey('owner')
    if (!k.ok) throw new Error(k.reason)
    await startSession({ keyId: k.id })
    const res = await getExport(cookie('/api/chats/nope/export'), params('nope'))
    expect(res.status).toBe(404)
  })

  it('200s over a cookie session with an attachment header and pretty JSON', async () => {
    const k = await mintAccessKey('owner')
    if (!k.ok) throw new Error(k.reason)
    await startSession({ keyId: k.id })
    const conn = await seedConnection({ channel: 'telegram' })
    const chatId = await seedChat(conn, { title: 'Mum & Dad!', externalChatId: '42' })
    await seedMessage(chatId, { text: 'hi' })

    const res = await getExport(cookie(`/api/chats/${chatId}/export`), params(chatId))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const disposition = res.headers.get('content-disposition') ?? ''
    expect(disposition).toMatch(/^attachment; filename="steno-mum-dad-\d{4}-\d{2}-\d{2}\.json"$/)
    const text = await res.text()
    expect(text).toContain('\n  ') // pretty-printed with two spaces
    const body = JSON.parse(text) as ChatExport
    expect(body.chat.id).toBe(chatId)
  })

  it('falls back to the chat id when there is no usable title', async () => {
    const k = await mintAccessKey('owner')
    if (!k.ok) throw new Error(k.reason)
    await startSession({ keyId: k.id })
    const conn = await seedConnection({ channel: 'telegram' })
    const chatId = await seedChat(conn, { title: null, externalChatId: '42' })
    await seedMessage(chatId, { text: 'hi' })

    const res = await getExport(cookie(`/api/chats/${chatId}/export`), params(chatId))
    const disposition = res.headers.get('content-disposition') ?? ''
    expect(disposition).toContain(`steno-${chatId}-`)
  })
})
