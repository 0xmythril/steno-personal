import { describe, it, expect, beforeEach, vi } from 'vitest'

// lib/auth.ts reads and writes cookies through next/headers, which only
// exists inside a request scope. One in-memory jar stands in for it — the
// same convention as tests/api-connections.test.ts — so the real
// authenticateRequest runs end to end (bearer AND cookie branches) rather
// than being stubbed out. lib/auth.ts does not import 'server-only' (unlike
// some other server modules), so nothing here needs vi.mock('@/lib/auth').
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

import { resetDb } from './helpers/db'
import { seedChat, seedConnection, seedMessage } from './helpers/archive'
import * as queries from '@/lib/services/queries'
import { mintAccessKey } from '@/lib/services/access-keys'
import { createPerson, linkIdentity } from '@/lib/services/people'
import { startSession } from '@/lib/auth'
import { GET as getChats } from '@/app/api/chats/route'
import { GET as getMessagesRoute } from '@/app/api/chats/[id]/messages/route'
import { GET as getSearch } from '@/app/api/search/route'
import { GET as getPeople } from '@/app/api/people/route'

async function key(label = 'agent') {
  const r = await mintAccessKey(label)
  if (!r.ok) throw new Error(r.reason)
  return r
}

// Opens a portal session with a freshly-minted key — the cookie credential,
// as opposed to the same key used as a bearer token.
async function signedIn() {
  const k = await key()
  await startSession({ keyId: k.id })
  return k
}

const bearer = (url: string, raw: string) =>
  new Request(`http://localhost:3000${url}`, { headers: { authorization: `Bearer ${raw}` } })

// No authorization header: authenticateRequest falls through to the cookie
// branch, answered by whatever startSession() put in the jar mock above.
const cookie = (url: string) => new Request(`http://localhost:3000${url}`)

const params = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(async () => {
  jar.clear()
  await resetDb()
})

describe('REST routes reject unauthenticated callers', () => {
  it('401s all four with neither a cookie session nor a bearer key', async () => {
    expect((await getChats(cookie('/api/chats'))).status).toBe(401)
    expect((await getMessagesRoute(cookie('/api/chats/x/messages'), params('x'))).status).toBe(401)
    expect((await getSearch(cookie('/api/search?q=hi'))).status).toBe(401)
    expect((await getPeople(cookie('/api/people'))).status).toBe(401)
  })

  it('401s a request carrying a bad bearer key even with a live cookie session elsewhere', async () => {
    const bad = bearer('/api/chats', 'sp_nope')
    expect((await getChats(bad)).status).toBe(401)
    expect(await (await getChats(bad)).json()).toEqual({ error: 'unauthorized' })
  })
})

