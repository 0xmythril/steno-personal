import path from 'node:path'
import { rm, stat, writeFile } from 'node:fs/promises'
import {
  ChannelError,
  type BackfillOpts,
  type ChannelAccount,
  type ChannelErrorKind,
  type ChannelPort,
  type ChannelSession,
  type LoginDriver,
} from '@/lib/channels/port'
import type { IncomingMessage } from '@/lib/services/ingest'
import { errorShape, log } from '@/lib/log'
import {
  chatKindForJid,
  parseProtocolEvent,
  parseWaMessage,
  reviveRawMessage,
  toIncoming,
  tsToDate,
  type ParsedWaMessage,
  type WaChatKind,
} from '@/lib/channels/whatsapp-parse'

// THE ONLY MODULE IN THIS REPO THAT MAY NAME @whiskeysockets/baileys
// (spec invariant 2, enforced by tests/whatsapp-structure.test.ts).
//
// It reaches the library through the WaDeps seam below rather than calling it
// directly, for two reasons: Baileys 7.0.0-rc14 is ESM-only with native peers,
// so it must be loaded through a dynamic import(); and every test in this
// milestone runs against a fake socket, because nothing here may talk to
// WhatsApp.

// ---------------------------------------------------------------------------
// The seam. Every shape below was read from
// node_modules/@whiskeysockets/baileys@7.0.0-rc14 and is deliberately narrower
// than the real one: this port uses a handful of members of a socket that has
// well over a hundred.

type BaileysModule = typeof import('@whiskeysockets/baileys')
type MakeWASocketConfig = Parameters<BaileysModule['default']>[0]
type WAMessageLike = Parameters<BaileysModule['downloadMediaMessage']>[0]

export type WaVersion = [number, number, number]

/** lib/Types/State.d.ts — ConnectionState, partial per event. */
export type WaConnectionUpdate = {
  connection?: 'open' | 'connecting' | 'close'
  lastDisconnect?: { error?: unknown; date: Date }
  qr?: string
  isNewLogin?: boolean
}

/** lib/Types/Events.d.ts — 'messaging-history.set'; Chat = proto.IConversation. */
export type WaHistorySet = { chats?: Array<{ id?: string | null; name?: string | null }>; messages?: unknown[] }
/** lib/Types/Events.d.ts — 'messages.upsert'. */
export type WaUpsert = { messages?: unknown[]; type?: string }
/** lib/Types/GroupMetadata.d.ts, as delivered by 'groups.upsert' / 'groups.update'. */
export type WaGroup = { id?: string | null; subject?: string | null }

export type WaEventMap = {
  'connection.update': WaConnectionUpdate
  'creds.update': unknown
  'messaging-history.set': WaHistorySet
  'messages.upsert': WaUpsert
  'groups.upsert': WaGroup[]
  'groups.update': WaGroup[]
}

export interface WaSocket {
  ev: { on<K extends keyof WaEventMap>(event: K, cb: (arg: WaEventMap[K]) => void): void }
  user?: { id?: string; lid?: string; name?: string }
  /** lib/Socket/socket.js:572 — unlinks THIS companion device only. */
  logout(msg?: string): Promise<void>
  /** lib/Socket/socket.js:472 — emits one last close, then destroys the emitter. */
  end(error?: Error): Promise<void>
  /** lib/Socket/groups.d.ts:6 */
  groupMetadata(jid: string): Promise<{ id: string; subject?: string | null }>
  /** lib/Signal/lid-mapping.d.ts */
  signalRepository: { lidMapping: { getPNForLID(lid: string): Promise<string | null> } }
  /** lib/Socket/messages-recv.d.ts:39 — the reuploadRequest a media download needs. */
  updateMediaMessage(message: unknown): Promise<unknown>
}

export type WaAuth = { state: unknown; saveCreds: () => Promise<void> }
export type WaSocketOpts = { auth: unknown; version: WaVersion | undefined; syncFullHistory: boolean }

export type WaDeps = {
  useAuthState(dir: string): Promise<WaAuth>
  fetchVersion(): Promise<WaVersion | undefined>
  makeSocket(opts: WaSocketOpts): Promise<WaSocket>
  downloadMedia(message: unknown, ctx: { reuploadRequest: (m: unknown) => Promise<unknown> }): Promise<Buffer>
}

let baileysModule: Promise<BaileysModule> | null = null

// package.json of baileys 7.0.0-rc14: "type": "module", main lib/index.js, no
// exports map. A static import would force the whole worker into ESM-only
// resolution and would drag libsignal + protobufjs + two native addons into
// every unit test. One cached dynamic import instead.
function loadBaileys(): Promise<BaileysModule> {
  return (baileysModule ??= import('@whiskeysockets/baileys'))
}

