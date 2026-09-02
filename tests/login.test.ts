import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { connections } from '@/lib/db/schema'
import { encryptSecret, decryptSecret } from '@/lib/services/crypto'
import { resetDb } from './helpers/db'
import { makeConnection } from './helpers/fixtures'
import { revokeConnection, PASSWORD_REJECTED } from '@/lib/services/connections'
import {
  claimPendingLogins, activeConnections, publishQr, requestPassword,
  takeLoginSecret, recordPasswordRejected, completeLogin, failLogin, recordSync,
} from '@/lib/services/login'

const rowOf = async (id: string) => (await db.select().from(connections).where(eq(connections.id, id)))[0]

describe('login handshake (worker-facing)', () => {
  beforeEach(resetDb)

  it('claims only live pending rows, with the channel and createdAt the timeout needs', async () => {
    const pending = await makeConnection({ channel: 'telegram', status: 'pending' })
    await makeConnection({ channel: 'whatsapp', status: 'active' })
    const claimed = await claimPendingLogins()
    expect(claimed).toHaveLength(1)
    expect(claimed[0]).toMatchObject({ id: pending.id, channel: 'telegram' })
    expect(claimed[0].createdAt).toBeInstanceOf(Date)

    await revokeConnection(pending.id, 'gone')
    expect(await claimPendingLogins()).toEqual([])
  })

  it('publishQr and requestPassword write the handshake columns', async () => {
    const conn = await makeConnection({ status: 'pending' })
    await publishQr(conn.id, 'tg://login?token=xyz')
    await requestPassword(conn.id)
    const row = await rowOf(conn.id)
    expect(row.loginQrToken).toBe('tg://login?token=xyz')
    expect(row.loginQrAt).toBeInstanceOf(Date)
    expect(row.loginNeedsPassword).toBe(true)
  })

  it('takeLoginSecret decrypts once, then nulls it; a stale secret is ignored and cleared', async () => {
    const conn = await makeConnection({ status: 'pending' })
    await db.update(connections)
      .set({ loginSecretCiphertext: encryptSecret('pw'), loginSecretAt: new Date() })
      .where(eq(connections.id, conn.id))
    expect(await takeLoginSecret(conn.id)).toBe('pw')
    expect((await rowOf(conn.id)).loginSecretCiphertext).toBeNull()
    expect(await takeLoginSecret(conn.id)).toBeNull()

    await db.update(connections)
      .set({ loginSecretCiphertext: encryptSecret('old'), loginSecretAt: new Date(Date.now() - 6 * 60_000) })
      .where(eq(connections.id, conn.id))
    expect(await takeLoginSecret(conn.id)).toBeNull()
    expect((await rowOf(conn.id)).loginSecretCiphertext).toBeNull()
  })

  it('recordPasswordRejected keeps the handshake live and leaves the form up', async () => {
    const conn = await makeConnection({ status: 'pending' })
    await requestPassword(conn.id)
    await recordPasswordRejected(conn.id)
    const row = await rowOf(conn.id)
    expect(row.lastError).toBe(PASSWORD_REJECTED)
    expect(row.loginNeedsPassword).toBe(true)
    expect(row.status).toBe('pending') // NOT failLogin's 'error' — still live
  })

  it('completeLogin activates, encrypts the session, and clears every login column', async () => {
    const conn = await makeConnection({ status: 'pending' })
    await publishQr(conn.id, 'q')
    expect(await completeLogin(conn.id, 'SESSION_STRING', { channel: 'telegram', externalAccountId: 'tg-123', displayName: 'Me' })).toBe('ok')
    const row = await rowOf(conn.id)
    expect(row.status).toBe('active')
    expect(row.externalAccountId).toBe('tg-123')
    expect(row.displayName).toBe('Me')
    expect(row.loginQrToken).toBeNull()
    expect(row.lastError).toBeNull()
    expect(decryptSecret(row.sessionCiphertext!)).toBe('SESSION_STRING')
  })

  it('completeLogin refuses to resurrect a revoked row, and reports a vanished one gone', async () => {
    const conn = await makeConnection({ status: 'pending' })
    await revokeConnection(conn.id, 'cancelled')
    expect(await completeLogin(conn.id, 'S', { channel: 'telegram', externalAccountId: 'tg-9', displayName: null })).toBe('gone')
    const row = await rowOf(conn.id)
    expect(row.status).toBe('revoked')
    expect(row.sessionCiphertext).toBeNull()
    expect(await completeLogin('not-a-real-id', 'S', { channel: 'telegram', externalAccountId: 'x', displayName: null })).toBe('gone')
  })

  it('failLogin sets a retryable error without revoking, and clears the login columns', async () => {
    const conn = await makeConnection({ status: 'pending' })
    await publishQr(conn.id, 'q'); await requestPassword(conn.id)
    await failLogin(conn.id, 'Login timed out — please try again.')
    const row = await rowOf(conn.id)
    expect(row.status).toBe('error')
    expect(row.lastError).toBe('Login timed out — please try again.')
    expect(row.revokedAt).toBeNull()
    expect(row.loginQrToken).toBeNull()
    expect(row.loginNeedsPassword).toBe(false)
  })

  it('the worker cannot write login state into a revoked row', async () => {
    const conn = await makeConnection({ status: 'pending' })
    await revokeConnection(conn.id, 'cancelled')
    await publishQr(conn.id, 'tg://login?token=nope')
    await requestPassword(conn.id)
    await recordPasswordRejected(conn.id)
    await failLogin(conn.id, 'should not land')
    const row = await rowOf(conn.id)
    expect(row.status).toBe('revoked')
    expect(row.loginQrToken).toBeNull()
    expect(row.loginNeedsPassword).toBe(false)
    expect(row.lastError).toBe('cancelled')
  })

  it('activeConnections returns openable rows and recordSync stamps last_sync_at', async () => {
    const conn = await makeConnection({ status: 'active', sessionCiphertext: encryptSecret('S') })
    const rows = await activeConnections()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: conn.id, channel: 'telegram', lastSyncAt: null })
    expect(decryptSecret(rows[0].sessionCiphertext!)).toBe('S')
    await recordSync(conn.id)
    expect((await rowOf(conn.id)).lastSyncAt).toBeInstanceOf(Date)
  })
})
