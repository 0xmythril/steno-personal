import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from './helpers/db'
import { mintAccessKey, revokeAccessKey } from '@/lib/services/access-keys'
import { createSession, resolveSession, deleteSession, purgeExpiredSessions, SESSION_TTL_MS } from '@/lib/services/sessions'
import { COOKIE_MAX_AGE_S } from '@/lib/auth'
import { savePasskey, revokePasskey } from '@/lib/services/passkeys'

async function key() {
  const r = await mintAccessKey('k')
  if (!r.ok) throw new Error(r.reason)
  return r
}

describe('sessions', () => {
  beforeEach(resetDb)

  it('creates and resolves', async () => {
    const k = await key()
    const id = await createSession({ keyId: k.id })
    expect(id.length).toBeGreaterThan(30)
    expect(await resolveSession(id)).toEqual({ sessionId: id, via: 'key', keyId: k.id, passkeyId: null, label: 'k' })
    expect(await resolveSession('missing')).toBeNull()
  })

  it('dies with its key', async () => {
    const k = await key()
    const id = await createSession({ keyId: k.id })
    await revokeAccessKey(k.id)
    expect(await resolveSession(id)).toBeNull()
  })

  it('binds to a passkey and dies with it', async () => {
    const p = await savePasskey({ label: 'phone', credentialId: 'c1', publicKey: 'pk', counter: 0, backedUp: true })
    if (!p.ok) throw new Error(p.reason)
    const id = await createSession({ passkeyId: p.id })
    expect(await resolveSession(id)).toEqual({ sessionId: id, via: 'passkey', keyId: null, passkeyId: p.id, label: 'phone' })
    await revokePasskey(p.id)
    expect(await resolveSession(id)).toBeNull()
  })

  it('refuses a row bound to both credentials or neither', async () => {
    const { db } = await import('@/lib/db/client')
    const { sessions } = await import('@/lib/db/schema')
    const k = await key()
    const p = await savePasskey({ label: 'phone', credentialId: 'c2', publicKey: 'pk', counter: 0, backedUp: false })
    if (!p.ok) throw new Error(p.reason)
    const expiresAt = new Date(Date.now() + 1000)
    await expect(db.insert(sessions).values({ id: 'both', keyId: k.id, passkeyId: p.id, expiresAt })).rejects.toThrow()
    await expect(db.insert(sessions).values({ id: 'none', expiresAt })).rejects.toThrow()
  })

  it('expires after 30 idle days and slides while used', async () => {
    const k = await key()
    const t0 = new Date('2026-01-01T00:00:00Z')
    const id = await createSession({ keyId: k.id }, t0)
    const day = 86_400_000
    // used on day 20: still valid, and extended to day 50
    expect(await resolveSession(id, new Date(t0.getTime() + 20 * day))).not.toBeNull()
    expect(await resolveSession(id, new Date(t0.getTime() + 45 * day))).not.toBeNull()
    // then idle for 31 days: gone
    expect(await resolveSession(id, new Date(t0.getTime() + 45 * day + SESSION_TTL_MS + day))).toBeNull()
  })

  it('gives the cookie a longer life than the server-side idle window', () => {
    // The server row is authoritative; a cookie that died first would log an
    // active user out on day 30 no matter how often they used the portal.
    expect(COOKIE_MAX_AGE_S * 1000).toBeGreaterThan(SESSION_TTL_MS)
  })

  it('deletes and purges', async () => {
    const k = await key()
    const live = await createSession({ keyId: k.id })
    const old = await createSession({ keyId: k.id }, new Date(Date.now() - SESSION_TTL_MS - 1000))
    expect(await purgeExpiredSessions()).toBe(1)
    expect(await resolveSession(old)).toBeNull()
    await deleteSession(live)
    expect(await resolveSession(live)).toBeNull()
  })
})
