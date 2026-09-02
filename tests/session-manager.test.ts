import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { connections, messages } from '@/lib/db/schema'
import { encryptSecret } from '@/lib/services/crypto'
import { resetDb } from './helpers/db'
import { makeConnection } from './helpers/fixtures'
import { revokeConnection, submitLoginPassword } from '@/lib/services/connections'
import * as loginModule from '@/lib/services/login'
import { FakePort } from '@/lib/channels/fake-port'
import { ChannelError, type Channel, type ChannelPort, type IncomingMessage } from '@/lib/channels/port'
import { SessionManager, backfillSinceDays } from '@/lib/channels/session-manager'

const rowOf = async (id: string) => (await db.select().from(connections).where(eq(connections.id, id)))[0]
const allMessages = () => db.select().from(messages)
const portsOf = (port: ChannelPort): Map<Channel, ChannelPort> => new Map([[port.channel, port]])

const msg = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  externalChatId: '5', chatKind: 'dm', chatTitle: 'Bob', externalMessageId: '1',
  senderExternalId: '5', senderName: 'Bob', fromOwner: false, sentAt: new Date('2026-08-01T00:00:00Z'),
  type: 'text', text: 'hi', media: null, raw: {}, ...over,
})

// Polls a real-time condition, matching FakePort's own setTimeout-based
// password loop. Used where a fire-and-forget login passes through an
// intermediate DB state the test needs to observe.
async function waitFor(check: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await check()) return
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition never became true')
    await new Promise(r => setTimeout(r, 10))
  }
}

