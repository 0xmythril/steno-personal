import { Document, MemoryStorage, Photo, TelegramClient, tl } from '@mtcute/node'
import type { Message, Peer } from '@mtcute/node'
// mtcute's own TL codec, the same pair its session storage uses:
// serializeObject() is TlBinaryWriter.serializeObject(__tlWriterMap, obj) and
// deserializeObject() is TlBinaryReader.deserializeObject(__tlReaderMap, data)
// (node_modules/@mtcute/core/utils/binary/serialization.js). It reaches us
// through a package export path rather than a deep file import:
// @mtcute/node/utils.js re-exports @mtcute/core/utils.js, which re-exports
// that module. The deep paths the maps live at (@mtcute/core/tl/binary/*.js)
// are NOT in @mtcute/core's package.json "exports", so importing them
// directly would fail to resolve.
import { deserializeObject, serializeObject } from '@mtcute/node/utils.js'
import { DEVICE_MODEL } from '@/lib/channels/device-model'
import { errorShape, log } from '@/lib/log'
import {
  ChannelError,
  type BackfillOpts, type ChannelAccount, type ChannelContact, type ChannelPort,
  type ChannelSession, type IncomingMessage, type LoginDriver,
  type DeleteRef,
} from '@/lib/channels/port'

// The ONLY file in the repo allowed to import @mtcute/* (enforced by
// tests/telegram-structure.test.ts). READ-ONLY BY CONSTRUCTION save for one
// deliberate exception: every method here either reads state, flips the
// invisible-status bit (account.updateStatus, not a content mutation), or —
// logOut() only — ends OUR OWN session via auth.logOut. Nothing here sends,
// edits, deletes, reacts, joins, leaves, or touches profile data.

// Each of these means the session is permanently dead — the phone revoked it,
// the account was deactivated, another login invalidated this auth key, or
// Telegram expired it. Never transient, so they must not be retried every
// 3 seconds forever with log spam.
const DEAD_SESSION_ERRORS = [
  'AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'USER_DEACTIVATED', 'USER_DEACTIVATED_BAN',
  'AUTH_KEY_DUPLICATED', 'SESSION_EXPIRED',
] as const

// Every RPC this file makes is on the path of a manager tick, and mtcute's
// own default is `timeout: Infinity`. An unbounded call would wedge the tick
// (and, for ping, the liveness check that is supposed to notice trouble)
// behind a connection that is neither answering nor failing. Applied to every
// on-tick call: the raw account.updateStatus below, getMe() in open(), and
// the auth.logOut RPC inside logOut() — the last one matters most, because it
// runs during a revoke, exactly when Telegram is least likely to answer.
//
// tg.withParams({ timeout }) is mtcute's own wrapper for the calls that take
// no per-call options: it proxies the client so every client.call() the
// method makes inherits these params
// (node_modules/@mtcute/core/highlevel/methods/misc/with-params.js).
const RPC_TIMEOUT_MS = 15_000

function classify(e: unknown): ChannelError {
  // Already classified — a ChannelError this file raised on purpose. Passing
  // it through classify() again would flatten its kind to 'other', which is
  // exactly what the wrappers around backfill() and downloadMedia() would do.
  if (e instanceof ChannelError) return e
  if (DEAD_SESSION_ERRORS.some(text => tl.RpcError.is(e, text))) {
    return new ChannelError('auth invalidated', 'auth_invalidated')
  }
  return new ChannelError(String((e as { message?: unknown })?.message ?? e), 'other')
}

// mtcute's `Peer = User | Chat`. `User` is its own class (`.type === 'user'`),
// so DMs never reach the `Chat` class at all and `Chat.chatType` only ever
// returns 'group' | 'supergroup' | 'channel' | 'gigagroup' | 'monoforum' |
// 'community'. Branch on `.type` first, then narrow the chat-only cases.
// 'monoforum' (DMs to channel admins) and 'community' (a linked-chat
// collection) have no slot in our three-way union; both land in 'group' as the
// closest fit rather than widening the DTO for two rare shapes.
function chatKind(peer: Peer): 'dm' | 'group' | 'channel' {
  if (peer.type === 'user') return 'dm'
  if (peer.chatType === 'channel') return 'channel'
  return 'group'
}