// Baileys logs at 'info' and is extremely chatty. 'warn' keeps that off our
// stdout while still surfacing real problems. Its ILogger
// (lib/Utils/logger.d.ts) is structurally satisfied by pino.
function waLogger(): unknown {
  return log.child({ mod: 'baileys' }, { level: 'warn' })
}

export function baileysDeps(): WaDeps {
  return {
    async useAuthState(dir) {
      // lib/Utils/use-multi-file-auth-state.d.ts — creates the folder itself
      // and only ever reads files it named, so our marker file is safe there.
      const { useMultiFileAuthState } = await loadBaileys()
      const { state, saveCreds } = await useMultiFileAuthState(dir)
      return { state, saveCreds }
    },
    async fetchVersion() {
      // lib/Utils/generics.js:179 — never throws; on a network failure it
      // returns the version bundled with the library.
      const { fetchLatestBaileysVersion } = await loadBaileys()
      const { version } = await fetchLatestBaileysVersion()
      return version
    },
    async makeSocket(opts) {
      const { default: makeWASocket } = await loadBaileys()
      const sock = makeWASocket({
        auth: opts.auth as MakeWASocketConfig['auth'],
        ...(opts.version ? { version: opts.version } : {}),
        // Spec invariant 3. Baileys turns this into a presence update
        // ('unavailable', lib/Socket/chats.js:1065) on connect — which is why
        // this file never touches presence itself.
        markOnlineOnConnect: false,
        // The owner's own messages must archive too, with fromOwner = true.
        emitOwnEvents: true,
        // lib/Utils/validate-connection.js: this sets requireFullSync inside
        // generateRegistrationNode (line 86) — pairing only — AND
        // webInfo.webSubPlatform on every connect (line 35), but only in
        // combination with the desktop browser tuple below. Without both,
        // WhatsApp sends recent history and nothing more.
        syncFullHistory: opts.syncFullHistory,
        browser: ['Mac OS', 'Desktop', '14.4.1'],
        logger: waLogger() as MakeWASocketConfig['logger'],
      })
      return sock as unknown as WaSocket
    },
    async downloadMedia(message, ctx) {
      // lib/Utils/messages.d.ts:87 — unwraps ephemeral/viewOnce itself, and
      // uses reuploadRequest when WhatsApp's media URL has expired.
      const { downloadMediaMessage } = await loadBaileys()
      return await downloadMediaMessage(
        message as WAMessageLike,
        'buffer',
        {},
        {
          reuploadRequest: ctx.reuploadRequest as (m: WAMessageLike) => Promise<WAMessageLike>,
          // DownloadMediaMessageContext.logger is a required ILogger, while
          // the socket config's is optional (UserFacingSocketConfig is a
          // Partial), hence the NonNullable here but not above.
          logger: waLogger() as NonNullable<MakeWASocketConfig['logger']>,
        },
      )
    },
  }
}

// ---------------------------------------------------------------------------
// Constants

const SESSION_PREFIX = 'wa-'
const SESSION_RE = /^wa-[A-Za-z0-9._-]+$/
// Written inside the auth dir once the initial history has been ingested.
// useMultiFileAuthState only ever reads files it named (creds.json,
// <type>-<id>.json), so an extra file here is inert.
const HISTORY_MARKER = 'history-synced'
const DEFAULT_OPEN_TIMEOUT_MS = 60_000
const DEFAULT_RECONNECT_MIN_MS = 1_000
const DEFAULT_RECONNECT_MAX_MS = 60_000
const DEFAULT_STALE_MS = 10 * 60_000

// lib/Types/index.d.ts:26 (baileys 7.0.0-rc14). Copied rather than imported so
// the values are available without loading the ESM module.
const LOGGED_OUT = 401
const RESTART_REQUIRED = 515

export function sessionStringFor(connectionId: string): string {
  return `${SESSION_PREFIX}${connectionId}`
}

