import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { connections } from '@/lib/db/schema'
import { resetDb } from './helpers/db'
import { makeConnection, makeChat } from './helpers/fixtures'
import { createConnection, revokeConnection, deleteConnection, getConnection, hasActiveConnection } from '@/lib/services/connections'
import { countActiveAccessKeys, listActiveAccessKeys, revealAccessKey } from '@/lib/services/access-keys'
import { publishQr } from '@/lib/services/login'
import {
  knownAccountChannels, startRecovery, getRecoveryAttempt, completeRecovery, claimRecoveryKey,
  cancelRecovery, recoveryKeyLabel,
} from '@/lib/services/recovery'

const rowOf = async (id: string) => (await db.select().from(connections).where(eq(connections.id, id)))[0]
const account = (externalAccountId: string, channel: 'telegram' | 'whatsapp' = 'telegram') =>
  ({ channel, externalAccountId, displayName: 'Someone' })

describe('recovery service', () => {
  beforeEach(resetDb)

  it('knows a channel only from archive rows that reported an account, live or past', async () => {
    expect(await knownAccountChannels()).toEqual([])
    const tg = await makeConnection({ channel: 'telegram', status: 'active', externalAccountId: 'tg-1' })
    expect(await knownAccountChannels()).toEqual(['telegram'])
    await revokeConnection(tg.id, 'disconnected')
    expect(await knownAccountChannels()).toEqual(['telegram']) // a past connection still vouches
    // a pending row has no account yet, and a recovery row never counts
    await db.insert(connections).values({ channel: 'whatsapp', status: 'pending' })
    await makeConnection({ channel: 'whatsapp', purpose: 'recovery', status: 'pending', externalAccountId: 'wa-9' })
    expect(await knownAccountChannels()).toEqual(['telegram'])
    await deleteConnection(tg.id)
    expect(await knownAccountChannels()).toEqual([]) // Delete everything takes the proof with it
  })

  it('starts only on a known channel, replacing a dead or abandoned attempt', async () => {
    expect(await startRecovery('telegram')).toEqual({ ok: false, reason: 'no_known_account' })
    await makeConnection({ channel: 'telegram', status: 'active', externalAccountId: 'tg-1' })
    const first = await startRecovery('telegram')
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const status = await getRecoveryAttempt(first.id)
    expect(status).toMatchObject({ channel: 'telegram', status: 'pending', outcome: null, hasKey: false })
    expect(status!.login).toEqual({ qr: null, qrAt: null, needsPassword: false, passwordRejected: false })

    const second = await startRecovery('telegram')
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(await rowOf(first.id)).toBeUndefined()
    expect((await rowOf(second.id)).purpose).toBe('recovery')
    // the archive connection was never touched
    expect(await hasActiveConnection()).toBe(true)
  })

  it('does not answer for an archive row', async () => {
    const conn = await makeConnection({ status: 'pending' })
    expect(await getRecoveryAttempt(conn.id)).toBeNull()
    expect(await getRecoveryAttempt('nope')).toBeNull()
  })

  it('a live recovery attempt leaves the archive slot free', async () => {
    await makeConnection({ channel: 'telegram', status: 'revoked', externalAccountId: 'tg-1' })
    const rec = await startRecovery('telegram')
    expect(rec.ok).toBe(true)
    expect((await createConnection('telegram')).ok).toBe(true)
    if (rec.ok) expect((await rowOf(rec.id)).status).toBe('pending')
  })

  it('a matching account mints a claimable key and ends the attempt revoked with no session stored', async () => {
    await makeConnection({ channel: 'whatsapp', status: 'active', externalAccountId: '15550001' })
    const rec = await startRecovery('whatsapp')
    if (!rec.ok) throw new Error('start failed')
    await publishQr(rec.id, 'wa-qr')

    expect(await completeRecovery(rec.id, account('15550001', 'whatsapp'))).toBe('matched')
    const row = await rowOf(rec.id)
    expect(row.status).toBe('revoked')
    expect(row.revokedAt).toBeInstanceOf(Date)
    expect(row.recoveryOutcome).toBe('matched')
    expect(row.recoveryKeyId).not.toBeNull()
    expect(row.sessionCiphertext).toBeNull()
    expect(row.loginQrToken).toBeNull()
    expect(row.externalAccountId).toBeNull() // nothing about the paired device is kept

    const keys = await listActiveAccessKeys()
    expect(keys).toHaveLength(1)
    expect(keys[0].label).toBe(recoveryKeyLabel('whatsapp'))
    expect(keys[0].id).toBe(row.recoveryKeyId)

    const status = await getRecoveryAttempt(rec.id)
    expect(status).toMatchObject({ status: 'revoked', outcome: 'matched', hasKey: true })
    expect(status!.login).toBeNull()
  })

  it('matches a past connection of the same account, not only the live one', async () => {
    const old = await makeConnection({ channel: 'telegram', status: 'active', externalAccountId: 'tg-77' })
    await makeChat(old)
    await revokeConnection(old.id, 'disconnected')
    const rec = await startRecovery('telegram')
    if (!rec.ok) throw new Error('start failed')
    expect(await completeRecovery(rec.id, account('tg-77'))).toBe('matched')
  })

  it('a different account mints nothing and records the mismatch', async () => {
    await makeConnection({ channel: 'telegram', status: 'active', externalAccountId: 'tg-1' })
    const rec = await startRecovery('telegram')
    if (!rec.ok) throw new Error('start failed')
    expect(await completeRecovery(rec.id, account('tg-2'))).toBe('mismatched')
    const row = await rowOf(rec.id)
    expect(row.status).toBe('revoked')
    expect(row.recoveryOutcome).toBe('mismatched')
    expect(row.recoveryKeyId).toBeNull()
    expect(row.externalAccountId).toBeNull()
    expect(await countActiveAccessKeys()).toBe(0)
    expect(await getRecoveryAttempt(rec.id)).toMatchObject({ outcome: 'mismatched', hasKey: false })
    expect(await claimRecoveryKey(rec.id)).toBeNull()
  })

  it('the same account id on another channel is not a match', async () => {
    await makeConnection({ channel: 'telegram', status: 'active', externalAccountId: 'same' })
    await makeConnection({ channel: 'whatsapp', status: 'active', externalAccountId: 'other' })
    const rec = await startRecovery('whatsapp')
    if (!rec.ok) throw new Error('start failed')
    expect(await completeRecovery(rec.id, account('same', 'whatsapp'))).toBe('mismatched')
  })

  it('reports a cancelled or unknown attempt gone and never writes into it', async () => {
    await makeConnection({ channel: 'telegram', status: 'active', externalAccountId: 'tg-1' })
    const rec = await startRecovery('telegram')
    if (!rec.ok) throw new Error('start failed')
    expect(await cancelRecovery(rec.id)).toBe(true)
    expect(await completeRecovery(rec.id, account('tg-1'))).toBe('gone')
    const row = await rowOf(rec.id)
    expect(row.recoveryOutcome).toBeNull()
    expect(row.lastError).toBe('You cancelled this recovery attempt.')
    expect(await countActiveAccessKeys()).toBe(0)
    expect(await completeRecovery('not-a-real-id', account('tg-1'))).toBe('gone')
    // an archive row cannot be completed as a recovery
    const archive = await createConnection('whatsapp')
    if (archive.ok) expect(await completeRecovery(archive.id, account('x', 'whatsapp'))).toBe('gone')
  })

  it('cancel only touches recovery rows', async () => {
    const conn = await makeConnection({ status: 'pending' })
    expect(await cancelRecovery(conn.id)).toBe(false)
    expect((await getConnection(conn.id))!.status).toBe('pending')
  })

  it('the key is claimed exactly once, and only from a matched attempt', async () => {
    await makeConnection({ channel: 'telegram', status: 'active', externalAccountId: 'tg-1' })
    const rec = await startRecovery('telegram')
    if (!rec.ok) throw new Error('start failed')
    expect(await claimRecoveryKey(rec.id)).toBeNull() // nothing to claim yet
    await completeRecovery(rec.id, account('tg-1'))
    const keyId = await claimRecoveryKey(rec.id)
    expect(keyId).not.toBeNull()
    expect(await revealAccessKey(keyId!)).toMatch(/^sp_/)
    expect(await claimRecoveryKey(rec.id)).toBeNull()
    expect((await getRecoveryAttempt(rec.id))!.hasKey).toBe(false)
    expect((await rowOf(rec.id)).recoveryOutcome).toBe('matched') // the verdict stays; only the key pointer goes
  })
})