function messageType(msg: Message): IncomingMessage['type'] {
  if (!msg.media) return msg.text ? 'text' : 'system'
  switch (msg.media.type) {
    case 'photo': return 'image'
    case 'video': return 'video'
    case 'audio': case 'voice': return 'audio'
    case 'document': return 'document'
    case 'sticker': return 'sticker'
    // contact, dice, game, location, poll, venue, webpage, story, invoice…
    default: return 'unknown'
  }
}

const DOWNLOADABLE = new Set(['photo', 'video', 'audio', 'voice', 'document', 'sticker'])

// Only the four fields the DTO carries, read through one narrow cast: the
// concrete media classes differ in which of them they declare, and M1 stores
// nothing but a boolean anyway. M4 is where these values start mattering.
function mediaMeta(msg: Message): IncomingMessage['media'] {
  if (!msg.media) return null
  const m = msg.media as { type: string; mimeType?: string; fileSize?: number; duration?: number }
  if (!DOWNLOADABLE.has(m.type)) return null
  return {
    mimeType: m.mimeType ?? (m.type === 'photo' ? 'image/jpeg' : null),
    sizeBytes: typeof m.fileSize === 'number' ? m.fileSize : null,
    isVoiceNote: m.type === 'voice',
    durationSeconds: typeof m.duration === 'number' ? Math.round(m.duration) : null,
  }
}

// IncomingMessage.raw is stored as a JSON column and comes back to
// downloadMedia() only after JSON.stringify -> JSON.parse. A raw TL message
// does not survive that trip: `accessHash` is a Long (an object with high/low
// halves) and `fileReference` is a Uint8Array, and JSON turns both into shapes
// the file-download path cannot use — so `new Document(media.document)` would
// be handed garbage and the download could never work. Storing mtcute's own
// binary TL encoding, base64'd, keeps the message byte-exact across the
// database and hands back a real tl.RawMessage on the other side.
export type TelegramRaw = { tl: string }

export function encodeTlRaw(obj: tl.TlObject): TelegramRaw {
  return { tl: Buffer.from(serializeObject(obj)).toString('base64') }
}

// Returns null for anything that is not one of our own encoded blobs — a row
// written by another port, or (M1 being the first release) nothing at all.
// The return type is deserializeObject's own (it can also yield an `mtp.*`
// object, which encodeTlRaw never produces) so that no cast has to stand in
// for it; callers narrow on `._` as usual.
export function decodeTlRaw(raw: unknown): ReturnType<typeof deserializeObject> | null {
  const encoded = (raw as TelegramRaw | null | undefined)?.tl
  if (typeof encoded !== 'string') return null
  return deserializeObject(new Uint8Array(Buffer.from(encoded, 'base64')))
}

function toIncoming(msg: Message, selfId: string): IncomingMessage {
  return {
    externalChatId: String(msg.chat.id), // marked peer id — stable per chat
    chatKind: chatKind(msg.chat),
    chatTitle: msg.chat.displayName ?? null,
    externalMessageId: String(msg.id),
    senderExternalId: msg.sender ? String(msg.sender.id) : null,
    senderName: msg.sender?.displayName ?? null,
    // mtcute's own doc on isOutgoing: "Messages to yourself (i.e. Saved
    // Messages) are incoming (outgoing = false)". In Saved Messages the chat
    // IS the owner, so a message there is always the owner's. Do not simplify
    // this back to bare isOutgoing — that misattributes every note the owner
    // writes to themselves.
    fromOwner: msg.isOutgoing || String(msg.chat.id) === selfId,
    sentAt: msg.date,
    type: messageType(msg),
    text: msg.text || null,
    media: mediaMeta(msg),
    raw: encodeTlRaw(msg.raw),
  }
}

// One Telegram contact as the address book stores it. Pure, and exported so
// the mapping is testable without an MTProto client: there is no fake-client
// harness for this binding, and the two things worth pinning — the id becomes
// a string, and a phone number becomes '+' + digits or null — are exactly what
// getContacts() hands over.
//
// mtcute's User.displayName is a string, but a deleted or nameless account
// yields an empty one; the archive stores "no name" as null, not as ''.
export function contactFromUser(
  u: { id: number | bigint; displayName?: string | null; phoneNumber?: string | null },
): ChannelContact {
  const name = u.displayName?.trim()
  const digits = u.phoneNumber?.replace(/\D/g, '') ?? ''
  return {
    externalId: String(u.id),
    displayName: name ? name : null,
    phone: digits ? `+${digits}` : null,
  }
}

