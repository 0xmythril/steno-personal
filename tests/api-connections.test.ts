import { describe, it, expect, beforeEach, vi } from 'vitest'

// lib/auth.ts reads and writes cookies through next/headers, which only exists
// inside a request scope. One in-memory jar stands in for it so the real auth
// path — including the cookie branch — is exercised rather than stubbed out.
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

const { db } = await import('@/lib/db/client')
const { connections } = await import('@/lib/db/schema')
const { eq } = await import('drizzle-orm')
const { resetDb } = await import('./helpers/db')
const { makeConnection } = await import('./helpers/fixtures')
const { mintAccessKey, revokeAccessKey } = await import('@/lib/services/access-keys')
const { authenticateRequest, SESSION_COOKIE, startSession } = await import('@/lib/auth')
const { PASSWORD_REJECTED } = await import('@/lib/services/connections')
const { decryptSecret } = await import('@/lib/services/crypto')
const createRoute = await import('@/app/api/connections/route')
const idRoute = await import('@/app/api/connections/[id]/route')
const revokeRoute = await import('@/app/api/connections/[id]/revoke/route')
const passwordRoute = await import('@/app/api/connections/[id]/password/route')

async function key(label = 'agent') {
  const r = await mintAccessKey(label)
  if (!r.ok) throw new Error(r.reason)
  return r
}

const bearer = (raw: string, init: RequestInit = {}) =>
  new Request('http://local/api/connections', { ...init, headers: { authorization: `Bearer ${raw}`, ...(init.headers ?? {}) } })

// No authorization header: authenticateRequest falls through to the cookie
// branch, which the jar mock above answers from whatever startSession() set.
const cookie = (init: RequestInit = {}) => new Request('http://local/api/connections', init)

// Mints a key and opens a portal session with it — the browser's credential,
// as opposed to the same key used as a bearer token.
async function signedIn() {
  const k = await key()
  await startSession(k.id)
  return k
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })

describe('authenticateRequest', () => {
  beforeEach(async () => { jar.clear(); await resetDb() })

  it('accepts a valid bearer key and reports how it authenticated', async () => {
    const k = await key()
    expect(await authenticateRequest(bearer(k.rawKey))).toEqual({ via: 'bearer', keyId: k.id })
  })

  it('rejects an unknown, malformed, or revoked bearer key without falling back to the cookie', async () => {
    const k = await key()
    await startSession(k.id) // a live cookie session exists…
    await revokeAccessKey(k.id)
    expect(await authenticateRequest(bearer(k.rawKey))).toBeNull()
    expect(await authenticateRequest(bearer('sp_nope'))).toBeNull()
    expect(await authenticateRequest(bearer(''))).toBeNull()
  })

  it('accepts the session cookie when no bearer header is present', async () => {
    const k = await key()
    await startSession(k.id)
    expect(jar.get(SESSION_COOKIE)).toBeTruthy()
    const req = new Request('http://local/api/connections')
    expect(await authenticateRequest(req)).toEqual({ via: 'cookie', keyId: k.id })
  })

  it('rejects a request with neither', async () => {
    expect(await authenticateRequest(new Request('http://local/api/connections'))).toBeNull()
  })
})

