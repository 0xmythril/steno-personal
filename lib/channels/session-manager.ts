import { decryptSecret } from '@/lib/services/crypto'
import { log, errorShape } from '@/lib/log'
import {
  claimPendingLogins, activeConnections, publishQr, requestPassword,
  takeLoginSecret, recordPasswordRejected, completeLogin, failLogin, recordSync,
} from '@/lib/services/login'
import { revokeConnection } from '@/lib/services/connections'
import { recordMessage, applyEdit, applyDelete } from '@/lib/services/ingest'
import { enqueueMedia } from '@/lib/services/media'
import { ChannelError, type Channel, type ChannelPort, type ChannelSession, type IncomingMessage } from '@/lib/channels/port'

const LOGIN_TIMEOUT_MS = 15 * 60_000
const BACKFILL_CAPS = { maxDialogs: 200, maxPerChat: 500 }
const MAX_BACKFILL_DAYS = 30
// A persistently failing backfill must not re-scan every 3 s tick — that is
// self-amplifying against the very throttling likely causing it to fail.
const BACKFILL_RETRY_BACKOFF_MS = 60_000
// The teardown logOut() is awaited inside a tick, which the worker's own loop
// awaits, so an unanswered one wedges the manager entirely: no other
// connection converges and SIGTERM is ignored until the orchestrator SIGKILLs.
// The port bounds its own RPCs too; this is the belt-and-braces bound that
// does not depend on a port getting that right.
const LOGOUT_TIMEOUT_MS = 20_000

// Bounds a promise that must never hold the tick loop. The loser of the race
// is not cancellable — it keeps running in the background — but Promise.race
// has already attached handlers to it, so a late rejection is delivered to a
// handler that ignores it rather than escaping as an unhandled rejection.
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([p, bound]).finally(() => clearTimeout(timer))
}

// Bounds the re-scan window by the durable last_sync_at marker, so a worker
// restart does not re-run a full 30-day scan: forward ingest through the
// update handlers already covered everything while the worker was up, and
// recordSync bumps last_sync_at on every healthy liveness tick. A never-synced
// connection still gets the full window. Pure, so it is directly testable.
export function backfillSinceDays(lastSyncAt: Date | null, now: Date = new Date()): number {
  if (!lastSyncAt) return MAX_BACKFILL_DAYS
  const daysSince = (now.getTime() - lastSyncAt.getTime()) / 86_400_000
  return Math.max(1, Math.min(MAX_BACKFILL_DAYS, Math.ceil(daysSince) + 1))
}

type Running = {
  channel: Channel
  session: ChannelSession
  backfilled: boolean
  // Flipped the instant this connection is being torn down (revoked, dead
  // session, or worker shutdown) — read by an in-flight backfill's
  // shouldContinue() so it stops instead of reading a connection nobody
  // controls any more.
  stopped: boolean
  lastBackfillAttempt: number // epoch ms; 0 means never attempted
  backfillSinceDays: number   // fixed at open time; retries reuse it
}

// One SessionManager per worker. tick() is idempotent, self-serializing (a
// tick already in flight makes a concurrent call a no-op — never queued), and
// safe on an interval: it converges the set of open channel sessions to the
// set of active rows.
export class SessionManager {
  private running = new Map<string, Running>()            // connectionId -> open session
  private loginsInFlight = new Map<string, Promise<void>>()
  private backfillsInFlight = new Map<string, Promise<void>>()
  private ticking = false
  private stopping = false

  constructor(private ports: Map<Channel, ChannelPort>) {}

  // Self-serializing: a call while a tick is already in flight returns
  // immediately rather than queueing — the poll interval is short enough that
  // a queued tick would just pile up behind a slow one instead of ever
  // converging. stopping keeps a new tick from starting once shutdown has
  // begun.
  async tick(): Promise<void> {
    if (this.stopping || this.ticking) return
    this.ticking = true
    try {
      await this.startPendingLogins()
      await this.reconcileActive()
    } finally {
      this.ticking = false
    }
  }

  // Awaits in-flight logins and backfills. Used by tests for determinism and
  // by stopAll for a clean shutdown.
  async whenIdle(): Promise<void> {
    await Promise.all([...this.loginsInFlight.values(), ...this.backfillsInFlight.values()])
  }