// No setOffline() wrapper exists on the client — staying invisible is a raw
// account.updateStatus RPC. This is a status flag, not a content mutation, and
// it is only ever called with offline: true; going back online is never called
// anywhere in this file.
async function setInvisible(tg: TelegramClient): Promise<void> {
  await tg.call({ _: 'account.updateStatus', offline: true }, { timeout: RPC_TIMEOUT_MS })
}

function newClient(opts: { apiId: number; apiHash: string }): TelegramClient {
  return new TelegramClient({
    apiId: opts.apiId,
    apiHash: opts.apiHash,
    storage: new MemoryStorage(), // the session lives encrypted in SQLite, not on disk
    initConnectionOptions: { deviceModel: DEVICE_MODEL },
  })
}

export class MtcuteTelegramPort implements ChannelPort {
  readonly channel = 'telegram' as const

  constructor(private opts: { apiId: number; apiHash: string }) {}

  async login(driver: LoginDriver, opts: { timeoutMs: number; connectionId: string }): Promise<{ sessionString: string; account: ChannelAccount }> {
    const tg = newClient(this.opts)
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), opts.timeoutMs)
    try {
      const self = await tg.start({
        // Never `void` this: the driver writes the QR to the database, and a
        // dropped promise would surface as an unhandled rejection (fatal to
        // the worker process) instead of a logged, survivable miss. The login
        // itself continues — mtcute re-issues the URL before it expires.
        qrCodeHandler: (url: string) => {
          driver.publishQr(url).catch(e => log.error({ err: errorShape(e), connectionId: opts.connectionId }, 'could not publish the login QR'))
        },
        // Invoked only when Telegram demands the 2FA password.
        password: async () => {
          await driver.requestPassword()
          for (;;) {
            const pw = await driver.getPassword()
            if (pw) return pw
            if (abort.signal.aborted) throw new ChannelError('login timed out', 'timed_out')
            await new Promise(r => setTimeout(r, 2000))
          }
        },
        // For a dynamic (function) password source, mtcute does NOT throw on a
        // wrong password: it calls the invalid-password callback and loops back
        // to invoke `password` again. start() forwards its own
        // invalidCodeCallback('password') into the QR sign-in for exactly that.
        // Without this branch a wrong password is swallowed: `password` is
        // re-invoked, re-requests (a no-op), and polls getPassword() forever —
        // the secret is single-use and already consumed — so nothing ever
        // reaches the database to say the attempt failed. This login only ever
        // takes the QR path, so `type` can only be 'password'; the guard stays
        // in case that changes.
        invalidCodeCallback: (type: 'code' | 'password') => {
          if (type === 'password') return driver.passwordRejected()
        },
        abortSignal: abort.signal,
      })
      // Keep going if this fails — it must not abort a login — but never
      // swallow it: the account would silently keep presenting as ONLINE to
      // the owner's contacts for the life of the connection.
      await setInvisible(tg).catch(e => log.error({ err: errorShape(e), connectionId: opts.connectionId }, 'could not set the session offline'))
      const sessionString = await tg.exportSession()
      await tg.destroy()
      return {
        sessionString,
        account: { channel: 'telegram', externalAccountId: String(self.id), displayName: self.displayName ?? null },
      }
    } catch (e) {
      await tg.destroy().catch(() => {})
      if (abort.signal.aborted) throw new ChannelError('login timed out', 'timed_out')
      throw classify(e)
    } finally {
      clearTimeout(timer)
    }
  }

  async open(sessionString: string, opts: { connectionId: string }): Promise<ChannelSession> {
    const tg = newClient(this.opts)
    try {
      // importSession is local: it only reads the string and writes the DCs,
      // auth key and self into MemoryStorage
      // (@mtcute/core/highlevel/base.js#importSession) — no network, so
      // nothing to bound.
      await tg.importSession(sessionString)
      // Deliberately NOT start({}): it swallows AUTH_KEY_UNREGISTERED and
      // rethrows an argument error, which would classify as transient and hide
      // a phone-side revocation forever. getMe() lets the real RpcError reach
      // classify(). And deliberately NO explicit updates-loop start:
      // notifyLoggedIn() starts it, and calling the starter again races that
      // call (its guard is only set after an awaited round trip), which
      // double-registers the update handler and runs two loops over the same
      // state.
      const me = await tg.withParams({ timeout: RPC_TIMEOUT_MS }).getMe()
      // notifyLoggedIn is local bookkeeping, not an RPC: it stores `self`,
      // relabels the logger, and kicks the updates loop with a start it does
      // not await (@mtcute/core/highlevel/base.js#notifyLoggedIn ->
      // updates/manager.js#notifyLoggedIn). Left unbounded deliberately.
      await tg.notifyLoggedIn(me.raw)
      // mtcute reports background failures (an update-loop fault, a transport
      // error) through this emitter rather than by rejecting anything we
      // await. With no subscriber they are invisible; the manager still has
      // ping() to decide whether the session is dead, so this is a log, not a
      // control path.
      tg.onError.add(e => log.error({ err: errorShape(e), connectionId: opts.connectionId }, 'mtcute client error'))
      await setInvisible(tg).catch(e => log.error({ err: errorShape(e), connectionId: opts.connectionId }, 'could not set the session offline'))
      return new MtcuteSession(tg, String(me.id), opts.connectionId)
    } catch (e) {
      // Never leak a client: the manager retries open() every tick for a
      // connection it could not open, so a failure path without cleanup would
      // orphan one MTProto client per tick for as long as the fault lasts.
      await tg.destroy().catch(() => {})
      throw classify(e)
    }
  }
}