describe('connections API', () => {
  beforeEach(async () => { jar.clear(); await resetDb() })

  it('refuses every route without credentials', async () => {
    const conn = await makeConnection()
    const anon = () => new Request('http://local/x', { method: 'POST', body: '{}' })
    expect((await createRoute.POST(anon())).status).toBe(401)
    expect((await idRoute.GET(new Request('http://local/x'), params(conn.id))).status).toBe(401)
    expect((await idRoute.DELETE(new Request('http://local/x', { method: 'DELETE' }), params(conn.id))).status).toBe(401)
    expect((await revokeRoute.POST(anon(), params(conn.id))).status).toBe(401)
    expect((await passwordRoute.POST(anon(), params(conn.id))).status).toBe(401)
  })

  it('refuses a bearer key on every /api/connections route, reads included', async () => {
    // An access key is the credential the owner pastes into agents (M3), and
    // those agents read attacker-controlled chat text. It may not create,
    // disconnect, delete, or answer a 2FA prompt — nor read the status, whose
    // payload carries the pairing QR: that QR is the credential for linking a
    // device to the channel account, so a read key must never see it. 403,
    // not 401: the credential is valid, the route is not.
    const k = await key()
    const conn = await makeConnection({ status: 'active' })
    const forbidden = [
      await createRoute.POST(bearer(k.rawKey, { method: 'POST', body: JSON.stringify({ channel: 'telegram' }) })),
      await idRoute.GET(bearer(k.rawKey), params(conn.id)),
      await idRoute.DELETE(bearer(k.rawKey, { method: 'DELETE' }), params(conn.id)),
      await revokeRoute.POST(bearer(k.rawKey, { method: 'POST' }), params(conn.id)),
      await passwordRoute.POST(bearer(k.rawKey, { method: 'POST', body: JSON.stringify({ password: 'hunter2' }) }), params(conn.id)),
    ]
    expect(forbidden.map(r => r.status)).toEqual([403, 403, 403, 403, 403])
    for (const r of forbidden) expect(await r.json()).toEqual({ error: 'cookie_session_required' })
    // Nothing was created, revoked, deleted, or stored.
    const [row] = await db.select().from(connections).where(eq(connections.id, conn.id))
    expect(row.status).toBe('active')
    expect(row.loginSecretCiphertext).toBeNull()
    expect(await db.select().from(connections)).toHaveLength(1)
  })

  it('creates a connection, then reports 409 while one is active', async () => {
    await signedIn()
    const res = await createRoute.POST(cookie({ method: 'POST', body: JSON.stringify({ channel: 'telegram' }) }))
    expect(res.status).toBe(201)
    const { id } = await res.json()
    await db.update(connections).set({ status: 'active' }).where(eq(connections.id, id))
    const again = await createRoute.POST(cookie({ method: 'POST', body: JSON.stringify({ channel: 'telegram' }) }))
    expect(again.status).toBe(409)
  })

  it('rejects a body that is not a known channel', async () => {
    await signedIn()
    const res = await createRoute.POST(cookie({ method: 'POST', body: JSON.stringify({ channel: 'signal' }) }))
    expect(res.status).toBe(400)
    const noBody = await createRoute.POST(cookie({ method: 'POST' }))
    expect(noBody.status).toBe(400)
  })

  it('serves a status payload with the QR but no ciphertext, and 404s an unknown id', async () => {
    await signedIn()
    const conn = await makeConnection({ status: 'pending' })
    await db.update(connections).set({
      loginQrToken: 'tg://login?token=abc', sessionCiphertext: 'SESSION_SECRET', loginSecretCiphertext: 'PW_SECRET',
    }).where(eq(connections.id, conn.id))
    const res = await idRoute.GET(cookie(), params(conn.id))
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('tg://login?token=abc')
    expect(body).not.toContain('SESSION_SECRET')
    expect(body).not.toContain('PW_SECRET')
    expect((await idRoute.GET(cookie(), params('nope'))).status).toBe(404)
  })

  it('revokes, and refuses to revoke twice', async () => {
    await signedIn()
    const conn = await makeConnection({ status: 'active' })
    expect((await revokeRoute.POST(cookie({ method: 'POST' }), params(conn.id))).status).toBe(200)
    const [row] = await db.select().from(connections).where(eq(connections.id, conn.id))
    expect(row.status).toBe('revoked')
    expect((await revokeRoute.POST(cookie({ method: 'POST' }), params(conn.id))).status).toBe(404)
  })

  it('deletes a connection and everything it archived', async () => {
    await signedIn()
    const conn = await makeConnection({ status: 'active' })
    expect((await idRoute.DELETE(cookie({ method: 'DELETE' }), params(conn.id))).status).toBe(200)
    expect(await db.select().from(connections)).toEqual([])
  })

  it('stores a 2FA password, and 409s once the row is no longer pending', async () => {
    await signedIn()
    const conn = await makeConnection({ status: 'pending' })
    await db.update(connections).set({ lastError: PASSWORD_REJECTED, loginNeedsPassword: true }).where(eq(connections.id, conn.id))
    const body = JSON.stringify({ password: 'hunter2' })
    expect((await passwordRoute.POST(cookie({ method: 'POST', body }), params(conn.id))).status).toBe(200)
    const [row] = await db.select().from(connections).where(eq(connections.id, conn.id))
    expect(decryptSecret(row.loginSecretCiphertext!)).toBe('hunter2')

    await db.update(connections).set({ status: 'active' }).where(eq(connections.id, conn.id))
    expect((await passwordRoute.POST(cookie({ method: 'POST', body }), params(conn.id))).status).toBe(409)
    expect((await passwordRoute.POST(cookie({ method: 'POST', body: '{}' }), params(conn.id))).status).toBe(400)
  })
})
