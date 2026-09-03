import { describe, it, expect, beforeEach, vi } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { env } from '@/lib/env'
import { log } from '@/lib/log'
import { channelContacts, connections, messages } from '@/lib/db/schema'
import { encryptSecret } from '@/lib/services/crypto'
import { resetDb } from './helpers/db'
import { makeConnection } from './helpers/fixtures'
import { revokeConnection, submitLoginPassword } from '@/lib/services/connections'
import * as connectionsModule from '@/lib/services/connections'
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

  // The row gets one of three fixed sentences, so the logs are the only place
  // a login that fails the same way every time can be diagnosed from.
  it('logs why a login failed', async () => {
    await makeConnection({ status: 'pending' })
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const port = new FakePort('telegram')
      port.scriptLoginError(new ChannelError('whatsapp closed during pairing (428)', 'other'))
      const mgr = new SessionManager(portsOf(port))
      await mgr.tick(); await mgr.whenIdle()

      const call = warn.mock.calls.find(c => c[1] === 'login failed')
      expect(call).toBeDefined()
      const bag = call![0] as { err: { message: string }; kind: string; connectionId: string }
      expect(bag.kind).toBe('other')
      expect(bag.err.message).toMatch(/428/)
      // Never the driver payload, never a QR.
      expect(Object.keys(bag).sort()).toEqual(['connectionId', 'err', 'kind'])
    } finally {
      warn.mockRestore()
    }
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

  it('a backfill driver rejection never escapes as an unhandled rejection', async () => {
    const conn = await makeConnection({ status: 'active', sessionCiphertext: encryptSecret('S') })
    const port = new FakePort('telegram')
    // The backfill dies the way a phone-side revoke kills it, so runBackfill
    // routes into handleSessionError… and the revoke write it makes there is
    // forced to fail too. Nothing downstream awaits the backfill promise on
    // the happy path, so the only thing between that rejection and the
    // process is the terminal .catch() appended in maybeStartBackfill.
    port.scriptBackfillError(new ChannelError('auth invalidated', 'auth_invalidated'))
    const revokeSpy = vi.spyOn(connectionsModule, 'revokeConnection').mockRejectedValueOnce(new Error('db write failed'))
    let unhandled: unknown = null
    const onUnhandled = (e: unknown) => { unhandled = e }
    process.on('unhandledRejection', onUnhandled)
    try {
      const mgr = new SessionManager(portsOf(port))
      await mgr.tick()
      await mgr.whenIdle()
      await new Promise(r => setTimeout(r, 20)) // let a same-tick rejection surface
      await mgr.stopAll()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(revokeSpy).toHaveBeenCalled()
    revokeSpy.mockRestore() // after the assertion: mockRestore also clears the call log
    // The revoke write was mocked to reject, so the row is untouched — proof
    // this ran the real path rather than a no-op.
    expect(unhandled).toBeNull()
    expect((await rowOf(conn.id)).status).toBe('active')
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

  // PRIVACY.md's Disconnect paragraph rests on this: the database credential
  // goes at the moment of the click, but WhatsApp's real credential is the
  // Baileys auth directory on the volume, and only the worker can reach it.
  it('removes a revoked WhatsApp connection auth directory after closing its session', async () => {
    const conn = await makeConnection({ channel: 'whatsapp', status: 'active' })
    await db.update(connections).set({ sessionCiphertext: encryptSecret(`wa-${conn.id}`) })
      .where(eq(connections.id, conn.id))
    const dir = path.join(env.DATA_DIR, 'whatsapp', `wa-${conn.id}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'creds.json'), '{}')

    const port = new FakePort('whatsapp')
    const mgr = new SessionManager(portsOf(port))
    await mgr.tick(); await mgr.whenIdle()      // opens the session
    expect(existsSync(dir)).toBe(true)          // still linked: nothing is touched

    await revokeConnection(conn.id, 'You disconnected this channel.')
    await mgr.tick()
    expect(port.loggedOut).toBe(true)
    expect(existsSync(dir)).toBe(false)
    await mgr.tick()                            // idempotent: a second sweep does not throw
    await mgr.stopAll()
  })

  // The case the wording has to cover: the owner disconnected while the worker
  // was down, so there was never a session to close. The next run cleans up.
  it('removes the auth directory of a WhatsApp row revoked while the worker was down', async () => {
    const conn = await makeConnection({ channel: 'whatsapp', status: 'active' })
    await revokeConnection(conn.id, 'You disconnected this channel.')
    const dir = path.join(env.DATA_DIR, 'whatsapp', `wa-${conn.id}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'creds.json'), '{}')

    const mgr = new SessionManager(portsOf(new FakePort('whatsapp')))
    await mgr.tick()
    expect(existsSync(dir)).toBe(false)
    await mgr.stopAll()
  })

  it('leaves an active WhatsApp connection auth directory alone', async () => {
    const conn = await makeConnection({ channel: 'whatsapp', status: 'active' })
    await db.update(connections).set({ sessionCiphertext: encryptSecret(`wa-${conn.id}`) })
      .where(eq(connections.id, conn.id))
    const dir = path.join(env.DATA_DIR, 'whatsapp', `wa-${conn.id}`)
    mkdirSync(dir, { recursive: true })

    const mgr = new SessionManager(portsOf(new FakePort('whatsapp')))
    await mgr.tick(); await mgr.whenIdle()
    await mgr.tick()
    expect(existsSync(dir)).toBe(true)
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

  it('falls back to close() when logOut never answers, without wedging the tick', async () => {
    const conn = await makeConnection({ status: 'active', sessionCiphertext: encryptSecret('S') })
    const port = new FakePort('telegram')
    const mgr = new SessionManager(portsOf(port))
    await mgr.tick(); await mgr.whenIdle()
    port.scriptLogOutHang()                       // the channel accepts the call and goes quiet
    await revokeConnection(conn.id, 'disconnected')
    try {
      // Only the timers: the DB driver is synchronous, so nothing else in the
      // tick depends on a clock that has stopped.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const ticked = mgr.tick()
      // Let the tick reach the bounded race before the clock jumps.
      while (vi.getTimerCount() === 0) await new Promise(r => setImmediate(r))
      await vi.advanceTimersByTimeAsync(20_000)
      await ticked                                // resolves: the tick is not wedged
    } finally {
      vi.useRealTimers()
    }
    expect(port.sessionClosed).toBe(true)
    expect(port.loggedOut).toBe(false)
    port.scriptLogOutHang(false)
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

  // The WhatsApp port raises 'other' from ping() once it has not been
  // CONNECTED for a full stale window — a reconnect loop that never reaches
  // 'open'. Logging that once a minute forever leaves the archive stopped with
  // the row still reading 'active'.
  it('recycles a session after three consecutive other ping failures, and reopens it next tick', async () => {
    const conn = await makeConnection({ status: 'active', sessionCiphertext: encryptSecret('S') })
    const port = new FakePort('telegram')
    const mgr = new SessionManager(portsOf(port))
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log)
    try {
      await mgr.tick(); await mgr.whenIdle()      // opens and backfills
      port.scriptPingError(new ChannelError('whatsapp has not been connected for a full stale window', 'other'))

      // Three probes, each in its own throttle window. Only Date is faked, as
      // in the throttle test above, so the real DB I/O keeps working.
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        await mgr.tick()                          // failure 1
        expect(port.sessionClosed).toBe(false)
        vi.setSystemTime(Date.now() + 61_000)
        await mgr.tick()                          // failure 2
        expect(port.sessionClosed).toBe(false)
        vi.setSystemTime(Date.now() + 61_000)
        await mgr.tick()                          // failure 3: recycled
      } finally {
        vi.useRealTimers()
      }

      expect(port.pingCount).toBe(3)
      expect(port.sessionClosed).toBe(true)
      const recycled = warn.mock.calls.find(c => c[1] === 'session recycled')
      expect(recycled?.[0]).toMatchObject({ connectionId: conn.id, consecutiveOther: 3 })

      // The row is untouched — this is not a failure of the connection.
      const row = await rowOf(conn.id)
      expect(row.status).toBe('active')
      expect(row.lastError).toBeNull()
      expect(row.revokedAt).toBeNull()

      // Dropped from `running`, so the next tick opens a fresh session.
      port.scriptPingError(null)
      await mgr.tick(); await mgr.whenIdle()
      expect(port.sessionClosed).toBe(false)
    } finally {
      warn.mockRestore()
    }
    await mgr.stopAll()
  })

  // Regression for the bug in c154533: a session whose backfill never
  // completes stays on the UNTHROTTLED !existing.backfilled ping branch
  // forever, at the 3 s tick cadence rather than PING_EVERY_MS. A FLOOD_WAIT
  // there is expected load from a long backfill, not a wedged session, so it
  // must never count toward consecutiveOther — only the throttled,
  // backfilled-branch probe may recycle.
  it('never recycles a session stuck pre-backfill, even after five consecutive other ping failures', async () => {
    const conn = await makeConnection({ status: 'active', sessionCiphertext: encryptSecret('S') })
    const port = new FakePort('telegram')
    // Backfill never completes: a non-auth error, retried on its own
    // BACKFILL_RETRY_BACKOFF_MS backoff, never flips `backfilled` true — so
    // every tick below keeps taking the pre-backfill ping branch.
    port.scriptBackfillError(new Error('network blip'))
    port.scriptPingError(new ChannelError('FLOOD_WAIT (420)', 'other'))
    const mgr = new SessionManager(portsOf(port))
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log)
    try {
      await mgr.tick(); await mgr.whenIdle() // opens the session; first (failing) backfill attempt
      expect(port.pingCount).toBe(0)         // pings only fire for an already-running session

      // Five consecutive ticks, each pinging — unthrottled, no PING_EVERY_MS
      // gate on this branch — and each failing 'other'. Under the bug this
      // being fixed, three of these would have recycled the session.
      for (let i = 0; i < 5; i++) {
        await mgr.tick(); await mgr.whenIdle()
      }

      expect(port.pingCount).toBe(5)
      expect(port.sessionClosed).toBe(false) // never recycled
      expect(warn.mock.calls.find(c => c[1] === 'session recycled')).toBeUndefined()

      const row = await rowOf(conn.id)
      expect(row.status).toBe('active')
      expect(row.lastSyncAt).toBeNull() // the backfill genuinely never completed
    } finally {
      warn.mockRestore()
    }
    await mgr.stopAll()
  })

  it('a successful ping clears the recycle counter', async () => {
    await makeConnection({ status: 'active', sessionCiphertext: encryptSecret('S') })
    const port = new FakePort('telegram')
    const mgr = new SessionManager(portsOf(port))
    await mgr.tick(); await mgr.whenIdle()

    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      for (const err of [true, true, false, true, true]) {
        port.scriptPingError(err ? new ChannelError('transient', 'other') : null)
        await mgr.tick()
        vi.setSystemTime(Date.now() + 61_000)
      }
    } finally {
      vi.useRealTimers()
    }
    // Two failures, a success, then two more: never three in a row.
    expect(port.pingCount).toBe(5)
    expect(port.sessionClosed).toBe(false)
    await mgr.stopAll()
  })

  it('probes liveness once a minute, not once a tick', async () => {
    const conn = await makeConnection({ status: 'active', sessionCiphertext: encryptSecret('S') })
    const port = new FakePort('telegram')
    const mgr = new SessionManager(portsOf(port))
    await mgr.tick(); await mgr.whenIdle()   // opens and backfills; no probe yet
    expect(port.pingCount).toBe(0)

    await mgr.tick()                          // first tick after open probes immediately
    expect(port.pingCount).toBe(1)
    const firstSync = (await rowOf(conn.id)).lastSyncAt

    await mgr.tick(); await mgr.tick()        // inside the window: no RPC, no UPDATE
    expect(port.pingCount).toBe(1)
    expect((await rowOf(conn.id)).lastSyncAt).toEqual(firstSync)

    try {
      // Fake ONLY Date, exactly as the backfill-backoff test does: the real
      // DB I/O keeps working and only the reading the throttle compares
      // against jumps past the window.
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(Date.now() + 61_000)
      await mgr.tick()
    } finally {
      vi.useRealTimers()
    }
    expect(port.pingCount).toBe(2)
    expect((await rowOf(conn.id)).lastSyncAt).not.toEqual(firstSync)
    await mgr.stopAll()
  })

  // Contact sync. The address book is the raw material the People page turns
  // into "this Telegram id and this WhatsApp number are one person", and the
  // only place it comes from is the channel's own contact list.
  it("caches the channel's address book once the backfill lands", async () => {
    const conn = await makeConnection({ status: 'active', sessionCiphertext: encryptSecret('S') })
    const port = new FakePort('telegram')
    port.contacts = [
      { externalId: '5', displayName: 'Bob', phone: '+44 7700 900123' },
      { externalId: '9', displayName: null, phone: null },
    ]
    const mgr = new SessionManager(portsOf(port))
    await mgr.tick(); await mgr.whenIdle()

    const rows = await db.select().from(channelContacts).where(eq(channelContacts.connectionId, conn.id))
    expect(rows.map(r => [r.channel, r.externalId, r.displayName, r.phone]).sort()).toEqual([
      // The service normalises the phone on the way in; the manager hands it
      // through exactly as the channel reported it.
      ['telegram', '5', 'Bob', '+447700900123'],
      ['telegram', '9', null, null],
    ])
    expect(port.listContactsCount).toBe(1)
    await mgr.stopAll()
  })

  // A contact list is a convenience over an archive that is already correct
  // without it, so the failure budget here is deliberately the gentlest in
  // this file: log it, keep the session, try again next window.
  it('an address book that will not load is logged and never stops the session', async () => {
    const conn = await makeConnection({ status: 'active', sessionCiphertext: encryptSecret('S') })
    const port = new FakePort('telegram')
    port.contacts = [{ externalId: '5', displayName: 'Bob', phone: '+447700900123' }]
    port.scriptContactsError(new Error('CONTACTS_UNAVAILABLE'))
    const mgr = new SessionManager(portsOf(port))
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log)
    try {
      await mgr.tick(); await mgr.whenIdle()

      const call = warn.mock.calls.find(c => c[1] === 'contact sync failed')
      expect(call).toBeDefined()
      const bag = call![0] as { err: { message: string }; connectionId: string }
      expect(bag.err.message).toMatch(/CONTACTS_UNAVAILABLE/)
      // The error and the id, nothing else: this is the one code path that
      // handles every name and phone number the instance holds.
      expect(Object.keys(bag).sort()).toEqual(['connectionId', 'err'])
      expect(await db.select().from(channelContacts)).toHaveLength(0)

      // Same session, still active: not closed, not recycled, not revoked, and
      // the backfill it followed still counted.
      expect(port.sessionClosed).toBe(false)
      expect(warn.mock.calls.find(c => c[1] === 'session recycled')).toBeUndefined()
      const row = await rowOf(conn.id)
      expect(row.status).toBe('active')
      expect(row.revokedAt).toBeNull()
      expect(row.lastError).toBeNull()
      expect(row.lastSyncAt).toBeInstanceOf(Date)
    } finally {
      warn.mockRestore()
    }
    // And it keeps archiving, which is the whole point of not stopping.
    port.emitMessage(msg({ externalMessageId: '7', text: 'still archiving', sentAt: new Date() }))
    await waitFor(async () => (await allMessages()).length === 1)
    await mgr.stopAll()
  })

  // The one failure a contact read is NOT forgiving about: this is not "the
  // address book is unavailable", it is the session being gone, and it is
  // treated exactly as a failed liveness probe would be.
  it('revokes when the contact read is the call that notices a dead session', async () => {
    const conn = await makeConnection({ status: 'active', sessionCiphertext: encryptSecret('S') })
    const port = new FakePort('telegram')
    port.scriptContactsError(new ChannelError('AUTH_KEY_UNREGISTERED', 'auth_invalidated'))
    const mgr = new SessionManager(portsOf(port))
    await mgr.tick(); await mgr.whenIdle()

    const row = await rowOf(conn.id)
    expect(row.status).toBe('revoked')
    expect(row.sessionCiphertext).toBeNull()
    expect(port.sessionClosed).toBe(true)
    await mgr.stopAll()
  })

  it('re-reads the address book every six hours, not every tick', async () => {
    await makeConnection({ status: 'active', sessionCiphertext: encryptSecret('S') })
    const port = new FakePort('telegram')
    port.contacts = [{ externalId: '5', displayName: 'Bob', phone: null }]
    const mgr = new SessionManager(portsOf(port))
    await mgr.tick(); await mgr.whenIdle()   // opens, backfills, syncs once
    expect(port.listContactsCount).toBe(1)

    try {
      // Fake ONLY Date, as the ping-throttle test above does, so the real DB
      // I/O keeps working and only the reading the throttle compares against
      // jumps.
      vi.useFakeTimers({ toFake: ['Date'] })
      // Past the one-minute ping window — so the branch that could re-read
      // contacts genuinely runs — but nowhere near the six-hour one.
      vi.setSystemTime(Date.now() + 61_000)
      await mgr.tick(); await mgr.whenIdle()
      expect(port.pingCount).toBe(1)
      expect(port.listContactsCount).toBe(1)

      vi.setSystemTime(Date.now() + 6 * 3_600_000)
      await mgr.tick(); await mgr.whenIdle()
    } finally {
      vi.useRealTimers()
    }
    expect(port.listContactsCount).toBe(2)
    await mgr.stopAll()
  })

  // Six hours is the cadence for an address book that is already cached. A
  // read that never landed cached nothing, and the People page shows bare ids
  // until one does — so a failure buys ten minutes, not six hours.
  it('retries a failed address book read in ten minutes, not in six hours', async () => {
    await makeConnection({ status: 'active', sessionCiphertext: encryptSecret('S') })
    const port = new FakePort('telegram')
    port.contacts = [{ externalId: '5', displayName: 'Bob', phone: null }]
    port.scriptContactsError(new Error('CONTACTS_UNAVAILABLE'))
    const mgr = new SessionManager(portsOf(port))
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log)
    try {
      await mgr.tick(); await mgr.whenIdle()
      expect(port.listContactsCount).toBe(1)
      expect(await db.select().from(channelContacts)).toHaveLength(0)

      // Fake ONLY Date, as the throttle tests above do.
      vi.useFakeTimers({ toFake: ['Date'] })
      // Past the one-minute ping window — so the branch that could re-read
      // contacts genuinely runs — and well short of ten minutes.
      vi.setSystemTime(Date.now() + 61_000)
      await mgr.tick(); await mgr.whenIdle()
      expect(port.listContactsCount).toBe(1)

      vi.setSystemTime(Date.now() + 10 * 60_000)
      port.scriptContactsError(null)
      await mgr.tick(); await mgr.whenIdle()
    } finally {
      vi.useRealTimers()
      warn.mockRestore()
    }
    expect(port.listContactsCount).toBe(2)
    expect(await db.select().from(channelContacts)).toHaveLength(1)
    await mgr.stopAll()
  })

  // consecutiveOther is the liveness probe's counter and nothing else's. A
  // contact list that will not load says nothing about whether the session is
  // wedged, and three of them in a row must not recycle it.
  it('three failing contact reads leave the recycle counter untouched', async () => {
    const conn = await makeConnection({ status: 'active', sessionCiphertext: encryptSecret('S') })
    const port = new FakePort('telegram')
    port.scriptContactsError(new Error('CONTACTS_UNAVAILABLE'))
    const mgr = new SessionManager(portsOf(port))
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log)
    const error = vi.spyOn(log, 'error').mockImplementation(() => log)
    try {
      await mgr.tick(); await mgr.whenIdle()
      vi.useFakeTimers({ toFake: ['Date'] })
      for (const _ of [1, 2]) {
        vi.setSystemTime(Date.now() + 11 * 60_000)
        await mgr.tick(); await mgr.whenIdle()
      }
      vi.useRealTimers()

      expect(port.listContactsCount).toBe(3)
      expect(warn.mock.calls.filter(c => c[1] === 'contact sync failed')).toHaveLength(3)
      // MAX_CONSECUTIVE_OTHER is 3: if these had been counted, the third would
      // have recycled the session.
      expect(warn.mock.calls.find(c => c[1] === 'session recycled')).toBeUndefined()
      // And they never reached handleSessionError at all.
      expect(error.mock.calls.find(c => c[1] === 'session error; will retry next tick')).toBeUndefined()
    } finally {
      vi.useRealTimers()
      warn.mockRestore()
      error.mockRestore()
    }
    expect(port.sessionClosed).toBe(false)
    const row = await rowOf(conn.id)
    expect(row.status).toBe('active')
    expect(row.revokedAt).toBeNull()
    // Still the same live session, still archiving.
    port.emitMessage(msg({ externalMessageId: '11', text: 'still archiving', sentAt: new Date() }))
    await waitFor(async () => (await allMessages()).length === 1)
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
