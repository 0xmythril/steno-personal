import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from './helpers/db'
import { mintAccessKey, revokeAccessKey } from '@/lib/services/access-keys'
import { createSession, resolveSession, deleteSession, purgeExpiredSessions, SESSION_TTL_MS } from '@/lib/services/sessions'

async function key() {
  const r = await mintAccessKey('k')
  if (!r.ok) throw new Error(r.reason)
  return r
}

describe('sessions', () => {
  beforeEach(resetDb)

  it('creates and resolves', async () => {
    const k = await key()
    const id = await createSession(k.id)
    expect(id.length).toBeGreaterThan(30)
    expect(await resolveSession(id)).toEqual({ sessionId: id, keyId: k.id, label: 'k' })
    expect(await resolveSession('missing')).toBeNull()
  })

  it('dies with its key', async () => {
    const k = await key()
    const id = await createSession(k.id)
    await revokeAccessKey(k.id)
    expect(await resolveSession(id)).toBeNull()
  })

  it('expires after 30 idle days and slides while used', async () => {
    const k = await key()
    const t0 = new Date('2026-01-01T00:00:00Z')
    const id = await createSession(k.id, t0)
    const day = 86_400_000
    // used on day 20: still valid, and extended to day 50
    expect(await resolveSession(id, new Date(t0.getTime() + 20 * day))).not.toBeNull()
    expect(await resolveSession(id, new Date(t0.getTime() + 45 * day))).not.toBeNull()
    // then idle for 31 days: gone
    expect(await resolveSession(id, new Date(t0.getTime() + 45 * day + SESSION_TTL_MS + day))).toBeNull()
  })

  it('deletes and purges', async () => {
    const k = await key()
    const live = await createSession(k.id)
    const old = await createSession(k.id, new Date(Date.now() - SESSION_TTL_MS - 1000))
    expect(await purgeExpiredSessions()).toBe(1)
    expect(await resolveSession(old)).toBeNull()
    await deleteSession(live)
    expect(await resolveSession(live)).toBeNull()
  })
})