class MtcuteSession implements ChannelSession {
  constructor(private tg: TelegramClient, private selfId: string, private connectionId: string) {}

  // An exception thrown out of an update callback unwinds into mtcute's
  // update loop, where it would take down the whole session (or the process)
  // over one malformed message. One update is worth dropping; the loop is not.
  private guarded(what: string, fn: () => void): void {
    try {
      fn()
    } catch (e) {
      log.error({ err: errorShape(e), connectionId: this.connectionId, update: what }, 'update handler failed; dropping the update')
    }
  }

  async *backfill(opts: BackfillOpts, shouldContinue: () => boolean = () => true): AsyncIterable<IncomingMessage> {
    try {
      yield* this.iterateBackfill(opts, shouldContinue)
    } catch (e) {
      // A backfill is a long run of network calls, so it is the likeliest
      // place for the phone to revoke us mid-flight. Unclassified, that would
      // reach the manager as a raw mtcute RpcError and be treated as a
      // transient fault, retried forever instead of marking the connection
      // revoked.
      throw classify(e)
    }
  }

  private async *iterateBackfill(opts: BackfillOpts, shouldContinue: () => boolean): AsyncIterable<IncomingMessage> {
    const since = Date.now() - opts.sinceDays * 86_400_000
    let dialogs = 0
    // iterDialogs defaults to archived: 'exclude'. Chats in the owner's
    // Archived folder still get live ingest (update handlers do not filter by
    // folder), so the default would leave them backfilled-never while new
    // messages in them are recorded. 'keep' covers both.
    for await (const dialog of this.tg.iterDialogs({ limit: opts.maxDialogs, archived: 'keep' })) {
      // Checked BETWEEN dialogs — the cheapest correct granularity. A revoke
      // flips this as soon as the connection leaves activeConnections, and a
      // 200 x 500 backfill must not keep spending throttled network calls on a
      // connection nobody controls any more.
      if (!shouldContinue()) return
      dialogs++
      let count = 0
      // A Dialog's conversation is `.peer` (mtcute's `Peer = User | Chat`,
      // which satisfies iterHistory's input through its inputPeer getter).
      for await (const msg of this.tg.iterHistory(dialog.peer, { limit: opts.maxPerChat })) {
        if (msg.date.getTime() < since) break // iterHistory is newest-first
        count++
        yield toIncoming(msg, this.selfId)
      }
      // mtcute's iterators stop AT the limit rather than overshooting it, so
      // they never yield a (cap + 1)-th item and an in-loop overflow check
      // could never fire. A count that reached the cap is how truncation is
      // detected, and it is logged rather than left silent.
      if (count === opts.maxPerChat) {
        log.warn({ cap: opts.maxPerChat, connectionId: this.connectionId }, 'backfill hit the per-chat message cap; older history in that chat was not archived')
      }
    }
    if (dialogs === opts.maxDialogs) {
      log.warn({ cap: opts.maxDialogs, connectionId: this.connectionId }, 'backfill hit the dialog cap; some chats were not archived')
    }
  }

