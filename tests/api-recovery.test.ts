import { describe, it, expect, beforeEach, vi } from 'vitest'

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
const { mintAccessKey, listActiveAccessKeys, revokeAllAccessKeys, verifyAccessKey } = await import('@/lib/services/access-keys')
const { SESSION_COOKIE, RECOVERY_COOKIE, startSession } = await import('@/lib/auth')
const { FIRST_KEY_COOKIE } = await import('@/lib/services/keys-flash')
const { completeRecovery, getRecoveryAttempt } = await import('@/lib/services/recovery')
const statusRoute = await import('@/app/api/recovery/status/route')
const { recoverStartAction, recoverClaimAction, recoverCancelAction, recoverPasswordAction } = await import('@/app/login/recover/actions')

// A locked-out owner: a key once existed (so the instance is not fresh), and
// an archive connection knows the account.
async function lockedOut(externalAccountId = 'tg-1') {
  await mintAccessKey('lost')
  await revokeAllAccessKeys()
  await makeConnection({ channel: 'telegram', status: 'active', externalAccountId })
}

const start = async () => {
  const fd = new FormData(); fd.set('channel', 'telegram')
  const res = await recoverStartAction(null, fd)
  if (!res.ok) throw new Error(res.message)
  return res.id
}

describe('GET /api/recovery/status', () => {
  beforeEach(async () => { jar.clear(); await resetDb() })

  it('answers only for the attempt named by the recovery cookie', async () => {
    await lockedOut()
    expect((await statusRoute.GET()).status).toBe(404)
    const id = await start()
    expect(jar.get(RECOVERY_COOKIE)).toBe(id)
    await db.update(connections).set({ loginQrToken: 'tg://login?token=abc', loginSecretCiphertext: 'PW_SECRET' })
      .where(eq(connections.id, id))
    const res = await statusRoute.GET()
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('tg://login?token=abc')
    expect(body).not.toContain('PW_SECRET')
    expect(JSON.parse(body)).toMatchObject({ id, channel: 'telegram', status: 'pending', outcome: null, hasKey: false })
  })

  it('never answers for an archive row, even with its id in the cookie', async () => {
    await lockedOut()
    const conn = await makeConnection({ channel: 'whatsapp', status: 'pending' })
    jar.set(RECOVERY_COOKIE, conn.id)
    expect((await statusRoute.GET()).status).toBe(404)
  })
})

describe('recovery actions', () => {
  beforeEach(async () => { jar.clear(); await resetDb() })

  it('start is closed on a fresh instance and to a logged-in browser', async () => {
    const fd = new FormData(); fd.set('channel', 'telegram')
    await expect(recoverStartAction(null, fd)).rejects.toThrow('redirect:/setup')
    const k = await mintAccessKey('a'); if (!k.ok) throw new Error(k.reason)
    await startSession({ keyId: k.id })
    await expect(recoverStartAction(null, fd)).rejects.toThrow('redirect:/')
  })

  it('start refuses a channel nothing has ever been connected on', async () => {
    await lockedOut()
    const fd = new FormData(); fd.set('channel', 'whatsapp')
    const res = await recoverStartAction(null, fd)
    expect(res.ok).toBe(false)
    expect(jar.get(RECOVERY_COOKIE)).toBeUndefined()
  })

  it('a matched attempt is claimed once: key flashed, session started, cookie gone', async () => {
    await lockedOut('tg-1')
    const id = await start()
    expect(await completeRecovery(id, { channel: 'telegram', externalAccountId: 'tg-1', displayName: null })).toBe('matched')

    await expect(recoverClaimAction()).rejects.toThrow('redirect:/welcome')
    const keys = await listActiveAccessKeys()
    expect(keys).toHaveLength(1)
    const flash = JSON.parse(jar.get(FIRST_KEY_COOKIE)!)
    expect(flash.id).toBe(keys[0].id)
    expect(await verifyAccessKey(flash.rawKey)).toMatchObject({ id: keys[0].id })
    expect(jar.get(SESSION_COOKIE)).toBeTruthy()
    expect(jar.get(RECOVERY_COOKIE)).toBeUndefined()
    expect((await getRecoveryAttempt(id))!.hasKey).toBe(false)

    // A second claim with the same cookie replayed: nothing left to hand out,
    // and the (now logged-in) browser is sent home by the open-check.
    jar.delete(SESSION_COOKIE)
    jar.set(RECOVERY_COOKIE, id)
    await expect(recoverClaimAction()).rejects.toThrow('redirect:/login/recover')
    expect(await listActiveAccessKeys()).toHaveLength(1)
  })

  it('a mismatched attempt has nothing to claim', async () => {
    await lockedOut('tg-1')
    const id = await start()
    expect(await completeRecovery(id, { channel: 'telegram', externalAccountId: 'tg-2', displayName: null })).toBe('mismatched')
    await expect(recoverClaimAction()).rejects.toThrow('redirect:/login/recover')
    expect(await listActiveAccessKeys()).toEqual([])
    expect(jar.get(SESSION_COOKIE)).toBeUndefined()
    // and the mismatch is dismissible
    await recoverCancelAction()
    expect(jar.get(RECOVERY_COOKIE)).toBeUndefined()
  })

  it('password and cancel act on the cookie\'s attempt, not a form field', async () => {
    await lockedOut()
    const id = await start()
    await db.update(connections).set({ loginNeedsPassword: true }).where(eq(connections.id, id))
    const other = await makeConnection({ channel: 'whatsapp', status: 'pending' })
    await db.update(connections).set({ loginNeedsPassword: true }).where(eq(connections.id, other.id))
    const fd = new FormData(); fd.set('connectionId', other.id); fd.set('password', 'hunter2')
    expect(await recoverPasswordAction(null, fd)).toEqual({ ok: true })
    const [mine] = await db.select().from(connections).where(eq(connections.id, id))
    const [theirs] = await db.select().from(connections).where(eq(connections.id, other.id))
    expect(mine.loginSecretCiphertext).not.toBeNull()
    expect(theirs.loginSecretCiphertext).toBeNull()

    await recoverCancelAction()
    expect((await getRecoveryAttempt(id))!.status).toBe('revoked')
    expect(theirs.status).toBe('pending')
    await expect(recoverCancelAction()).rejects.toThrow('redirect:/login/recover') // no attempt any more
  })
})