// Baileys wraps every close error in a Boom; a plain Error has no status.
function closeStatus(err: unknown): number | undefined {
  const e = err as { output?: { statusCode?: unknown }; statusCode?: unknown } | null | undefined
  const raw = e?.output?.statusCode ?? e?.statusCode
  return typeof raw === 'number' ? raw : undefined
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// tsconfig has both "dom" and @types/node in scope, so setTimeout's return
// type is not reliably NodeJS.Timeout. Every timer here is bookkeeping, never
// a reason to hold the process open.
type Timer = ReturnType<typeof setTimeout>
function unref(timer: Timer): void {
  ;(timer as unknown as { unref?: () => void }).unref?.()
}

async function exists(file: string): Promise<boolean> {
  return await stat(file).then(() => true, () => false)
}

// ---------------------------------------------------------------------------

export type BaileysWhatsAppPortOptions = {
  /** DATA_DIR/whatsapp */
  authRoot: string
  deps?: WaDeps
  openTimeoutMs?: number
  reconnectMinMs?: number
  reconnectMaxMs?: number
  staleMs?: number
}

export class BaileysWhatsAppPort implements ChannelPort {
  readonly channel = 'whatsapp' as const

  private readonly authRoot: string
  private readonly deps: WaDeps
  private readonly openTimeoutMs: number
  private readonly reconnectMinMs: number
  private readonly reconnectMaxMs: number
  private readonly staleMs: number

  constructor(opts: BaileysWhatsAppPortOptions) {
    this.authRoot = opts.authRoot
    this.deps = opts.deps ?? baileysDeps()
    this.openTimeoutMs = opts.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS
    this.reconnectMinMs = opts.reconnectMinMs ?? DEFAULT_RECONNECT_MIN_MS
    this.reconnectMaxMs = opts.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS
    this.staleMs = opts.staleMs ?? DEFAULT_STALE_MS
  }

  // The session string comes back out of an AES-GCM column; it still gets
  // checked before it becomes a path.
  private authDir(sessionString: string): string {
    if (!SESSION_RE.test(sessionString)) throw new ChannelError('invalid whatsapp session string', 'other')
    return path.join(this.authRoot, sessionString)
  }

  async login(driver: LoginDriver, opts: { timeoutMs: number; connectionId: string }): Promise<{ sessionString: string; account: ChannelAccount }> {
    const sessionString = sessionStringFor(opts.connectionId)
    const dir = this.authDir(sessionString)
    // A login always starts from nothing: a half-paired directory left by an
    // abandoned attempt makes Baileys reconnect as a dead device instead of
    // showing a QR.
    await rm(dir, { recursive: true, force: true })

    const { state, saveCreds } = await this.deps.useAuthState(dir)
    const version = await this.deps.fetchVersion()
    const deps = this.deps

    return await new Promise<{ sessionString: string; account: ChannelAccount }>((resolve, reject) => {
      const held: { sock: WaSocket | null } = { sock: null }
      let settled = false
      let restarted = false

      const timer = setTimeout(() => fail('whatsapp pairing timed out', 'timed_out'), opts.timeoutMs)
      unref(timer)

      function settle(): boolean {
        if (settled) return false
        settled = true
        clearTimeout(timer)
        return true
      }

      function fail(message: string, kind: ChannelErrorKind): void {
        if (!settle()) return
        void held.sock?.end(undefined).catch(() => {})
        reject(new ChannelError(message, kind))
      }

      function succeed(sock: WaSocket, id: string): void {
        if (!settle()) return
        void (async () => {
          // pair-success emits creds.update just before open; make sure it is
          // on disk before the socket goes away.
          try { await saveCreds() } catch (err) { log.error({ err: errorShape(err) }, 'whatsapp creds save failed') }
          // The SessionManager owns the live socket. login hands back a
          // session string and closes its own.
          await sock.end(undefined).catch(() => {})
          resolve({
            sessionString,
            account: { channel: 'whatsapp', externalAccountId: id, displayName: sock.user?.name ?? null },
          })
        })()
      }

      async function connect(): Promise<void> {
        const sock = await deps.makeSocket({ auth: state, version, syncFullHistory: true })
        held.sock = sock

        sock.ev.on('creds.update', () => {
          void saveCreds().catch(err => log.error({ err: errorShape(err) }, 'whatsapp creds save failed'))
        })

        sock.ev.on('connection.update', update => {
          if (update.qr) {
            // The portal renders it; a QR is a short-lived pairing token, not
            // an identifier, but it is still never logged.
            void driver.publishQr(update.qr).catch(err => log.error({ err: errorShape(err) }, 'whatsapp qr publish failed'))
          }
          if (update.connection === 'open') {
            const id = sock.user?.id
            if (!id) { fail('whatsapp connected without an account id', 'other'); return }
            succeed(sock, id)
            return
          }
          if (update.connection === 'close') {
            const code = closeStatus(update.lastDisconnect?.error)
            if (code === RESTART_REQUIRED && !restarted) {
              // Baileys pairs and then asks for the socket to be rebuilt
              // (lib/Socket/socket.js, CB:iq,,pair-success -> 515). Exactly one
              // reopen; a second 515 is a loop, not a handshake.
              restarted = true
              log.info('whatsapp pairing needs one restart; reopening')
              connect().catch(err => fail(`whatsapp reopen failed: ${errText(err)}`, 'other'))
              return
            }
            if (code === LOGGED_OUT) { fail('whatsapp rejected the pairing', 'auth_invalidated'); return }
            fail(`whatsapp closed during pairing (${code ?? 'no status'})`, 'other')
          }
        })
      }

      // driver.requestPassword / getPassword / passwordRejected exist for
      // Telegram's 2FA step and are never called here.
      connect().catch(err => fail(`whatsapp login failed: ${errText(err)}`, 'other'))
    })
  }

  async open(sessionString: string, _opts: { connectionId: string }): Promise<ChannelSession> {
    this.authDir(sessionString)
    throw new ChannelError('not implemented yet', 'other') // TODO(Task 3)
  }
}