  onMessage(cb: (m: IncomingMessage) => void): void {
    this.tg.onNewMessage.add(msg => this.guarded('message', () => cb(toIncoming(msg, this.selfId))))
  }
  onEdit(cb: (m: IncomingMessage) => void): void {
    this.tg.onEditMessage.add(msg => this.guarded('edit', () => cb(toIncoming(msg, this.selfId))))
  }
  onDelete(cb: (ref: DeleteRef) => void): void {
    this.tg.onDeleteMessage.add(upd => this.guarded('delete', () => {
      const externalChatId = upd.channelId ? String(upd.channelId) : undefined
      for (const id of upd.messageIds) cb({ externalChatId, externalMessageId: String(id) })
    }))
  }

  // Reads the attachment off the stored raw TL message. Nothing is uploaded,
  // reuploaded, or marked; this is a pure file read. M4's drain is the only
  // caller.
  async downloadMedia(raw: unknown): Promise<{ data: Buffer; mimeType: string | null }> {
    try {
      const decoded = decodeTlRaw(raw)
      if (decoded?._ !== 'message') throw new ChannelError('stored message is not a downloadable Telegram message', 'other')
      const media = decoded.media
      if (!media) throw new ChannelError('message carries no media', 'other')
      if (media._ === 'messageMediaPhoto' && media.photo?._ === 'photo') {
        const data = await this.tg.downloadAsBuffer(new Photo(media.photo))
        return { data: Buffer.from(data), mimeType: 'image/jpeg' }
      }
      if (media._ === 'messageMediaDocument' && media.document?._ === 'document') {
        const data = await this.tg.downloadAsBuffer(new Document(media.document))
        return { data: Buffer.from(data), mimeType: media.document.mimeType ?? null }
      }
      throw new ChannelError(`media ${media._} is not downloadable`, 'other')
    } catch (e) {
      // Same reasoning as backfill: a download is a network call like any
      // other, and a dead session must not reach the caller as a raw RpcError.
      // classify() returns the ChannelErrors raised just above untouched.
      throw classify(e)
    }
  }

  // The client's teardown method is destroy(): "Destroy the client and all its
  // resources… make the client no longer usable."
  async close(): Promise<void> { await this.tg.destroy() }

  // auth.logOut is Telegram's own "log out the CURRENT session" call, distinct
  // from auth.resetAuthorizations ("log out every OTHER session"), which this
  // binding never calls. mtcute's logOut() does exactly two things: the RPC,
  // then purely local bookkeeping on our own client instance. It cannot affect
  // the owner's other devices.
  //
  // If the RPC throws (the session is already dead — nothing to log out) this
  // rejects WITHOUT calling destroy(): the manager falls back to close(), and
  // destroy() is idempotent, so there is no double-teardown hazard either way.
  async logOut(): Promise<void> {
    await this.tg.withParams({ timeout: RPC_TIMEOUT_MS }).logOut()
    await this.tg.destroy()
  }

  // The owner's own contact list. contacts.getContacts is a read: it returns
  // what the account already knows and writes nothing — the mutating contact
  // calls (add, import, delete, note) are banned outright by
  // tests/telegram-structure.test.ts. This runs on a manager tick like every
  // other call here, so it is bounded by the same RPC timeout, and its errors
  // go through classify() so a revoked session reaches the manager as one.
  async listContacts(): Promise<ChannelContact[]> {
    try {
      const users = await this.tg.withParams({ timeout: RPC_TIMEOUT_MS }).getContacts()
      return users.map(contactFromUser)
    } catch (e) {
      throw classify(e)
    }
  }

  // A phone-side revocation does not throw anywhere in a running session
  // (mtcute's updates manager catches AUTH_KEY_UNREGISTERED internally and
  // just stops its loop), so the manager must actively ask. Reuses the same
  // raw account.updateStatus call as setInvisible: it doubles as re-asserting
  // invisibility, and unlike the calls at login/open time its error is NOT
  // swallowed — the whole point is to let a dead-session RpcError reach
  // classify() and, from there, the revoke path.
  async ping(): Promise<void> {
    try {
      await setInvisible(this.tg)
    } catch (e) {
      throw classify(e)
    }
  }
}