  // A real QR login blocks for up to timeoutMs waiting for a scan, so each
  // pending login is STARTED and left to settle into the database on its own;
  // awaiting it here would freeze the whole poll loop. The timeout is measured
  // from the row's own createdAt, not an in-process timer, so a worker restart
  // cannot reset the clock and re-drive a stale login forever.
  private async startPendingLogins(): Promise<void> {
    if (this.stopping) return
    for (const conn of await claimPendingLogins()) {
      if (this.loginsInFlight.has(conn.id)) continue
      const port = this.ports.get(conn.channel)
      // No port for this channel (Telegram credentials unset, or WhatsApp
      // before M2): leave the row alone. Its own login timeout ends it, and
      // the portal already says a code needs a running worker.
      if (!port) continue
      const age = Date.now() - conn.createdAt.getTime()
      if (age > LOGIN_TIMEOUT_MS) {
        await failLogin(conn.id, 'Login timed out — please try again.')
        continue
      }
      const p = this.driveLogin(port, conn.id, LOGIN_TIMEOUT_MS - age)
        .finally(() => this.loginsInFlight.delete(conn.id))
        // Terminal: driveLogin is fire-and-forget, so nothing downstream
        // awaits it directly. Without this, a failing write inside it (e.g.
        // failLogin's own DB update throwing) would escape as an unhandled
        // rejection instead of just being logged.
        .catch(e => log.error({ err: errorShape(e), connectionId: conn.id }, 'login driver failed'))
      this.loginsInFlight.set(conn.id, p)
    }
  }

  private async driveLogin(port: ChannelPort, connId: string, timeoutMs: number): Promise<void> {
    const driver = {
      publishQr: (url: string) => publishQr(connId, url),
      requestPassword: () => requestPassword(connId),
      getPassword: () => takeLoginSecret(connId),
      passwordRejected: () => recordPasswordRejected(connId),
    }
    try {
      const { sessionString, account } = await port.login(driver, { timeoutMs, connectionId: connId })
      const res = await completeLogin(connId, sessionString, account)
      if (res === 'duplicate') await failLogin(connId, 'That account is already connected.')
      // 'gone' = revoked or deleted mid-login. The write was refused on
      // purpose, and there is nothing left on that row to tell anyone.
    } catch (e) {
      const kind = e instanceof ChannelError ? e.kind : 'other'
      const message = kind === 'timed_out' ? 'Login timed out — please try again.'
        : kind === 'auth_invalidated' ? 'Login was rejected. Please try again.'
        : 'Login failed — please try again.'
      await failLogin(connId, message)
    }
  }

  private async reconcileActive(): Promise<void> {
    const active = await activeConnections()
    const activeIds = new Set(active.map(a => a.id))

    // Close sessions no longer active in the database — the owner
    // disconnected, or the row was revoked, since the last tick. This is the
    // only teardown reached from OUTSIDE this pass, so it is the only place a
    // still-authenticated logOut() is meaningful. Fall back to close() when it
    // throws OR when it does not answer within LOGOUT_TIMEOUT_MS: an
    // already-dead session cannot log itself out, and a revoke is exactly when
    // the channel is least likely to answer promptly — neither may break the
    // loop for the other connections.
    for (const [connId, r] of this.running) {
      if (activeIds.has(connId)) continue
      r.stopped = true
      try {
        await withTimeout(r.session.logOut(), LOGOUT_TIMEOUT_MS, 'logOut')
      } catch (e) {
        log.error({ err: errorShape(e), connectionId: connId }, 'logOut failed; falling back to close')
        await r.session.close().catch(() => {})
      }
      this.running.delete(connId)
    }

    for (const conn of active) {
      try {
        const existing = this.running.get(conn.id)
        if (existing) {
          if (!existing.backfilled) {
            // Same liveness reasoning as the backfilled branch below, but no
            // recordSync here: a backfill still in progress has nothing
            // durable to mark healthy yet, and a dead session caught by this
            // ping must not be handed to maybeStartBackfill.
            try {
              await existing.session.ping()
              this.maybeStartBackfill(conn.id, existing)
            } catch (e) {
              await this.handleSessionError(conn.id, e)
            }
          } else {
            // A phone-side revocation never throws on its own inside a running
            // session, so without an active probe recordSync would keep
            // advancing last_sync_at for a dead session forever. ping() BEFORE
            // recordSync, so a dead session is caught and revoked instead of
            // being recorded healthy.
            try {
              await existing.session.ping()
              await recordSync(conn.id)
            } catch (e) {
              await this.handleSessionError(conn.id, e)
            }
          }
          continue
        }

        const port = this.ports.get(conn.channel)
        if (!port) continue
        const sessionString = conn.sessionCiphertext && decryptSecret(conn.sessionCiphertext)
        if (!sessionString) continue // corrupt or missing — leave the row for the owner

        try {
          const session = await port.open(sessionString, { connectionId: conn.id })
          // Track the session BEFORE wiring handlers, so a throw during
          // registration still leaves an entry that handleSessionError and
          // stopAll can close — never an untracked, leaked session.
          const running: Running = {
            channel: conn.channel, session, backfilled: false, stopped: false,
            lastBackfillAttempt: 0, backfillSinceDays: backfillSinceDays(conn.lastSyncAt),
          }
          this.running.set(conn.id, running)
          this.wireHandlers(conn.id, conn.channel, session)
          this.maybeStartBackfill(conn.id, running)
        } catch (e) {
          await this.handleSessionError(conn.id, e)
        }
      } catch (e) {
        // One connection's failure must never starve the others in this pass.
        log.error({ err: errorShape(e), connectionId: conn.id }, 'connection failed this tick')
      }
    }
  }

