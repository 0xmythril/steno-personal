import { describe, it, expect, beforeEach, vi } from 'vitest'

// next/headers only exists inside a request scope; one in-memory jar stands
// in for it so lib/auth's real cookie path runs (see api-connections.test.ts).
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
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))

const { db } = await import('@/lib/db/client')
const { connections } = await import('@/lib/db/schema')
const { eq } = await import('drizzle-orm')
const { resetDb } = await import('./helpers/db')
const { makeConnection } = await import('./helpers/fixtures')
const { mintAccessKey, listActiveAccessKeys, revokeAllAccessKeys } = await import('@/lib/services/access-keys')
const { SESSION_COOKIE, SETUP_COOKIE, isFreshInstance, requireSession, requireFreshInstance } = await import('@/lib/auth')
const { FIRST_KEY_COOKIE } = await import('@/lib/services/keys-flash')
const setupRoute = await import('@/app/api/setup/connections/[id]/route')
const { finishSetupAction, setupConnectAction, setupCancelAction, setupPasswordAction } = await import('@/app/setup/actions')

const params = (id: string) => ({ params: Promise.resolve({ id }) })
const req = () => new Request('http://local/api/setup/connections/x')

describe('fresh instance', () => {
  beforeEach(async () => { jar.clear(); await resetDb() })

  it('is fresh until any key exists, revoked keys included', async () => {
    expect(await isFreshInstance()).toBe(true)
    await mintAccessKey('a')
    expect(await isFreshInstance()).toBe(false)
    await revokeAllAccessKeys()
    expect(await isFreshInstance()).toBe(false)
  })

  it('sends a session-less visitor to /setup while fresh and to /login afterwards', async () => {
    await expect(requireSession()).rejects.toThrow('redirect:/setup')
    await mintAccessKey('a')
    await expect(requireSession()).rejects.toThrow('redirect:/login')
    await expect(requireFreshInstance()).rejects.toThrow('redirect:/login')
  })
})

describe('GET /api/setup/connections/[id]', () => {
  beforeEach(async () => { jar.clear(); await resetDb() })

  it('serves the pairing status, QR included, only while the instance is fresh', async () => {
    const conn = await makeConnection({ status: 'pending' })
    await db.update(connections).set({ loginQrToken: 'tg://login?token=abc', sessionCiphertext: 'SESSION_SECRET' })
      .where(eq(connections.id, conn.id))
    jar.set(SETUP_COOKIE, conn.id)
    const res = await setupRoute.GET(req(), params(conn.id))
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('tg://login?token=abc')
    expect(body).not.toContain('SESSION_SECRET')

    await mintAccessKey('first')
    expect((await setupRoute.GET(req(), params(conn.id))).status).toBe(404)
  })

  it('404s an unknown id and a recovery row', async () => {
    expect((await setupRoute.GET(req(), params('nope'))).status).toBe(404)
    const rec = await makeConnection({ channel: 'whatsapp', purpose: 'recovery', status: 'pending' })
    jar.set(SETUP_COOKIE, rec.id)
    expect((await setupRoute.GET(req(), params(rec.id))).status).toBe(404)
  })

  // The pairing belongs to the browser that started it. Another visitor to a
  // fresh instance gets the same 404 an unknown id gets, cookie or no cookie.
  it('404s a browser that did not start the pairing', async () => {
    const conn = await makeConnection({ status: 'pending' })
    expect((await setupRoute.GET(req(), params(conn.id))).status).toBe(404)
    const other = await makeConnection({ channel: 'whatsapp', status: 'pending' })
    jar.set(SETUP_COOKIE, other.id)
    expect((await setupRoute.GET(req(), params(conn.id))).status).toBe(404)
  })
})

