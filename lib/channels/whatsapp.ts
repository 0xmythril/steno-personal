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

// Compile-time seam check, erased by tsc. WaSocket above is hand-written from
// a reading of the library, and nothing at runtime ever compares it to the
// real thing: the fake socket in the tests satisfies OUR interface, so a
// Baileys upgrade that renames or re-signs a member this port calls would
// sail through the whole suite and fail in production. These aliases turn that
// into a `tsc --noEmit` failure. Types only — `BaileysModule` is a type-only
// import, so the single dynamic import() below stays the only way the library
// is loaded.
type RealWaSocket = ReturnType<BaileysModule['default']>
/** Refuses to instantiate unless Theirs is assignable to Ours. */
type Satisfies<Ours, Theirs extends Ours> = Theirs

export type WaSocketSeamCheck = {
  end: Satisfies<WaSocket['end'], RealWaSocket['end']>
  logout: Satisfies<WaSocket['logout'], RealWaSocket['logout']>
  groupMetadata: Satisfies<WaSocket['groupMetadata'], RealWaSocket['groupMetadata']>
  updateMediaMessage: Satisfies<WaSocket['updateMediaMessage'], RealWaSocket['updateMediaMessage']>
  getPNForLID: Satisfies<
    WaSocket['signalRepository']['lidMapping']['getPNForLID'],
    RealWaSocket['signalRepository']['lidMapping']['getPNForLID']
  >
  user: Satisfies<WaSocket['user'], RealWaSocket['user']>
  // Not a WaSocket member — this port never touches the raw WebSocket. Named
  // anyway because a Baileys that no longer exposes `ws` has restructured the
  // socket far enough that every line above deserves a fresh read.
  ws: RealWaSocket['ws']
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

// Baileys' ILogger, lib/Utils/logger.d.ts. Named here so the wrapper below is
// checked against the real shape instead of being cast into place.
type WaILogger = NonNullable<MakeWASocketConfig['logger']>

// Pull an error out of a Baileys log bag, and nothing else.
function errFrom(obj: unknown): ReturnType<typeof errorShape> | null {
  if (!obj || typeof obj !== 'object') return null
  const bag = obj as { err?: unknown; error?: unknown }
  const raw = bag.err ?? bag.error
  return raw === undefined || raw === null ? null : errorShape(raw)
}

// Spec invariant 6. Handing Baileys our pino logger would hand it the right to
// log its own bound objects, and those carry exactly what may never be
// written: phone numbers ('pn'), JIDs ('jid', 'fromJid', 'participant') and
// raw binary nodes ('node', 'fullErrorNode', 'reasonNode'), at warn and error
// level. So the library never gets a real logger — it gets this, which
// forwards the level, the message string, and at most one errorShape()'d
// error. Bindings passed to child() are dropped for the same reason.
//
// Baileys is also extremely chatty below warn, so trace/debug/info are no-ops:
// that is the 'warn' effective level, enforced here rather than by a level
// string the library is free to read and ignore.
class RedactingWaLogger implements WaILogger {
  readonly level = 'warn'
  private readonly sink = log.child({ mod: 'baileys' })

  child(): RedactingWaLogger {
    return this
  }

  trace(): void {}
  debug(): void {}
  info(): void {}

  warn(obj?: unknown, msg?: string): void {
    this.emit('warn', obj, msg)
  }

  error(obj?: unknown, msg?: string): void {
    this.emit('error', obj, msg)
  }

  // Baileys calls both pino shapes: (msg) and (bindings, msg).
  private emit(level: 'warn' | 'error', obj?: unknown, msg?: string): void {
    const message = typeof obj === 'string' ? obj : (msg ?? '')
    const err = errFrom(obj)
    if (err) this.sink[level]({ err }, message)
    else this.sink[level](message)
  }
}

export function waLogger(): WaILogger {
  return new RedactingWaLogger()
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
        // webInfo.webSubPlatform on every connect (line 35).
        //
        // No `browser` tuple. As of 2026-09 WhatsApp terminates a
        // DARWIN-platform socket — close code 428, "Connection Terminated",
        // before any QR is ever emitted — and the Mac OS desktop tuple this
        // file used to pass registers as exactly that. Omitting the option
        // leaves Baileys' default (macOS Chrome), which does pair; history
        // depth with the default tuple is verified by the owner run.
        syncFullHistory: opts.syncFullHistory,
        logger: waLogger(),
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
          logger: waLogger(),
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
const FORBIDDEN = 403
const CONNECTION_REPLACED = 440
const RESTART_REQUIRED = 515

// Three ways for WhatsApp to say "this device is finished": unlinked from the
// phone (401), refused outright (403), and replaced by another session on the
// same credentials (440). None of them heals by waiting, so a reconnect loop
// against any of them is a loop that hammers WhatsApp until the number is
// flagged. The session goes dead instead and the manager is told through
// ping().
const TERMINAL_CLOSE_CODES: ReadonlySet<number> = new Set([LOGGED_OUT, FORBIDDEN, CONNECTION_REPLACED])

// A drained event chain means nothing writes after close() resolves. Bounded,
// because shutdown may not hang on a batch that is stuck.
const CHAIN_DRAIN_MS = 5_000

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

// getPNForLID answers with the DEVICE it resolved — `15551234567:0@s.whatsapp.net`
// (lib/Signal/lid-mapping.js builds `${pnUser}@s.whatsapp.net` from a decoded
// user that carries its device). A chat and a sender are identified by the
// bare user JID, so the `:device` segment comes off before the value is used
// or cached; keeping it would file the same human under one id per device.
function stripDevice(jid: string): string {
  return jid.replace(/:\d+(?=@)/, '')
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
        // The timeout can fire while this await is in flight. A socket built
        // after we have already settled belongs to nobody, so close it here
        // rather than leaving it open on a promise that will never resolve.
        if (settled) {
          void sock.end(undefined).catch(() => {})
          return
        }
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
              log.debug('whatsapp pairing needs one restart; reopening')
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
    const dir = this.authDir(sessionString)
    const deps = this.deps
    const { state, saveCreds } = await deps.useAuthState(dir)
    const version = await deps.fetchVersion()

    const markerPath = path.join(dir, HISTORY_MARKER)
    // "First open" per spec 4.3: the auth dir has no history-synced marker.
    // The marker is written once a history batch has actually been ingested,
    // not merely once we connected, so a crash mid-sync retries next time.
    let historyPending = !(await exists(markerPath))

    let sock: WaSocket | null = null
    let connected = false
    let closing = false
    // Dead = WhatsApp will not have this device back (see TERMINAL_CLOSE_CODES)
    // or we unlinked it ourselves. Never reconnect, and tell ping().
    let dead = false
    let deadCode: number | null = null
    // Two different clocks. lastEventAt is "we heard something at all"; it is
    // deliberately NOT bumped by a close, because a socket that closes every
    // second is the very thing staleness has to catch. lastConnectedAt is the
    // last time the socket was actually OPEN, and it is the only input to the
    // staleness verdict below.
    let lastEventAt = Date.now()
    let lastConnectedAt = Date.now()
    let backoff = this.reconnectMinMs
    let retryTimer: Timer | null = null
    let openTimer: Timer | null = null
    const reconnectMaxMs = this.reconnectMaxMs
    const reconnectMinMs = this.reconnectMinMs
    const staleMs = this.staleMs

    let onMessageCb: ((m: IncomingMessage) => void) | null = null
    let onEditCb: ((m: IncomingMessage) => void) | null = null
    let onDeleteCb: ((ref: { externalChatId?: string; externalMessageId: string }) => void) | null = null
    // The SessionManager registers its callbacks immediately after open()
    // resolves, but Baileys can deliver a history batch in that gap. Buffer
    // rather than drop.
    const pendingMessages: IncomingMessage[] = []
    const pendingEdits: IncomingMessage[] = []
    const pendingDeletes: Array<{ externalChatId?: string; externalMessageId: string }> = []

    const titles = new Map<string, string>()
    const metadataTried = new Set<string>()
    const lidToPn = new Map<string, string>()

    // Every event handler runs through one chain, so two batches can never
    // interleave and a thrown handler cannot take the socket down. A batch
    // still queued when close() starts is dropped rather than run: once the
    // caller has closed the session it has stopped listening, and an ingest
    // that lands after close is an ingest nobody expected.
    let chain: Promise<void> = Promise.resolve()
    const enqueue = (fn: () => Promise<void>): void => {
      chain = chain
        .then(() => (closing ? undefined : fn()))
        .catch(err => log.error({ err: errorShape(err) }, 'whatsapp event handling failed'))
    }

    // Bounded so a wedged batch cannot hang a shutdown. `chain` is read at call
    // time because enqueue() replaces it, and it never rejects.
    const drainChain = async (): Promise<void> => {
      let timer: Timer | null = null
      const bail = new Promise<void>(resolve => {
        timer = setTimeout(() => {
          log.warn({ drainMs: CHAIN_DRAIN_MS }, 'whatsapp event chain did not drain before close')
          resolve()
        }, CHAIN_DRAIN_MS)
        unref(timer)
      })
      try {
        await Promise.race([chain, bail])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    // The three doors out of this session. All shut the moment close() starts:
    // a batch that was already mid-flight must not deliver into a consumer
    // that has been told the session is gone.
    const emitMessage = (m: IncomingMessage): void => {
      if (closing) return
      if (onMessageCb) onMessageCb(m)
      else pendingMessages.push(m)
    }
    const emitEdit = (m: IncomingMessage): void => {
      if (closing) return
      if (onEditCb) onEditCb(m)
      else pendingEdits.push(m)
    }
    const emitDelete = (ref: { externalChatId?: string; externalMessageId: string }): void => {
      if (closing) return
      if (onDeleteCb) onDeleteCb(ref)
      else pendingDeletes.push(ref)
    }

    const markHistorySynced = async (): Promise<void> => {
      if (!historyPending) return
      historyPending = false
      try {
        await writeFile(markerPath, new Date().toISOString(), 'utf8')
      } catch (err) {
        log.error({ err: errorShape(err) }, 'whatsapp history marker write failed')
        historyPending = true
      }
    }

    // A @lid is an opaque identity. Resolving it to the phone-number JID is
    // what keeps one human in one chat instead of two (spec 4.3).
    //
    // Only SUCCESSFUL answers are cached. getPNForLID answers null for a
    // mapping the device has not learned yet (lib/Signal/lid-mapping.js), and
    // that mapping usually arrives moments later with the next stanza —
    // caching the null would pin the chat to its @lid forever, which is the
    // split-contact bug this exists to prevent. A thrown lookup is logged and
    // likewise not cached.
    const canonicalJid = async (jid: string): Promise<string> => {
      if (!jid.endsWith('@lid')) return jid
      const cached = lidToPn.get(jid)
      if (cached) return cached
      let pn: string | null = null
      try {
        pn = (await sock?.signalRepository.lidMapping.getPNForLID(jid)) ?? null
      } catch (err) {
        log.warn({ err: errorShape(err) }, 'whatsapp lid resolution failed')
        return jid
      }
      if (!pn) return jid
      const canonical = stripDevice(pn)
      lidToPn.set(jid, canonical)
      return canonical
    }

    // Titles come from history chats[].name and groups.upsert/update; a group
    // first seen through a message gets one lazy groupMetadata read, once.
    const titleFor = async (chatId: string, kind: WaChatKind, parsed: ParsedWaMessage | null): Promise<string | null> => {
      const known = titles.get(chatId)
      if (known) return known
      const s = sock
      if (kind === 'group' && s && !metadataTried.has(chatId)) {
        metadataTried.add(chatId)
        try {
          const meta = await s.groupMetadata(chatId)
          if (meta?.subject) { titles.set(chatId, meta.subject); return meta.subject }
        } catch (err) {
          log.warn({ err: errorShape(err) }, 'whatsapp group metadata lookup failed')
        }
      }
      // A DM has no subject of its own. The counterparty's push name is the
      // only title WhatsApp offers until a history sync delivers chats[].name.
      if (kind === 'dm' && parsed && !parsed.fromOwner && parsed.senderName) {
        titles.set(chatId, parsed.senderName)
        return parsed.senderName
      }
      return null
    }

    const handleRaw = async (raw: unknown): Promise<void> => {
      const event = parseProtocolEvent(raw)
      if (event) {
        const kind = chatKindForJid(event.remoteJid)
        if (!kind) return
        const chatId = await canonicalJid(event.remoteJid)
        if (event.kind === 'delete') {
          emitDelete({ externalChatId: chatId, externalMessageId: event.waId })
          return
        }
        // An edit payload with no recognisable text must never blank a row.
        if (!event.newText) return
        const key = (raw as { key?: { fromMe?: boolean } } | null)?.key
        emitEdit({
          externalChatId: chatId,
          chatKind: kind,
          chatTitle: titles.get(chatId) ?? null,
          externalMessageId: event.waId,
          senderExternalId: null,
          senderName: null,
          fromOwner: !!key?.fromMe,
          sentAt: tsToDate((raw as { messageTimestamp?: unknown } | null)?.messageTimestamp),
          type: 'text',
          text: event.newText,
          media: null,
          raw,
        })
        return
      }

      const parsed = parseWaMessage(raw)
      if (!parsed) return
      const chatId = await canonicalJid(parsed.remoteJid)
      const senderExternalId = parsed.sender ? await canonicalJid(parsed.sender.jid) : null
      const chatTitle = await titleFor(chatId, parsed.chatKind, parsed)
      emitMessage(toIncoming(parsed, { chatTitle, externalChatId: chatId, senderExternalId }))
    }

    const rememberTitles = (groups: WaGroup[] | undefined): void => {
      for (const g of groups ?? []) if (g?.id && g.subject) titles.set(g.id, g.subject)
    }

    let settleOpen: ((err?: unknown) => void) | null = null
    const ready = new Promise<void>((resolve, reject) => {
      openTimer = setTimeout(() => finishOpen(new ChannelError('whatsapp did not connect', 'timed_out')), this.openTimeoutMs)
      unref(openTimer)
      settleOpen = (err?: unknown) => {
        if (openTimer) { clearTimeout(openTimer); openTimer = null }
        if (err) reject(err)
        else resolve()
      }
    })
    // connect() can throw before `ready` is ever awaited, which would leave the
    // open timeout rejecting a promise nobody listens to. One inert handler
    // keeps that off the unhandled-rejection channel; `await ready` below still
    // observes the rejection itself.
    void ready.catch(() => {})
    function finishOpen(err?: unknown): void {
      const settle = settleOpen
      settleOpen = null
      settle?.(err)
    }

    const scheduleReconnect = (): void => {
      if (closing || dead || retryTimer) return
      const delay = backoff
      backoff = Math.min(backoff * 2, reconnectMaxMs)
      retryTimer = setTimeout(() => {
        retryTimer = null
        connect().catch(err => {
          log.error({ err: errorShape(err) }, 'whatsapp reconnect failed')
          scheduleReconnect()
        })
      }, delay)
      unref(retryTimer)
    }

    const wire = (s: WaSocket): void => {
      s.ev.on('creds.update', () => {
        lastEventAt = Date.now()
        void saveCreds().catch(err => log.error({ err: errorShape(err) }, 'whatsapp creds save failed'))
      })

      s.ev.on('groups.upsert', groups => { lastEventAt = Date.now(); rememberTitles(groups) })
      s.ev.on('groups.update', groups => { lastEventAt = Date.now(); rememberTitles(groups) })

      s.ev.on('messaging-history.set', ({ chats, messages }) => {
        lastEventAt = Date.now()
        enqueue(async () => {
          for (const c of chats ?? []) if (c?.id && c.name) titles.set(c.id, c.name)
          for (const raw of messages ?? []) await handleRaw(raw)
          // Counts and kinds only (spec invariant 6).
          log.info({ chats: (chats ?? []).length, messages: (messages ?? []).length }, 'whatsapp history batch')
          await markHistorySynced()
        })
      })

      s.ev.on('messages.upsert', ({ messages }) => {
        lastEventAt = Date.now()
        enqueue(async () => {
          for (const raw of messages ?? []) await handleRaw(raw)
          log.info({ messages: (messages ?? []).length }, 'whatsapp live batch')
        })
      })

      s.ev.on('connection.update', update => {
        if (update.connection === 'open') {
          lastEventAt = Date.now()
          lastConnectedAt = Date.now()
          connected = true
          backoff = reconnectMinMs
          log.info('whatsapp session open')
          finishOpen()
          return
        }
        if (update.connection !== 'close') {
          lastEventAt = Date.now()
          return
        }
        // Note the absent lastEventAt bump: a close is not a sign of life.
        connected = false
        if (closing) return
        const code = closeStatus(update.lastDisconnect?.error)
        if (code !== undefined && TERMINAL_CLOSE_CODES.has(code)) {
          dead = true
          deadCode = code
          log.warn({ code }, 'whatsapp session ended by the server; not reconnecting')
          finishOpen(new ChannelError(`whatsapp session ended (${code})`, 'auth_invalidated'))
          return
        }
        log.warn(
          { code: code ?? null, backoffMs: backoff, sinceLastEventMs: Date.now() - lastEventAt },
          'whatsapp disconnected; reconnecting',
        )
        scheduleReconnect()
      })
    }

    async function connect(): Promise<void> {
      if (closing || dead) return
      // sock.end() destroys the event emitter (lib/Socket/socket.js:506), so
      // every reconnect is a brand-new socket, never a re-listen.
      const s = await deps.makeSocket({ auth: state, version, syncFullHistory: historyPending })
      // close(), logOut() or a terminal close can land while makeSocket is in
      // flight. A socket built after the session is finished belongs to
      // nobody, and holding it would leak a live WhatsApp connection past
      // close().
      if (closing || dead) {
        void s.end(undefined).catch(() => {})
        return
      }
      sock = s
      wire(s)
    }

    const teardown = async (): Promise<void> => {
      // Set first: `closing` is what shuts the three emit doors and skips any
      // batch still queued, so everything after this line is quiet by
      // construction.
      closing = true
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
      if (openTimer) { clearTimeout(openTimer); openTimer = null }
      // A batch that was already running is allowed to finish (it may still
      // need to write the history marker) before close() resolves, so the
      // caller never sees work land after the close it awaited.
      await drainChain()
      try { await sock?.end(undefined) } catch (err) { log.warn({ err: errorShape(err) }, 'whatsapp socket end failed') }
      connected = false
      sock = null
    }

    try {
      await connect()
      await ready
    } catch (err) {
      await teardown()
      throw err
    }

    const session: ChannelSession = {
      // eslint-disable-next-line require-yield
      async *backfill(_opts: BackfillOpts, _shouldContinue?: () => boolean): AsyncGenerator<IncomingMessage> {
        // WhatsApp answers no history query. The phone PUSHES history
        // (messaging-history.set) and those messages go to onMessage exactly
        // like live ones (spec 4.3). Ingest is first-writer-wins, so a replay
        // is a no-op.
      },

      onMessage(cb) {
        onMessageCb = cb
        for (const m of pendingMessages.splice(0)) cb(m)
      },
      onEdit(cb) {
        onEditCb = cb
        for (const m of pendingEdits.splice(0)) cb(m)
      },
      onDelete(cb) {
        onDeleteCb = cb
        for (const ref of pendingDeletes.splice(0)) cb(ref)
      },

      async downloadMedia(raw: unknown): Promise<{ data: Buffer; mimeType: string | null }> {
        const s = sock
        // No live socket: closed, mid-reconnect (sock stale/not yet
        // replaced), or never opened. All of these read as "can't reach
        // WhatsApp right now" rather than a specific fatal kind, since a
        // reconnect can still bring the session back.
        if (closing || !connected || !s) throw new ChannelError('no live WhatsApp socket', 'other')
        const message = reviveRawMessage(raw)
        try {
          const data = await deps.downloadMedia(message, { reuploadRequest: m => s.updateMediaMessage(m) })
          return { data, mimeType: parseWaMessage(message)?.media?.mimeType ?? null }
        } catch (err) {
          throw new ChannelError(`whatsapp media download failed: ${errText(err)}`, 'other')
        }
      },

      async ping(): Promise<void> {
        if (dead) throw new ChannelError(`whatsapp session ended (${deadCode ?? 'logged out'})`, 'auth_invalidated')
        if (connected) return
        // Not connected. A reconnect loop that never reaches 'open' is the
        // failure this has to catch — WhatsApp is answering, so `lastEventAt`
        // keeps moving while the session archives nothing. Only the last time
        // the socket was OPEN counts, so the manager hears about it after one
        // stale window instead of never.
        if (Date.now() - lastConnectedAt > staleMs) {
          throw new ChannelError('whatsapp has not been connected for a full stale window', 'other')
        }
      },

      async logOut(): Promise<void> {
        closing = true
        dead = true
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
        if (openTimer) { clearTimeout(openTimer); openTimer = null }
        await drainChain()
        try {
          // lib/Socket/socket.js:572 — removes THIS companion device only.
          await sock?.logout()
        } catch (err) {
          log.warn({ err: errorShape(err) }, 'whatsapp unlink call failed; removing local auth state anyway')
        }
        try { await sock?.end(undefined) } catch { /* already closing */ }
        connected = false
        await rm(dir, { recursive: true, force: true })
        log.info('whatsapp device unlinked and auth state removed')
      },

      async close(): Promise<void> {
        await teardown()
      },
    }

    return session
  }
}
