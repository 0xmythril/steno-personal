import { Document, MemoryStorage, Photo, TelegramClient, tl } from '@mtcute/node'
import type { Message, Peer } from '@mtcute/node'
import { DEVICE_MODEL } from '@/lib/channels/device-model'
import { errorShape, log } from '@/lib/log'
import {
  ChannelError,
  type BackfillOpts, type ChannelAccount, type ChannelPort, type ChannelSession,
  type IncomingMessage, type LoginDriver,
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

function classify(e: unknown): ChannelError {
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
    raw: msg.raw,
  }
}

// No setOffline() wrapper exists on the client — staying invisible is a raw
// account.updateStatus RPC. This is a status flag, not a content mutation, and
// it is only ever called with offline: true; going back online is never called
// anywhere in this file.
async function setInvisible(tg: TelegramClient): Promise<void> {
  await tg.call({ _: 'account.updateStatus', offline: true })
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
        qrCodeHandler: (url: string) => { void driver.publishQr(url) },
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
      await tg.importSession(sessionString)
      // Deliberately NOT start({}): it swallows AUTH_KEY_UNREGISTERED and
      // rethrows an argument error, which would classify as transient and hide
      // a phone-side revocation forever. getMe() lets the real RpcError reach
      // classify(). And deliberately NO explicit updates-loop start:
      // notifyLoggedIn() starts it, and calling the starter again races that
      // call (its guard is only set after an awaited round trip), which
      // double-registers the update handler and runs two loops over the same
      // state.
      const me = await tg.getMe()
      await tg.notifyLoggedIn(me.raw)
      await setInvisible(tg).catch(e => log.error({ err: errorShape(e), connectionId: opts.connectionId }, 'could not set the session offline'))
      return new MtcuteSession(tg, String(me.id))
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
  constructor(private tg: TelegramClient, private selfId: string) {}

  async *backfill(opts: BackfillOpts, shouldContinue: () => boolean = () => true): AsyncIterable<IncomingMessage> {
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
        log.warn({ cap: opts.maxPerChat }, 'backfill hit the per-chat message cap; older history in that chat was not archived')
      }
    }
    if (dialogs === opts.maxDialogs) {
      log.warn({ cap: opts.maxDialogs }, 'backfill hit the dialog cap; some chats were not archived')
    }
  }

  onMessage(cb: (m: IncomingMessage) => void): void {
    this.tg.onNewMessage.add(msg => cb(toIncoming(msg, this.selfId)))
  }
  onEdit(cb: (m: IncomingMessage) => void): void {
    this.tg.onEditMessage.add(msg => cb(toIncoming(msg, this.selfId)))
  }
  onDelete(cb: (ref: { externalChatId?: string; externalMessageId: string }) => void): void {
    this.tg.onDeleteMessage.add(upd => {
      const externalChatId = upd.channelId ? String(upd.channelId) : undefined
      for (const id of upd.messageIds) cb({ externalChatId, externalMessageId: String(id) })
    })
  }

  // Reads the attachment off the stored raw TL message. Nothing is uploaded,
  // reuploaded, or marked; this is a pure file read. M4's drain is the only
  // caller.
  async downloadMedia(raw: unknown): Promise<{ data: Buffer; mimeType: string | null }> {
    const media = (raw as tl.RawMessage | undefined)?.media
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
    await this.tg.logOut()
    await this.tg.destroy()
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