describe('setup actions', () => {
  beforeEach(async () => { jar.clear(); await resetDb() })

  it('connect binds the pairing to this browser with an httpOnly cookie', async () => {
    const fd = new FormData(); fd.set('channel', 'telegram')
    const res = await setupConnectAction(null, fd)
    if (!res.ok) throw new Error(res.message)
    expect(jar.get(SETUP_COOKIE)).toBe(res.id)
  })

  it('finishSetup mints the first key, flashes it to /welcome, and logs the browser in', async () => {
    const conn = await makeConnection({ status: 'active' })
    jar.set(SETUP_COOKIE, conn.id)
    await expect(finishSetupAction()).rejects.toThrow('redirect:/welcome')
    const keys = await listActiveAccessKeys()
    expect(keys).toHaveLength(1)
    expect(keys[0].label).toBe('First key')
    const flash = JSON.parse(jar.get(FIRST_KEY_COOKIE)!)
    expect(flash.id).toBe(keys[0].id)
    expect(flash.rawKey).toMatch(/^sp_/)
    expect(jar.get(SESSION_COOKIE)).toBeTruthy()
    // no longer fresh: setup is closed
    await expect(finishSetupAction()).rejects.toThrow('redirect:/login')
    expect(await listActiveAccessKeys()).toHaveLength(1)
  })

  it('finishSetup refuses without an active connection', async () => {
    const conn = await makeConnection({ status: 'pending' })
    jar.set(SETUP_COOKIE, conn.id)
    await expect(finishSetupAction()).rejects.toThrow('redirect:/setup')
    expect(await listActiveAccessKeys()).toEqual([])
    expect(jar.get(SESSION_COOKIE)).toBeUndefined()
  })

  // The window between "paired" and "first key minted" is the dangerous one:
  // the owner's real account is already syncing, and the instance is still
  // fresh. Only the browser that started that pairing may close it.
  it('finishSetup refuses a browser that did not start the pairing', async () => {
    await makeConnection({ status: 'active' })
    await expect(finishSetupAction()).rejects.toThrow('redirect:/setup')
    const other = await makeConnection({ channel: 'whatsapp', status: 'pending' })
    jar.set(SETUP_COOKIE, other.id)
    await expect(finishSetupAction()).rejects.toThrow('redirect:/setup')
    jar.set(SETUP_COOKIE, 'not-a-connection')
    await expect(finishSetupAction()).rejects.toThrow('redirect:/setup')
    expect(await listActiveAccessKeys()).toEqual([])
    expect(jar.get(SESSION_COOKIE)).toBeUndefined()
    expect(jar.get(FIRST_KEY_COOKIE)).toBeUndefined()
  })

  it('finishSetup mints exactly one first key when two requests race', async () => {
    const conn = await makeConnection({ status: 'active' })
    jar.set(SETUP_COOKIE, conn.id)
    const outcomes = await Promise.allSettled([finishSetupAction(), finishSetupAction()])
    const reasons = outcomes.map(o => (o.status === 'rejected' ? String(o.reason.message) : 'resolved')).sort()
    expect(reasons).toEqual(['redirect:/login', 'redirect:/welcome'])
    expect(await listActiveAccessKeys()).toHaveLength(1)
  })

  it('password and cancel act only on the pairing this browser started', async () => {
    const conn = await makeConnection({ status: 'pending' })
    await db.update(connections).set({ loginNeedsPassword: true }).where(eq(connections.id, conn.id))
    const pw = new FormData(); pw.set('connectionId', conn.id); pw.set('password', 'hunter2')
    await expect(setupPasswordAction(null, pw)).rejects.toThrow('redirect:/setup')
    const cancel = new FormData(); cancel.set('connectionId', conn.id)
    await expect(setupCancelAction(cancel)).rejects.toThrow('redirect:/setup')
    let [row] = await db.select().from(connections).where(eq(connections.id, conn.id))
    expect(row.status).toBe('pending')
    expect(row.loginSecretCiphertext).toBeNull()

    jar.set(SETUP_COOKIE, conn.id)
    expect((await setupPasswordAction(null, pw)).ok).toBe(true)
    await setupCancelAction(cancel)
    ;[row] = await db.select().from(connections).where(eq(connections.id, conn.id))
    expect(row.status).toBe('revoked')
  })

  // The claim is instance-wide, not per channel. While one browser's pairing
  // is live (pending or active), no other browser may start its own on ANY
  // channel — otherwise the second visitor pairs a throwaway account and
  // mints the instance's first key against the owner's already-archiving one.
  it('connect refuses a second browser while another pairing is live, on any channel', async () => {
    const tg = new FormData(); tg.set('channel', 'telegram')
    const wa = new FormData(); wa.set('channel', 'whatsapp')
    const first = await setupConnectAction(null, tg)
    if (!first.ok) throw new Error(first.message)

    jar.clear() // a second browser
    expect((await setupConnectAction(null, wa)).ok).toBe(false)
    expect((await setupConnectAction(null, tg)).ok).toBe(false)
    expect(jar.get(SETUP_COOKIE)).toBeUndefined()

    await db.update(connections).set({ status: 'active' }).where(eq(connections.id, first.id))
    expect((await setupConnectAction(null, wa)).ok).toBe(false)
    expect(jar.get(SETUP_COOKIE)).toBeUndefined()

    // the owner's row is untouched: neither replaced nor deleted
    const live = await db.select({ id: connections.id, status: connections.status }).from(connections)
    expect(live).toEqual([{ id: first.id, status: 'active' }])
  })

  it('connect lets the browser that started a pending pairing switch channel', async () => {
    const tg = new FormData(); tg.set('channel', 'telegram')
    const wa = new FormData(); wa.set('channel', 'whatsapp')
    const first = await setupConnectAction(null, tg)
    if (!first.ok) throw new Error(first.message)
    const second = await setupConnectAction(null, wa)
    if (!second.ok) throw new Error(second.message)
    expect(jar.get(SETUP_COOKIE)).toBe(second.id)
    // the abandoned attempt held nothing, so it is gone rather than left
    // pending — a pending row the cookie no longer names would read as
    // "someone else is claiming" to its own owner.
    const live = await db.select({ id: connections.id }).from(connections)
    expect(live).toEqual([{ id: second.id }])
  })

  // Defence in depth for the same hole: even with a row of its own, a browser
  // may not mint the first key while another live pairing exists.
  it('finishSetup refuses while another live pairing exists', async () => {
    await makeConnection({ channel: 'telegram', status: 'active' })
    const other = await makeConnection({ channel: 'whatsapp', status: 'active' })
    jar.set(SETUP_COOKIE, other.id)
    await expect(finishSetupAction()).rejects.toThrow('redirect:/setup')
    expect(await listActiveAccessKeys()).toEqual([])
    expect(jar.get(SESSION_COOKIE)).toBeUndefined()
    expect(jar.get(FIRST_KEY_COOKIE)).toBeUndefined()
  })

  it('connect is closed once a key exists', async () => {
    const fd = new FormData(); fd.set('channel', 'telegram')
    expect((await setupConnectAction(null, fd)).ok).toBe(true)
    await mintAccessKey('a')
    await expect(setupConnectAction(null, fd)).rejects.toThrow('redirect:/login')
  })
})