describe('REST routes serve the same data as the MCP tools', () => {
  it('GET /api/chats lists chats over a bearer key', async () => {
    const k = await key()
    const conn = await seedConnection()
    await seedChat(conn, { title: 'Mum' })
    const res = await getChats(bearer('/api/chats', k.rawKey))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { chats: Array<{ id: string; title: string | null }> }
    expect(body.chats.map(c => c.title)).toEqual(['Mum'])
  })

  it('GET /api/chats also accepts the portal session cookie', async () => {
    await signedIn()
    const conn = await seedConnection()
    await seedChat(conn, { title: 'Mum' })
    const res = await getChats(cookie('/api/chats'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { chats: Array<{ title: string | null }> }
    expect(body.chats.map(c => c.title)).toEqual(['Mum'])
  })

  it('GET /api/chats/<id>/messages pages and bounds', async () => {
    const k = await key()
    const conn = await seedConnection()
    const chat = await seedChat(conn)
    await seedMessage(chat, { text: 'older', sentAt: new Date('2026-01-01T10:00:00.000Z') })
    await seedMessage(chat, { text: 'newer', sentAt: new Date('2026-02-01T10:00:00.000Z') })

    const all = (await (
      await getMessagesRoute(bearer(`/api/chats/${chat}/messages`, k.rawKey), params(chat))
    ).json()) as { messages: Array<{ text: string | null }> }
    expect(all.messages.map(m => m.text)).toEqual(['newer', 'older'])

    const one = (await (
      await getMessagesRoute(bearer(`/api/chats/${chat}/messages?limit=1`, k.rawKey), params(chat))
    ).json()) as { messages: Array<{ text: string | null }>; nextCursor: string | null }
    expect(one.messages.map(m => m.text)).toEqual(['newer'])
    expect(one.nextCursor).toBeTruthy()

    const bounded = (await (
      await getMessagesRoute(
        bearer(`/api/chats/${chat}/messages?before=2026-01-15T00:00:00.000Z`, k.rawKey),
        params(chat),
      )
    ).json()) as { messages: Array<{ text: string | null }> }
    expect(bounded.messages.map(m => m.text)).toEqual(['older'])
  })

  it('GET /api/chats/<id>/messages 404s an unknown chat', async () => {
    const k = await key()
    const res = await getMessagesRoute(bearer('/api/chats/nope/messages', k.rawKey), params('nope'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })

  it('GET /api/chats/<id>/messages 400s a malformed limit or timestamp', async () => {
    const k = await key()
    const conn = await seedConnection()
    const chat = await seedChat(conn)
    expect(
      (await getMessagesRoute(bearer(`/api/chats/${chat}/messages?limit=lots`, k.rawKey), params(chat))).status,
    ).toBe(400)
    expect(
      (await getMessagesRoute(bearer(`/api/chats/${chat}/messages?limit=0`, k.rawKey), params(chat))).status,
    ).toBe(400)
    expect(
      (await getMessagesRoute(bearer(`/api/chats/${chat}/messages?limit=201`, k.rawKey), params(chat))).status,
    ).toBe(400)
    expect(
      (await getMessagesRoute(bearer(`/api/chats/${chat}/messages?before=yesterday`, k.rawKey), params(chat))).status,
    ).toBe(400)
    expect(
      (await getMessagesRoute(bearer(`/api/chats/${chat}/messages?after=yesterday`, k.rawKey), params(chat))).status,
    ).toBe(400)
  })

  it('GET /api/chats/<id>/messages never leaks deletedAt, raw, or a deleted message', async () => {
    const k = await key()
    const conn = await seedConnection()
    const chat = await seedChat(conn)
    await seedMessage(chat, { text: 'visible' })
    await seedMessage(chat, { text: 'gone', deletedAt: new Date() })
    const res = await getMessagesRoute(bearer(`/api/chats/${chat}/messages`, k.rawKey), params(chat))
    const text = await res.text()
    expect(text).not.toContain('deletedAt')
    expect(text).not.toContain('"raw"')
    expect(text).not.toContain('gone')
    const body = JSON.parse(text) as { messages: Array<{ text: string | null }> }
    expect(body.messages.map(m => m.text)).toEqual(['visible'])
  })

  it('GET /api/search searches, scopes, and needs a query', async () => {
    const k = await key()
    const conn = await seedConnection()
    const mum = await seedChat(conn, { title: 'Mum' })
    const work = await seedChat(conn, { title: 'Work', kind: 'group' })
    await seedMessage(mum, { text: 'bring the umbrella' })
    await seedMessage(work, { text: 'umbrella corp deck' })

    const wide = (await (
      await getSearch(bearer('/api/search?q=umbrella', k.rawKey))
    ).json()) as { results: Array<{ chatId: string }> }
    expect(wide.results).toHaveLength(2)

    const scoped = (await (
      await getSearch(bearer(`/api/search?q=umbrella&chat_id=${mum}`, k.rawKey))
    ).json()) as { results: Array<{ chatId: string }> }
    expect(scoped.results.map(r => r.chatId)).toEqual([mum])

    const missing = await getSearch(bearer('/api/search', k.rawKey))
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ error: 'missing_query' })

    const blank = await getSearch(bearer('/api/search?q=%20%20', k.rawKey))
    expect(blank.status).toBe(400)
  })

  it('GET /api/people lists the address book without a phone number or a channel id', async () => {
    // The same mapping the MCP tool uses, and the same promise: an access key
    // must not be able to read through this route what list_people refuses.
    const k = await key()
    const conn = await seedConnection({ channel: 'telegram' })
    const chat = await seedChat(conn, { title: 'Ada', kind: 'dm', externalChatId: '42' })
    await seedMessage(chat, { text: 'hello' })
    const { id } = await createPerson({ name: 'Ada', notes: 'from the archive' })
    await linkIdentity(id, {
      channel: 'telegram', externalId: '42', displayName: 'Ada', phone: '+447700900123',
    })
    await linkIdentity(id, { channel: 'whatsapp', externalId: '447700900123@s.whatsapp.net' })

    const res = await getPeople(bearer('/api/people', k.rawKey))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({
      people: [{
        id, name: 'Ada', notes: 'from the archive', channels: ['telegram', 'whatsapp'], chatCount: 1,
        dm: [{ id: chat, channel: 'telegram' }],
      }],
      nextCursor: null,
    })
    expect(text).not.toContain('+447700900123')
    expect(text).not.toContain('@s.whatsapp.net')
    expect(text).not.toContain('externalId')

    // The same knobs as the tool: q, limit, cursor, include_chats.
    await createPerson({ name: 'Babbage' })
    const full = (await (await getPeople(bearer('/api/people?q=ada&include_chats=1', k.rawKey))).json()) as {
      people: Array<{ name: string; chats?: unknown[] }>
    }
    expect(full.people.map(p => p.name)).toEqual(['Ada'])
    expect(full.people[0].chats).toEqual([{ id: chat, title: 'Ada', channel: 'telegram', kind: 'dm' }])
    const paged = (await (await getPeople(bearer('/api/people?limit=1', k.rawKey))).json()) as { people: unknown[]; nextCursor: string | null }
    expect(paged.people).toHaveLength(1)
    expect(paged.nextCursor).not.toBeNull()
    const rest = (await (await getPeople(bearer(`/api/people?limit=1&cursor=${encodeURIComponent(paged.nextCursor!)}`, k.rawKey))).json()) as { people: Array<{ name: string }> }
    expect(rest.people.map(p => p.name)).toEqual(['Babbage'])
  })

  it('GET /api/people also accepts the portal session cookie', async () => {
    await signedIn()
    await createPerson({ name: 'Ada' })
    const res = await getPeople(cookie('/api/people'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { people: Array<{ name: string }> }
    expect(body.people.map(p => p.name)).toEqual(['Ada'])
  })

  it('answers a failed query with 500 { error: internal }, never the query or its parameters', async () => {
    // An uncaught throw would escape the handler: Next's HTML 500 instead of
    // the JSON error shape, with drizzle's `Failed query: … params: …`
    // message — the SQL and its bound values — in the log unfiltered.
    const k = await key()
    const spy = vi.spyOn(queries, 'listChats').mockRejectedValue(
      new Error('Failed query: select "title" from "chats"\nparams: ["SECRET"]'),
    )
    try {
      const res = await getChats(bearer('/api/chats', k.rawKey))
      expect(res.status).toBe(500)
      const body = await res.text()
      expect(JSON.parse(body)).toEqual({ error: 'internal' })
      expect(body).not.toContain('SECRET')
      expect(body).not.toContain('Failed query')
    } finally {
      spy.mockRestore()
    }
  })

  it('GET /api/search 400s a malformed limit', async () => {
    const k = await key()
    expect((await getSearch(bearer('/api/search?q=hi&limit=0', k.rawKey))).status).toBe(400)
    expect((await getSearch(bearer('/api/search?q=hi&limit=201', k.rawKey))).status).toBe(400)
  })
})