describe('session manager', () => {
  beforeEach(resetDb)

  it('drives a pending login to active, stores the session, and backfills', async () => {
    const conn = await makeConnection({ status: 'pending' })
    const port = new FakePort('telegram')
    port.scriptLogin({ sessionString: 'SESS', account: { channel: 'telegram', externalAccountId: 'tg-1', displayName: 'Me' } })
    port.scriptBackfill([msg()])
    const mgr = new SessionManager(portsOf(port))
    await mgr.tick(); await mgr.whenIdle()   // starts and settles the login
    await mgr.tick(); await mgr.whenIdle()   // opens the active session and backfills
    const row = await rowOf(conn.id)
    expect(row.status).toBe('active')
    expect(row.externalAccountId).toBe('tg-1')
    expect(row.lastSyncAt).toBeInstanceOf(Date)
    expect(await allMessages()).toHaveLength(1)
    await mgr.stopAll()
  })

  it('a login ChannelError fails the connection (retryable), never revokes it', async () => {
    const conn = await makeConnection({ status: 'pending' })
    const port = new FakePort('telegram')
    port.scriptLoginError(new ChannelError('login timed out', 'timed_out'))
    const mgr = new SessionManager(portsOf(port))
    await mgr.tick(); await mgr.whenIdle()
    const row = await rowOf(conn.id)
    expect(row.status).toBe('error')
    expect(row.lastError).toMatch(/timed out/i)
    expect(row.revokedAt).toBeNull()
  })

  it('fails a pending login older than the timeout instead of re-driving it forever', async () => {
    const conn = await makeConnection({ status: 'pending' })
    await db.update(connections).set({ createdAt: new Date(Date.now() - 20 * 60_000) }).where(eq(connections.id, conn.id))
    const port = new FakePort('telegram')
    port.scriptLogin({ sessionString: 'S', account: { channel: 'telegram', externalAccountId: 'tg-late', displayName: null } })
    const mgr = new SessionManager(portsOf(port))
    await mgr.tick(); await mgr.whenIdle()
    const row = await rowOf(conn.id)
    expect(row.status).toBe('error')
    expect(row.lastError).toMatch(/timed out/i)
  })

  it('records a wrong password without failing the login, then completes on the right one', async () => {
    const conn = await makeConnection({ status: 'pending' })
    const port = new FakePort('telegram')
    port.scriptPasswordLogin({
      correctPassword: 'right-pw',
      result: { sessionString: 'SESS', account: { channel: 'telegram', externalAccountId: 'tg-pw', displayName: 'Me' } },
    })
    const mgr = new SessionManager(portsOf(port))
    await mgr.tick() // fire-and-forget: publishes the QR, then asks for the password

    await waitFor(async () => (await rowOf(conn.id)).loginNeedsPassword)
    expect(await submitLoginPassword(conn.id, 'wrong-pw')).toBe(true)
    await waitFor(async () => (await rowOf(conn.id)).lastError !== null)

    let row = await rowOf(conn.id)
    expect(row.lastError).toBe('password_rejected')
    expect(row.loginNeedsPassword).toBe(true) // the form comes back, it does not vanish
    expect(row.status).toBe('pending')        // still live — NOT failLogin's 'error'

    expect(await submitLoginPassword(conn.id, 'right-pw')).toBe(true)
    await mgr.whenIdle()
    row = await rowOf(conn.id)
    expect(row.status).toBe('active')
    expect(row.externalAccountId).toBe('tg-pw')
    expect(row.lastError).toBeNull()
    await mgr.stopAll()
  })

  it('never resurrects a connection revoked mid-login', async () => {
    const conn = await makeConnection({ status: 'pending' })
    await revokeConnection(conn.id, 'cancelled')
    const port = new FakePort('telegram')
    port.scriptLogin({ sessionString: 'S', account: { channel: 'telegram', externalAccountId: 'tg-race', displayName: null } })
    const mgr = new SessionManager(portsOf(port))
    await mgr.tick(); await mgr.whenIdle()
    const row = await rowOf(conn.id)
    expect(row.status).toBe('revoked')
    expect(row.sessionCiphertext).toBeNull()
  })

  it('a login driver rejection never escapes as an unhandled rejection', async () => {
    const conn = await makeConnection({ status: 'pending' })
    const port = new FakePort('telegram')
    port.scriptLoginError(new ChannelError('login timed out', 'timed_out'))
    // Force the write that reports the failure to fail too, so the only thing
    // standing between driveLogin's rejection and the process is the terminal
    // .catch() appended in startPendingLogins.
    const failLoginSpy = vi.spyOn(loginModule, 'failLogin').mockRejectedValueOnce(new Error('db write failed'))
    let unhandled: unknown = null
    const onUnhandled = (e: unknown) => { unhandled = e }
    process.on('unhandledRejection', onUnhandled)
    try {
      const mgr = new SessionManager(portsOf(port))
      await mgr.tick()
      await mgr.whenIdle()
      // Give a same-tick unhandled rejection a macrotask to surface if the
      // terminal catch were missing.
      await new Promise(r => setTimeout(r, 20))
      await mgr.stopAll()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(failLoginSpy).toHaveBeenCalled()
    expect(unhandled).toBeNull()
    // failLogin's own write never landed (it was mocked to reject), so the
    // row is exactly where the login left it — proof this ran the real path,
    // not a no-op.
    expect((await rowOf(conn.id)).status).toBe('pending')
  })

  it('leaves a pending login alone when no port is registered for its channel', async () => {
    const conn = await makeConnection({ channel: 'whatsapp', status: 'pending' })
    const mgr = new SessionManager(new Map()) // no ports at all
    await mgr.tick(); await mgr.whenIdle()
    const row = await rowOf(conn.id)
    expect(row.status).toBe('pending') // the login timeout, not the manager, ends it
    expect(row.lastError).toBeNull()
  })

  it('ingests live messages after activation, including the media flag', async () => {
    await makeConnection({ status: 'active', sessionCiphertext: encryptSecret('S') })
    const port = new FakePort('telegram')
    const mgr = new SessionManager(portsOf(port))
    await mgr.tick(); await mgr.whenIdle()
    port.emitMessage(msg({ externalMessageId: '10', text: 'live!', sentAt: new Date() }))
    port.emitMessage(msg({ externalMessageId: '11', text: null, type: 'image', media: { mimeType: 'image/jpeg', sizeBytes: 10, isVoiceNote: false, durationSeconds: null } }))
    await waitFor(async () => (await allMessages()).length === 2)
    const rows = await allMessages()
    expect(rows.map(r => r.text)).toContain('live!')
    expect(rows.find(r => r.externalMessageId === '11')!.hasMedia).toBe(true)
    await mgr.stopAll()
  })

  it('retries a failed backfill, but not before the backoff window', async () => {
    await makeConnection({ status: 'active', sessionCiphertext: encryptSecret('S') })
    const port = new FakePort('telegram')
    port.scriptBackfill([msg({ externalMessageId: '1', text: 'history' })])
    port.scriptBackfillError(new Error('network blip'))
    const mgr = new SessionManager(portsOf(port))
    await mgr.tick(); await mgr.whenIdle()
    expect(await allMessages()).toHaveLength(0)

    port.scriptBackfillError(null)
    await mgr.tick(); await mgr.whenIdle() // still inside the backoff window
    expect(await allMessages()).toHaveLength(0)

    try {
      // Fake ONLY Date: the fake session's own setTimeout and the real DB I/O
      // keep working; only the reading the backoff compares against jumps.
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.now() + 61_000)
      await mgr.tick(); await mgr.whenIdle()
    } finally {
      vi.useRealTimers()
    }
    expect((await allMessages()).map(r => r.text)).toEqual(['history'])
    await mgr.stopAll()
  })

  it('stops ingesting a backfill whose connection was revoked mid-scan', async () => {
    const conn = await makeConnection({ status: 'active', sessionCiphertext: encryptSecret('S') })
    const port = new FakePort('telegram')
    port.scriptBackfill([1, 2, 3].map(n => msg({ externalMessageId: String(n), text: `msg${n}`, sentAt: new Date(`2026-08-01T00:0${n}:00Z`) })))
    const mgr = new SessionManager(portsOf(port))
    await mgr.tick()                                              // starts the fire-and-forget backfill
    await waitFor(async () => (await allMessages()).length > 0)   // first message landed, well before the 50 ms gap
    await revokeConnection(conn.id, 'disconnected')
    await mgr.tick()                                              // notices it left activeConnections, flips the abort
    await mgr.whenIdle()
    expect((await allMessages()).length).toBeGreaterThan(0)
    // The durable signal that the abort actually took effect: recordSync only
    // ever runs once every message has been ingested, so a partial, aborted
    // backfill leaving last_sync_at null is proof it never reached the end —
    // not a fragile count of exactly how far it got.
    expect((await rowOf(conn.id)).lastSyncAt).toBeNull()
    await mgr.stopAll()
  })

  it('revokes a session that dies mid-backfill instead of retrying it forever', async () => {
    const conn = await makeConnection({ status: 'active', sessionCiphertext: encryptSecret('S') })
    const port = new FakePort('telegram')
    port.scriptBackfillError(new ChannelError('auth invalidated', 'auth_invalidated'))
    const mgr = new SessionManager(portsOf(port))
    await mgr.tick(); await mgr.whenIdle()
    const row = await rowOf(conn.id)
    expect(row.status).toBe('revoked')
    expect(row.sessionCiphertext).toBeNull()
    await mgr.stopAll()
  })

  it('logs the channel session out when the owner disconnects', async () => {
    const conn = await makeConnection({ status: 'active', sessionCiphertext: encryptSecret('S') })
    const port = new FakePort('telegram')
    const mgr = new SessionManager(portsOf(port))
    await mgr.tick(); await mgr.whenIdle()
    await revokeConnection(conn.id, 'disconnected')
    await mgr.tick()
    expect(port.loggedOut).toBe(true)
    await mgr.stopAll()
  })

  it('falls back to close() when logOut throws, without breaking the tick', async () => {
    const conn = await makeConnection({ status: 'active', sessionCiphertext: encryptSecret('S') })
    const port = new FakePort('telegram')
    port.scriptLogOutError(new Error('session already dead; cannot log out'))
    const mgr = new SessionManager(portsOf(port))
    await mgr.tick(); await mgr.whenIdle()
    await revokeConnection(conn.id, 'disconnected')
    await mgr.tick()
    expect(port.sessionClosed).toBe(true)
    await mgr.tick() // the next tick does nothing further and does not throw
    await mgr.stopAll()
  })

  it('revokes a session killed from the phone, and never tries to log that one out', async () => {
    const conn = await makeConnection({ status: 'active', sessionCiphertext: encryptSecret('S') })
    const port = new FakePort('telegram')
    const mgr = new SessionManager(portsOf(port))
    await mgr.tick(); await mgr.whenIdle()
    port.scriptPingError(new ChannelError('auth invalidated', 'auth_invalidated'))
    await mgr.tick()
    const row = await rowOf(conn.id)
    expect(row.status).toBe('revoked')
    expect(row.sessionCiphertext).toBeNull()
    expect(row.lastError).toMatch(/phone/i)
    expect(port.loggedOut).toBe(false)   // it is already gone on the channel's side
    expect(port.sessionClosed).toBe(true)
    await mgr.stopAll()
  })

  it('one broken connection does not starve the others in the same tick', async () => {
    await makeConnection({ channel: 'whatsapp', status: 'active', sessionCiphertext: 'not-decryptable' })
    await makeConnection({ channel: 'telegram', status: 'active', sessionCiphertext: encryptSecret('S') })
    const tg = new FakePort('telegram')
    const wa = new FakePort('whatsapp')
    const mgr = new SessionManager(new Map<Channel, ChannelPort>([['telegram', tg], ['whatsapp', wa]]))
    await mgr.tick(); await mgr.whenIdle()
    tg.emitMessage(msg({ externalMessageId: '5', text: 'still works', sentAt: new Date() }))
    await waitFor(async () => (await allMessages()).length === 1)
    expect((await allMessages()).map(r => r.text)).toEqual(['still works'])
    await mgr.stopAll()
  })

  it('stopAll resolves promptly during an in-flight login, and a later tick opens nothing more', async () => {
    const conn = await makeConnection({ status: 'pending' })
    const port = new FakePort('telegram')
    // Replaces login() with a promise the test controls directly, mirroring a
    // QR nobody has scanned yet — no scripted timeout, no background timer to
    // clean up afterwards.
    let release = () => {}
    const gate = new Promise<void>(r => { release = r })
    port.login = async driver => {
      await driver.publishQr('tg://login?token=FAKE')
      await gate
      return { sessionString: 'S', account: { channel: 'telegram', externalAccountId: 'tg-hang', displayName: null } }
    }
    const mgr = new SessionManager(portsOf(port))
    await mgr.tick() // fire-and-forget: starts the login, which now hangs on `gate`
    await waitFor(async () => (await rowOf(conn.id)).loginQrToken !== null)

    const start = Date.now()
    await mgr.stopAll() // must not wait out a login that can legitimately hang for the full 15-minute window
    expect(Date.now() - start).toBeLessThan(1000)

    await mgr.tick() // stopping: must not re-claim the still-pending login
    expect((await rowOf(conn.id)).status).toBe('pending')
    // Drain it fully — stopAll() deliberately does not await loginsInFlight,
    // but leaving it settling in the background past this test's end would
    // let its completeLogin() write land during a LATER test's resetDb.
    release()
    await mgr.whenIdle()
  })
})

describe('backfillSinceDays', () => {
  const NOW = new Date('2026-08-28T12:00:00Z')
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000)
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000)

  it('never synced -> the full 30-day window', () => {
    expect(backfillSinceDays(null, NOW)).toBe(30)
  })
  it('synced 2 hours ago -> 2, the floor this margin can produce', () => {
    // ceil(2h in days) = 1, plus 1 day of deliberate margin (clock skew, a gap
    // straddling a day boundary) — never a margin-free 1.
    expect(backfillSinceDays(hoursAgo(2), NOW)).toBe(2)
  })
  it('synced 10 days ago -> 11', () => {
    expect(backfillSinceDays(daysAgo(10), NOW)).toBe(11)
  })
  it('synced 90 days ago -> 30, capped at the ceiling', () => {
    expect(backfillSinceDays(daysAgo(90), NOW)).toBe(30)
  })
})
