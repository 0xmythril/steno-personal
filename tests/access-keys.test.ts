import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from './helpers/db'
import {
  mintAccessKey, verifyAccessKey, listActiveAccessKeys, revealAccessKey,
  revokeAccessKey, revokeAllAccessKeys, countActiveAccessKeys, hasAnyAccessKey, mintFirstAccessKey, KEY_PREFIX,
} from '@/lib/services/access-keys'

describe('access keys', () => {
  beforeEach(resetDb)

  it('mints a prefixed key that verifies and bumps last_used_at', async () => {
    const r = await mintAccessKey('laptop')
    if (!r.ok) throw new Error(r.reason)
    expect(r.rawKey.startsWith(KEY_PREFIX)).toBe(true)
    expect(r.rawKey.length).toBeGreaterThan(40)
    const before = (await listActiveAccessKeys())[0]
    expect(before.lastUsedAt).toBeNull()
    expect(await verifyAccessKey(r.rawKey, 'read')).toEqual({ id: r.id, label: 'laptop', scope: 'read' })
    const after = (await listActiveAccessKeys())[0]
    expect(after.lastUsedAt).toBeInstanceOf(Date)
    expect(after.prefix).toBe(r.rawKey.slice(KEY_PREFIX.length, KEY_PREFIX.length + 8))
  })

  it('rejects unknown, revoked, and empty keys', async () => {
    const r = await mintAccessKey('a')
    if (!r.ok) throw new Error(r.reason)
    expect(await verifyAccessKey('sp_nope', 'read')).toBeNull()
    expect(await verifyAccessKey('', 'read')).toBeNull()
    expect(await revokeAccessKey(r.id)).toBe(true)
    expect(await revokeAccessKey(r.id)).toBe(false) // already revoked
    expect(await verifyAccessKey(r.rawKey, 'read')).toBeNull()
    expect(await listActiveAccessKeys()).toEqual([])
  })

  it('a push key verifies only as a push key, and a read key only as a read key', async () => {
    const push = await mintAccessKey('cron', 'push')
    const read = await mintAccessKey('agent')
    if (!push.ok || !read.ok) throw new Error('mint failed')
    expect(await verifyAccessKey(push.rawKey, 'push')).toEqual({ id: push.id, label: 'cron', scope: 'push' })
    expect(await verifyAccessKey(push.rawKey, 'read')).toBeNull()
    expect(await verifyAccessKey(read.rawKey, 'push')).toBeNull()
    // A refused verification is not a use.
    const rows = await listActiveAccessKeys()
    expect(rows.find(k => k.id === read.id)?.lastUsedAt).toBeNull()
    expect(rows.map(k => [k.label, k.scope])).toEqual([['agent', 'read'], ['cron', 'push']])
  })

  it('reveals only active keys', async () => {
    const r = await mintAccessKey('a')
    if (!r.ok) throw new Error(r.reason)
    expect(await revealAccessKey(r.id)).toBe(r.rawKey)
    await revokeAccessKey(r.id)
    expect(await revealAccessKey(r.id)).toBeNull()
    expect(await revealAccessKey('not-a-real-id')).toBeNull()
  })

  it('validates labels', async () => {
    expect(await mintAccessKey('   ')).toEqual({ ok: false, reason: 'label_empty' })
    expect(await mintAccessKey('x'.repeat(101))).toEqual({ ok: false, reason: 'label_too_long' })
  })

  it('revokes everything at once and lists newest first', async () => {
    await mintAccessKey('first')
    await new Promise(r => setTimeout(r, 5))
    await mintAccessKey('second')
    expect((await listActiveAccessKeys()).map(k => k.label)).toEqual(['second', 'first'])
    expect(await countActiveAccessKeys()).toBe(2)
    expect(await revokeAllAccessKeys()).toBe(2)
    expect(await countActiveAccessKeys()).toBe(0)
  })

  it('hasAnyAccessKey counts revoked keys too: a revoked instance is not a fresh one', async () => {
    expect(await hasAnyAccessKey()).toBe(false)
    const r = await mintAccessKey('a')
    if (!r.ok) throw new Error(r.reason)
    expect(await hasAnyAccessKey()).toBe(true)
    await revokeAllAccessKeys()
    expect(await countActiveAccessKeys()).toBe(0)
    expect(await hasAnyAccessKey()).toBe(true)
  })

  it('never returns a hash or ciphertext from list', async () => {
    await mintAccessKey('a')
    const blob = JSON.stringify(await listActiveAccessKeys())
    expect(blob).not.toMatch(/keyHash|keyCiphertext|key_hash|key_ciphertext/)
  })
})

// The first key is what closes /setup. Two finish requests racing through
// the fresh-instance check must not both mint: the check and the insert
// happen inside one transaction, so the second finds a key and stops.
describe('mintFirstAccessKey', () => {
  beforeEach(resetDb)

  it('mints only while no key row exists, revoked ones included', async () => {
    const first = await mintFirstAccessKey('First key')
    expect(first.ok).toBe(true)
    expect(await mintFirstAccessKey('Second')).toEqual({ ok: false, reason: 'not_first' })
    await revokeAllAccessKeys()
    expect(await mintFirstAccessKey('Third')).toEqual({ ok: false, reason: 'not_first' })
    expect(await countActiveAccessKeys()).toBe(0)
    expect(await hasAnyAccessKey()).toBe(true)
  })

  it('lets exactly one of two concurrent callers win', async () => {
    const results = await Promise.all([mintFirstAccessKey('a'), mintFirstAccessKey('b')])
    expect(results.filter(r => r.ok)).toHaveLength(1)
    expect(await listActiveAccessKeys()).toHaveLength(1)
  })
})
