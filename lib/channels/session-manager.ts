import { decryptSecret } from '@/lib/services/crypto'
import { log, errorShape } from '@/lib/log'
import {
  claimPendingLogins, activeConnections, publishQr, requestPassword,
  takeLoginSecret, recordPasswordRejected, completeLogin, failLogin, recordSync,
} from '@/lib/services/login'
import { removeWhatsappAuthDirs, revokedWhatsappConnectionIds, revokeConnection } from '@/lib/services/connections'
import { completeRecovery } from '@/lib/services/recovery'
import { recordMessage, applyEdit, applyDelete } from '@/lib/services/ingest'
import { syncContacts } from '@/lib/services/people'
import { enqueueMedia, type Downloader } from '@/lib/services/media'
import {
  ChannelError,
  type Channel, type ChannelContact, type ChannelPort, type ChannelSession, type IncomingMessage,
} from '@/lib/channels/port'

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
// The liveness probe is a real account.updateStatus RPC plus a real UPDATE.
// At the worker's 3 s tick that is ~28,800 of each per connection per day,
// forever, for a probe whose only job is to notice a phone-side revocation —
// and Telegram rate-limits that call, so a real account would earn a
// FLOOD_WAIT (classified 'other', hence retried next tick: log spam every 3 s
// and a frozen last_sync_at). Once a minute is ample: a revoke surfacing in a
// minute instead of three seconds is not a product regression.
const PING_EVERY_MS = 60_000
// The address book only drifts at human speed: a contact is renamed, or a new
// number is saved on the phone, a handful of times a week. Reading it is a
// real RPC against the same rate limits the liveness probe lives under, so it
// runs once after the backfill lands (when the archive is at its emptiest and
// the names matter most) and four times a day after that. Nothing downstream
// is time-critical: a person linked from a contact saved an hour ago is still
// linked correctly an hour later.
const CONTACTS_SYNC_MS = 6 * 3_600_000
// WhatsApp pushes its contact list (and everyone's push names) over the first
// minutes after a session opens, well after the post-backfill sync has run.
// For the first hour a session re-reads every five minutes so those names
// reach the cache while the reader is still looking, then settles to six hours.
const CONTACTS_WARMUP_WINDOW_MS = 3_600_000
const CONTACTS_WARMUP_MS = 5 * 60_000
// What a FAILED read waits instead. Six hours is the cadence for an address
// book that is already cached; a read that never landed has nothing cached at
// all, and the People page stays full of bare ids until one does. Ten minutes
// is long enough to ride out a FLOOD_WAIT and short enough that a first
// pairing is not spent looking at numbers.
const CONTACTS_RETRY_MS = 10 * 60_000
// The contact read is the one call in this file with no binding-level bound of
// its own guaranteed: mtcute caps its RPC and WhatsApp answers from a map, but
// stopAll() awaits contactSyncsInFlight, so a future binding that hangs here
// would wedge shutdown. Same treatment as logOut().
const CONTACTS_TIMEOUT_MS = 30_000

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
  lastPingAt: number          // epoch ms; 0 means never probed, so the first tick probes
  // epoch ms, stamped BEFORE the read rather than after it, so a contact sync
  // that fails (or hangs and loses a race with the next tick) waits out the
  // window like every other throttled call here instead of re-firing — and
  // re-logging — once a minute. 0 means never synced, but the post-backfill
  // sync below always gets there first.
  lastContactsSyncAt: number
  // When the next read is due: five minutes on during the warm-up hour, six
  // hours after that, ten minutes after a failure. A tick that arrives late
  // fires the overdue read then and there.
  nextContactsSyncAt: number
  openedAt: number            // for the contact-sync warm-up window
  backfillSinceDays: number   // fixed at open time; retries reuse it
  // Consecutive 'other' failures of the THROTTLED (backfilled-branch, once a
  // minute) liveness probe only. Reset by any successful ping on that branch;
  // at MAX_CONSECUTIVE_OTHER the session is recycled. The unthrottled
  // pre-backfill ping below never touches this counter — see the comment on
  // that branch. See handleSessionError.
  consecutiveOther: number
}

