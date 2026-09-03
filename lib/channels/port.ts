import type { IncomingMessage } from '@/lib/services/ingest'

// Re-exported so a consumer of the port (the session manager, FakePort, a
// binding) imports the DTO and the interfaces that carry it from one place.
export type { IncomingMessage } from '@/lib/services/ingest'

// The seam between the session manager and every messaging library. READ-ONLY
// BY CONSTRUCTION: the interface exposes login, session open, history
// backfill, update subscriptions, and attachment download — and no
// send/mutate operation exists to call. Its implementations are the mtcute
// binding (lib/channels/telegram.ts), the Baileys binding (M2), and FakePort.

export type Channel = 'telegram' | 'whatsapp'

export type ChannelAccount = { channel: Channel; externalAccountId: string; displayName: string | null }

// The DB-mediated login handshake. The manager wires these to
// lib/services/login.ts: publishQr -> publishQr(), requestPassword ->
// requestPassword(), getPassword -> takeLoginSecret(), passwordRejected ->
// recordPasswordRejected().
export interface LoginDriver {
  publishQr(url: string): Promise<void>
  requestPassword(): Promise<void>          // Telegram 2FA only
  getPassword(): Promise<string | null>     // Telegram 2FA only
  // Called when the channel rejected the password getPassword() last returned.
  // Without it a wrong password is indistinguishable, on our side, from "still
  // waiting for one": nothing reaches the database to say the attempt failed,
  // so the portal sits on a silent "checking…" until the login times out.
  passwordRejected(): Promise<void>         // Telegram 2FA only
}

export type BackfillOpts = { sinceDays: number; maxDialogs: number; maxPerChat: number }

export interface ChannelSession {
  // shouldContinue is polled between chats — the cheapest correct granularity
  // — so a long backfill stops promptly once the manager flips it (the owner
  // disconnected, or the connection was revoked mid-scan).
  backfill(opts: BackfillOpts, shouldContinue?: () => boolean): AsyncIterable<IncomingMessage>
  onMessage(cb: (m: IncomingMessage) => void): void
  onEdit(cb: (m: IncomingMessage) => void): void
  onDelete(cb: (ref: { externalChatId?: string; externalMessageId: string }) => void): void
  // Fetch one message's attachment bytes. `raw` is the IncomingMessage.raw
  // that ingest stored. Throws ChannelError('other') when unavailable.
  downloadMedia(raw: unknown): Promise<{ data: Buffer; mimeType: string | null }>
  // Liveness probe. A session revoked from the phone never throws on its own,
  // so the manager must actively ask each tick. Resolves for a live session;
  // throws ChannelError('auth_invalidated') for a dead one.
  ping(): Promise<void>
  // Ends OUR session on the channel side only — never "log out everywhere".
  // The one sanctioned mutation in this port: it destroys only our own access
  // and touches no content. May throw (a dead session cannot log itself out),
  // so callers must fall back to close().
  logOut(): Promise<void>
  close(): Promise<void>
}

export interface ChannelPort {
  readonly channel: Channel
  login(driver: LoginDriver, opts: { timeoutMs: number; connectionId: string }): Promise<{ sessionString: string; account: ChannelAccount }>
  open(sessionString: string, opts: { connectionId: string }): Promise<ChannelSession>
}

export type ChannelErrorKind = 'auth_invalidated' | 'timed_out' | 'duplicate' | 'other'

export class ChannelError extends Error {
  kind: ChannelErrorKind
  constructor(message: string, kind: ChannelErrorKind) {
    super(message)
    this.name = 'ChannelError'
    this.kind = kind
  }
}
