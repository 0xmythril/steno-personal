import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from './helpers/db'
import {
  savePasskey, findActivePasskeyByCredentialId, recordPasskeyUse, listActivePasskeys,
  listActiveCredentials, countActivePasskeys, revokePasskey, revokeAllPasskeys,
} from '@/lib/services/passkeys'

const fresh = (n: string) => ({ label: `laptop ${n}`, credentialId: `cred-${n}`, publicKey: 'pk', counter: 0, transports: ['internal'], backedUp: false })

describe('passkey rows', () => {
  beforeEach(resetDb)

  it('saves, lists without the public key, and counts', async () => {
    const r = await savePasskey(fresh('a'))
    expect(r.ok).toBe(true)
    const list = await listActivePasskeys()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ label: 'laptop a', backedUp: false, lastUsedAt: null })
    expect(list[0]).not.toHaveProperty('publicKey')
    expect(await countActivePasskeys()).toBe(1)
    expect(await listActiveCredentials()).toEqual([{ id: 'cred-a', transports: ['internal'] }])
  })

  it('refuses an empty, an over-long, and a duplicate credential', async () => {
    expect(await savePasskey({ ...fresh('a'), label: '  ' })).toEqual({ ok: false, reason: 'label_empty' })
    expect(await savePasskey({ ...fresh('a'), label: 'x'.repeat(101) })).toEqual({ ok: false, reason: 'label_too_long' })
    expect((await savePasskey(fresh('a'))).ok).toBe(true)
    expect(await savePasskey({ ...fresh('a'), label: 'again' })).toEqual({ ok: false, reason: 'duplicate' })
  })

  it('finds an active credential, records use, and stops finding it once revoked', async () => {
    const r = await savePasskey(fresh('a'))
    if (!r.ok) throw new Error(r.reason)
    const found = await findActivePasskeyByCredentialId('cred-a')
    expect(found).toMatchObject({ id: r.id, credentialId: 'cred-a', publicKey: 'pk', counter: 0 })
    await recordPasskeyUse(r.id, 7)
    expect((await findActivePasskeyByCredentialId('cred-a'))?.counter).toBe(7)
    expect((await listActivePasskeys())[0].lastUsedAt).toBeInstanceOf(Date)
    expect(await revokePasskey(r.id)).toBe(true)
    expect(await revokePasskey(r.id)).toBe(false)
    expect(await findActivePasskeyByCredentialId('cred-a')).toBeNull()
    expect(await countActivePasskeys()).toBe(0)
  })

  it('revokes all', async () => {
    await savePasskey(fresh('a')); await savePasskey(fresh('b'))
    expect(await revokeAllPasskeys()).toBe(2)
    expect(await listActivePasskeys()).toEqual([])
  })
})