// The other half of stamping lastContactsSyncAt before the read: that stamp is
// what a FAILED read would otherwise ride for the full six hours. Winding it
// back leaves exactly CONTACTS_RETRY_MS on the clock — a retry, not a re-fire,
// so the single-flight guard and the "log once, not once a tick" property both
// survive.
function retrySoon(running: Running): void {
  running.nextContactsSyncAt = Date.now() + CONTACTS_RETRY_MS
}

function contactsInterval(running: Running): number {
  return Date.now() - running.openedAt < CONTACTS_WARMUP_WINDOW_MS ? CONTACTS_WARMUP_MS : CONTACTS_SYNC_MS
}

// A session whose ping keeps failing with 'other' is not dead (that would be
// auth_invalidated) and not healthy either: the WhatsApp port raises it after
// a full stale window, i.e. a reconnect loop that never reaches 'open'. Left
// alone it logs once a minute forever while the archive stops. Three in a row
// — three minutes past the port's own 10-minute window — is a session worth
// throwing away and rebuilding from the connection row.
const MAX_CONSECUTIVE_OTHER = 3

// One SessionManager per worker. tick() is idempotent, self-serializing (a
// tick already in flight makes a concurrent call a no-op — never queued), and
// safe on an interval: it converges the set of open channel sessions to the
// set of active rows.
export class SessionManager {
  private running = new Map<string, Running>()            // connectionId -> open session
  private loginsInFlight = new Map<string, Promise<void>>()
  private backfillsInFlight = new Map<string, Promise<void>>()
  // Single-flight per connection, for the same reason backfills are: the
  // post-backfill sync and the six-hourly one can both come due at once, and
  // two concurrent syncContacts() for the same connection would race each
  // other's upserts for no benefit.
  private contactSyncsInFlight = new Map<string, Promise<void>>()
  private ticking = false
  private stopping = false
  // Revoked WhatsApp rows whose auth directory this process has already tried
  // to remove. rm is idempotent, so the memo is not for correctness — it keeps
  // a permanently unremovable directory from re-logging its failure every 3 s.
  private sweptWhatsappAuth = new Set<string>()

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
      // AFTER reconcileActive, so a connection revoked since the last tick has
      // had its session closed (and, where the channel answered, logged out)
      // before its signal keys go.
      await this.sweepRevokedWhatsappAuth()
    } finally {
      this.ticking = false
    }
  }

  // Awaits in-flight logins, backfills and contact syncs. Used by tests for
  // determinism and by stopAll for a clean shutdown.
  async whenIdle(): Promise<void> {
    await Promise.all([
      ...this.loginsInFlight.values(),
      ...this.backfillsInFlight.values(),
      ...this.contactSyncsInFlight.values(),
    ])
  }

  // The ONE addition M4 makes to the M1 interface. The media drain needs a way
  // to download bytes for a connection, and only the manager knows which
  // sessions are open right now. Returning a bound function rather than the
  // session keeps the drain from reaching the rest of ChannelSession, and
  // returning a fresh Map keeps a caller from mutating the manager's own.
  //
  // A session already being torn down is excluded: downloading through it
  // would race the close, and the row stays pending for the next pass.
  downloaders(): Map<string, Downloader> {
    const out = new Map<string, Downloader>()
    for (const [connectionId, running] of this.running) {
      if (running.stopped) continue
      out.set(connectionId, raw => running.session.downloadMedia(raw))
    }
    return out
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
      const p = this.driveLogin(port, conn, LOGIN_TIMEOUT_MS - age)
        .finally(() => this.loginsInFlight.delete(conn.id))
        // Terminal: driveLogin is fire-and-forget, so nothing downstream
        // awaits it directly. Without this, a failing write inside it (e.g.
        // failLogin's own DB update throwing) would escape as an unhandled
        // rejection instead of just being logged.
        .catch(e => log.error({ err: errorShape(e), connectionId: conn.id }, 'login driver failed'))
      this.loginsInFlight.set(conn.id, p)
    }
  }

  // The handshake is the same for both purposes; what happens to its result is
  // not. An archive login becomes an active connection the next tick opens. A
  // RECOVERY login only proves which account was paired: completeRecovery
  // records the verdict (and mints a key on a match), and the device that was
  // just linked is logged out again right here — the session string never
  // reaches the database.
  private async driveLogin(port: ChannelPort, conn: { id: string; purpose: 'archive' | 'recovery' }, timeoutMs: number): Promise<void> {
    const connId = conn.id
    const driver = {
      publishQr: (url: string) => publishQr(connId, url),
      requestPassword: () => requestPassword(connId),
      getPassword: () => takeLoginSecret(connId),
      passwordRejected: () => recordPasswordRejected(connId),
    }
    try {
      const { sessionString, account } = await port.login(driver, { timeoutMs, connectionId: connId })
      if (conn.purpose === 'recovery') {
        const outcome = await completeRecovery(connId, account)
        log.info({ connectionId: connId, outcome }, 'recovery pairing finished')
        await this.logOutRecoveryDevice(port, connId, sessionString)
        return
      }
      const res = await completeLogin(connId, sessionString, account)
      if (res === 'duplicate') await failLogin(connId, 'That account is already connected.')
      // 'gone' = revoked or deleted mid-login. The write was refused on
      // purpose, and there is nothing left on that row to tell anyone.
    } catch (e) {
      const kind = e instanceof ChannelError ? e.kind : 'other'
      const message = kind === 'timed_out' ? 'Login timed out — please try again.'
        : kind === 'auth_invalidated' ? 'Login was rejected. Please try again.'
        : 'Login failed — please try again.'
      // The row only ever gets one of those three sentences, which is all the
      // owner needs and nothing an operator can debug from. Without this line
      // a login that fails identically every time is invisible in the logs.
      // The error only — never the driver payload, never a QR.
      log.warn({ err: errorShape(e), connectionId: connId, kind }, 'login failed')
      await failLogin(connId, message)
    }
  }

  // A recovery pairing linked a device to the owner's account for the sole
  // purpose of reading its account id; it must not stay linked. Bounded like
  // every other logOut, with close() as the fallback, and never thrown: the
  // verdict is already recorded, and the revoked-row sweep removes WhatsApp's
  // auth files either way.
  private async logOutRecoveryDevice(port: ChannelPort, connId: string, sessionString: string): Promise<void> {
    let session: ChannelSession | null = null
    try {
      session = await port.open(sessionString, { connectionId: connId })
      await withTimeout(session.logOut(), LOGOUT_TIMEOUT_MS, 'logOut')
    } catch (e) {
      log.error({ err: errorShape(e), connectionId: connId }, 'recovery device logOut failed; falling back to close')
    } finally {
      await session?.close().catch(() => {})
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
            //
            // Unlike the backfilled branch, this ping is NOT throttled — it
            // fires every tick (every 3 s) for as long as backfill has not
            // finished. A FLOOD_WAIT here (classified 'other', same as the
            // WhatsApp stale-reconnect case) is an expected side effect of a
            // long backfill hammering the same account, not evidence the
            // session is wedged, and three of them are three ticks — nine
            // seconds — not three minutes. So this call must NEVER count
            // toward consecutiveOther: no fromPing flag, meaning 'other' just
            // logs and retries next tick while backfill's own retry/backoff
            // in runBackfill keeps making progress. auth_invalidated still
            // revokes either way, via handleSessionError below.
            try {
              await existing.session.ping()
              existing.consecutiveOther = 0
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
            //
            // Throttled to PING_EVERY_MS, decoupling the probe cadence from
            // the tick cadence. lastPingAt is stamped BEFORE the await, so a
            // probe that fails (FLOOD_WAIT, a transient fault) also waits out
            // the window instead of re-firing — and re-logging — every tick.
            // This throttling is exactly why THIS is the only ping call site
            // allowed to pass fromPing: true below — three consecutive
            // failures here really are three minutes of a wedged session, not
            // three seconds of an unthrottled loop tripping over itself.
            if (Date.now() - existing.lastPingAt >= PING_EVERY_MS) {
              existing.lastPingAt = Date.now()
              try {
                await existing.session.ping()
                existing.consecutiveOther = 0
                await recordSync(conn.id)
                // Only after a probe that just proved the session live, and
                // only on its own much longer clock. Started, never awaited:
                // a contact list is a whole-address-book RPC, and the tick
                // loop — which every other connection's liveness and every
                // revocation waits behind — must not hold for it.
                this.maybeSyncContacts(conn.id, existing)
              } catch (e) {
                await this.handleSessionError(conn.id, e, { fromPing: true })
              }
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
            lastBackfillAttempt: 0, lastPingAt: 0, lastContactsSyncAt: 0, nextContactsSyncAt: 0, openedAt: Date.now(),
            backfillSinceDays: backfillSinceDays(conn.lastSyncAt),
            consecutiveOther: 0,
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

  // revokeConnection nulls the database credential, but WhatsApp's real
  // credential is the Baileys multi-file auth state on the volume, and nothing
  // in the portal can touch it: a Disconnect is a database write, and the
  // owner may well have performed it with the worker down. So the worker owns
  // the removal — for a session it has just closed above, and for any revoked
  // row whose directory outlived a worker that was not running at the time.
  // Never throws: the whole point is that a stubborn directory cannot stop the
  // tick loop.
  private async sweepRevokedWhatsappAuth(): Promise<void> {
    try {
      for (const id of await revokedWhatsappConnectionIds()) {
        if (this.sweptWhatsappAuth.has(id)) continue
        this.sweptWhatsappAuth.add(id)
        // sessionCiphertext is already null on a revoked row; the directory
        // name is derived from the connection id.
        await removeWhatsappAuthDirs(id, null)
      }
    } catch (e) {
      log.error({ err: errorShape(e) }, 'revoked WhatsApp auth sweep failed')
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
  // call site. enqueueMedia queues the attachment for the download drain; it
  // is idempotent by message, so a history replay never queues one twice.
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
      return
    }
    // The archive has just filled with chats and senders; the address book is
    // what turns those ids into a person, so read it now rather than making
    // the owner wait out the first six-hour window. AWAITED here (unlike the
    // tick's own call) purely so it rides this backfill promise: whenIdle()
    // and stopAll() already await that, and a sync started after the promise
    // resolved would be outside both. It never rejects.
    await this.syncContactsNow(connId, running)
  }

  // Started, not awaited. Never rejects — syncContactsNow swallows everything
  // and the terminal catch covers the write handleSessionError may attempt —
  // so a caller inside the tick loop can drop the promise safely.
  private maybeSyncContacts(connId: string, running: Running): void {
    if (running.stopped) return
    if (Date.now() < running.nextContactsSyncAt) return
    void this.syncContactsNow(connId, running)
  }

  // Reads the channel's own address book into the contact cache. Deliberately
  // gentler than every other failure path here: a contact list that will not
  // load is a missing convenience, not a broken archive, so a failure is
  // logged and left for the next window — it never counts toward
  // consecutiveOther (that counter is for the throttled liveness probe alone,
  // and a session whose messages keep arriving is not wedged because
  // getContacts() drew a FLOOD_WAIT), and it never stops the session. The one
  // exception is auth_invalidated: that is not "contacts are unavailable", it
  // is the session being gone, and a dead session is dead whichever call
  // notices.
  //
  // errorShape only, and no contact ever reaches the log: this function
  // handles every name and phone number the instance holds.
  private async syncContactsNow(connId: string, running: Running): Promise<void> {
    const inFlight = this.contactSyncsInFlight.get(connId)
    if (inFlight) return inFlight
    running.lastContactsSyncAt = Date.now()
    running.nextContactsSyncAt = Date.now() + contactsInterval(running)
    const p = this.runContactSync(connId, running)
      .finally(() => this.contactSyncsInFlight.delete(connId))
      // Terminal, as on the login and backfill chains: runContactSync's own
      // catch can still reach handleSessionError, whose revoke write may
      // throw, and nothing downstream is guaranteed to await this promise.
      .catch(e => log.error({ err: errorShape(e), connectionId: connId }, 'contact sync driver failed'))
    this.contactSyncsInFlight.set(connId, p)
    return p
  }

  private async runContactSync(connId: string, running: Running): Promise<void> {
    if (running.stopped) return
    let contacts: ChannelContact[]
    try {
      contacts = await withTimeout(running.session.listContacts(), CONTACTS_TIMEOUT_MS, 'listContacts')
    } catch (e) {
      if (e instanceof ChannelError && e.kind === 'auth_invalidated') {
        await this.handleSessionError(connId, e)
        return
      }
      log.warn({ err: errorShape(e), connectionId: connId }, 'contact sync failed')
      retrySoon(running)
      return
    }
    // Re-checked after the read: the connection may have been revoked while
    // that RPC was in flight, and writing a torn-down connection's contacts
    // races the cascade that is deleting them.
    if (running.stopped) return
    try {
      const { upserted } = await syncContacts(connId, running.channel, contacts)
      // A count, never a contact.
      log.info({ connectionId: connId, upserted }, 'contacts synced')
    } catch (e) {
      log.error({ err: errorShape(e), connectionId: connId }, 'contact sync write failed')
      retrySoon(running)
    }
  }

  private async handleSessionError(connId: string, e: unknown, opts: { fromPing?: boolean } = {}): Promise<void> {
    if (e instanceof ChannelError && e.kind === 'auth_invalidated') {
      // Killed from the phone. Not a logOut() path: the session is already
      // gone on the channel's side — that is exactly what this error means.
      await revokeConnection(connId, 'You revoked this session from your phone.')
      const r = this.running.get(connId)
      if (r) { r.stopped = true; await r.session.close().catch(() => {}); this.running.delete(connId) }
      return
    }
    // Not fatal, so the row is left alone — the connection is still active and
    // still the owner's. But the THROTTLED LIVENESS PROBE (once a minute, on
    // the backfilled branch) failing this way three times running is a wedged
    // session (for WhatsApp: a reconnect loop that never reaches 'open',
    // raised after the port's own 10-minute stale window), and "retry next
    // tick" retries nothing — it re-pings the same wedged session forever
    // while the archive stops. Throw it away instead; the next tick
    // re-open()s it from the connection row, which is the only recovery
    // available from here. No last_error write: the connection has not failed,
    // and nothing outside revokeConnection may write that column's sentinels.
    //
    // Counted ONLY for that throttled ping — callers pass fromPing: true from
    // exactly that one call site. The unthrottled pre-backfill ping (every 3 s
    // tick, for as long as backfill has not finished) never passes it: an
    // account mid-backfill drawing rate-limit errors there is expected load,
    // not a wedged session, and at the tick cadence three of them is nine
    // seconds, not three minutes. A failing backfill itself also never counts
    // here — it has its own retry backoff and is not evidence the session is
    // unusable.
    const kind = e instanceof ChannelError ? e.kind : 'other'
    const r = this.running.get(connId)
    if (opts.fromPing && kind === 'other' && r && ++r.consecutiveOther >= MAX_CONSECUTIVE_OTHER) {
      r.stopped = true
      await r.session.close().catch(() => {})
      this.running.delete(connId)
      log.warn({ connectionId: connId, consecutiveOther: r.consecutiveOther }, 'session recycled')
      return
    }
    log.error({ err: errorShape(e), connectionId: connId }, 'session error; will retry next tick')
  }

  // Awaits only in-flight BACKFILLS and contact syncs, never logins: a login can legitimately
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
    await Promise.all([...this.backfillsInFlight.values(), ...this.contactSyncsInFlight.values()])
    for (const [, r] of this.running) await r.session.close().catch(() => {})
    this.running.clear()
  }
}