  // Errors are logged, never swallowed: a message that fails to persist is
  // gone, and an archive that loses messages silently is worse than one that
  // is loudly behind. The catch keeps a rejected write from taking the whole
  // worker down with an unhandled rejection.
  private wireHandlers(connId: string, channel: Channel, session: ChannelSession): void {
    const onFail = (what: string) => (e: unknown) => log.error({ err: errorShape(e), connectionId: connId }, `${what} failed`)
    session.onMessage(m => { this.ingest(connId, channel, m).catch(onFail('recordMessage')) })
    session.onEdit(m => { applyEdit(connId, channel, m).catch(onFail('applyEdit')) })
    session.onDelete(ref => { applyDelete(connId, ref).catch(onFail('applyDelete')) })
  }

  // The one place a message becomes a row, so the media hook has exactly one
  // call site. enqueueMedia is a no-op until M4 replaces the module.
  private async ingest(connId: string, channel: Channel, m: IncomingMessage): Promise<void> {
    const res = await recordMessage(connId, channel, m)
    if (res.inserted && m.media) await enqueueMedia(res.messageId, connId, m.media)
  }

  // A heavy account can take tens of minutes. reconcileActive must never await
  // this: that would freeze pending-login claims, revocation response time,
  // and every other connection's liveness probe for the duration. Start it
  // once and move on; whenIdle()/stopAll() await it.
  private maybeStartBackfill(connId: string, running: Running): void {
    if (running.backfilled || running.stopped) return
    if (this.backfillsInFlight.has(connId)) return
    if (Date.now() - running.lastBackfillAttempt < BACKFILL_RETRY_BACKOFF_MS) return
    running.lastBackfillAttempt = Date.now()
    const p = this.runBackfill(connId, running)
      .finally(() => this.backfillsInFlight.delete(connId))
      // Terminal, for the same reason as the login chain above: nothing
      // downstream awaits this promise on the happy path (tick() deliberately
      // does not, and the worker loop never calls whenIdle()), so a rejection
      // from runBackfill's own error handling — handleSessionError awaiting a
      // revokeConnection write that throws, say — would escape as an unhandled
      // rejection and take the worker process down. It also keeps stopAll()'s
      // Promise.all from rejecting past the close() loop and leaking every
      // open session on the way out.
      .catch(e => log.error({ err: errorShape(e), connectionId: connId }, 'backfill driver failed'))
    this.backfillsInFlight.set(connId, p)
  }

  // Retried until it completes. Re-running it is harmless — ingest is
  // first-writer-wins — and the alternative is a permanent, invisible hole.
  private async runBackfill(connId: string, running: Running): Promise<void> {
    const shouldContinue = () => !running.stopped
    try {
      const opts = { sinceDays: running.backfillSinceDays, ...BACKFILL_CAPS }
      for await (const m of running.session.backfill(opts, shouldContinue)) {
        if (!shouldContinue()) return // aborted: do not mark backfilled, do not recordSync
        await this.ingest(connId, running.channel, m)
      }
      if (!shouldContinue()) return
      running.backfilled = true
      await recordSync(connId)
    } catch (e) {
      // A dead session (killed from the phone) does not throw on its own
      // elsewhere in the middle of a backfill — routing through
      // handleSessionError catches that here too and revokes instead of
      // retrying a session that is already gone; every other error is logged
      // and retried next tick.
      await this.handleSessionError(connId, e)
    }
  }

  private async handleSessionError(connId: string, e: unknown): Promise<void> {
    if (e instanceof ChannelError && e.kind === 'auth_invalidated') {
      // Killed from the phone. Not a logOut() path: the session is already
      // gone on the channel's side — that is exactly what this error means.
      await revokeConnection(connId, 'You revoked this session from your phone.')
      const r = this.running.get(connId)
      if (r) { r.stopped = true; await r.session.close().catch(() => {}); this.running.delete(connId) }
      return
    }
    log.error({ err: errorShape(e), connectionId: connId }, 'session error; will retry next tick')
  }

  // Awaits only in-flight BACKFILLS, never logins: a login can legitimately
  // block for the full login window waiting on a QR scan or a password, and
  // shutdown must not hang on that. Setting stopping first keeps tick() (and
  // startPendingLogins) from starting any new work while this drains.
  // whenIdle() stays the union of both — tests use it to wait out a login
  // deliberately.
  async stopAll(): Promise<void> {
    this.stopping = true
    // Abort in-flight backfills up front so awaiting them below returns
    // promptly instead of blocking shutdown on a slow scan.
    for (const [, r] of this.running) r.stopped = true
    await Promise.all([...this.backfillsInFlight.values()])
    for (const [, r] of this.running) await r.session.close().catch(() => {})
    this.running.clear()
  }
}
