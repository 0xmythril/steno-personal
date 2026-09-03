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
const { SESSION_COOKIE, isFreshInstance, requireSession, requireFreshInstance } = await import('@/lib/auth')
const { FIRST_KEY_COOKIE } = await import('@/lib/services/keys-flash')
const setupRoute = await import('@/app/api/setup/connections/[id]/route')
const { finishSetupAction, setupConnectAction } = await import('@/app/setup/actions')

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
    expect((await setupRoute.GET(req(), params(rec.id))).status).toBe(404)
  })
})

describe('setup actions', () => {
  beforeEach(async () => { jar.clear(); await resetDb() })

  it('finishSetup mints the first key, flashes it to /welcome, and logs the browser in', async () => {
    await makeConnection({ status: 'active' })
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
    await makeConnection({ status: 'pending' })
    await expect(finishSetupAction()).rejects.toThrow('redirect:/setup')
    expect(await listActiveAccessKeys()).toEqual([])
    expect(jar.get(SESSION_COOKIE)).toBeUndefined()
  })

  it('connect is closed once a key exists', async () => {
    const fd = new FormData(); fd.set('channel', 'telegram')
    expect((await setupConnectAction(null, fd)).ok).toBe(true)
    await mintAccessKey('a')
    await expect(setupConnectAction(null, fd)).rejects.toThrow('redirect:/login')
  })
})
