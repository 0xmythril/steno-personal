import { and, eq, isNull } from 'drizzle-orm'
import { track } from '@/lib/services/telemetry'
import { db } from '@/lib/db/client'
import { connections } from '@/lib/db/schema'
import { decryptSecret, encryptSecret } from '@/lib/services/crypto'
import { PASSWORD_REJECTED } from '@/lib/services/connections'
import type { Channel, ChannelAccount } from '@/lib/channels/port'

// Worker-facing half of the DB-mediated login handshake. Pure database
// operations — no channel library code lives here — so the whole login state
// machine is testable with no network. Every write is guarded on
// `revoked_at IS NULL`: a revoked connection must never be written back into.

// A password the owner submitted and then walked away from is not a password
// we may still try; five minutes is long enough for the worker's next poll and
// short enough that a forgotten tab cannot arm a later attempt.
const STALE_SECRET_MS = 5 * 60_000

// purpose rides along so the manager knows whether a finished handshake
// becomes an archive connection (completeLogin) or a recovery verdict
// (lib/services/recovery.ts#completeRecovery).
export async function claimPendingLogins(): Promise<Array<{ id: string; channel: Channel; purpose: 'archive' | 'recovery'; createdAt: Date }>> {
  return db.select({ id: connections.id, channel: connections.channel, purpose: connections.purpose, createdAt: connections.createdAt })
    .from(connections)
    .where(and(eq(connections.status, 'pending'), isNull(connections.revokedAt)))
}

export async function activeConnections(): Promise<Array<{ id: string; channel: Channel; sessionCiphertext: string | null; lastSyncAt: Date | null }>> {
  return db.select({
    id: connections.id, channel: connections.channel,
    sessionCiphertext: connections.sessionCiphertext, lastSyncAt: connections.lastSyncAt,
  }).from(connections)
    .where(and(eq(connections.status, 'active'), isNull(connections.revokedAt)))
}

export async function publishQr(id: string, url: string): Promise<void> {
  await db.update(connections).set({ loginQrToken: url, loginQrAt: new Date(), lastError: null })
    .where(and(eq(connections.id, id), isNull(connections.revokedAt)))
}

export async function requestPassword(id: string): Promise<void> {
  await db.update(connections).set({ loginNeedsPassword: true })
    .where(and(eq(connections.id, id), isNull(connections.revokedAt)))
}

// Decrypt the owner-supplied 2FA password ONCE: read it, null it immediately
// (used or not — it is single-use), and ignore anything stale.
// Not wrapped in a transaction on purpose: exactly one worker process runs,
// and the SessionManager drives at most one login per connection
// (loginsInFlight), so two concurrent takes cannot happen.
export async function takeLoginSecret(id: string): Promise<string | null> {
  const [row] = await db.select({ ct: connections.loginSecretCiphertext, at: connections.loginSecretAt })
    .from(connections).where(and(eq(connections.id, id), isNull(connections.revokedAt)))
  if (!row?.ct || !row.at) return null
  await db.update(connections).set({ loginSecretCiphertext: null, loginSecretAt: null })
    .where(eq(connections.id, id))
  if (Date.now() - row.at.getTime() > STALE_SECRET_MS) return null
  return decryptSecret(row.ct)
}

// The channel rejected the password the owner last submitted. This is NOT a
// failed login: the handshake is still live and still waiting on a password,
// exactly as before the wrong attempt. Only last_error changes, so the portal's
// poll brings the form back instead of sitting on a silent "checking…" for the
// rest of the login window.
export async function recordPasswordRejected(id: string): Promise<void> {
  await db.update(connections).set({ lastError: PASSWORD_REJECTED, loginNeedsPassword: true })
    .where(and(eq(connections.id, id), isNull(connections.revokedAt)))
}

// Liveness guard: the WHERE matches only a row that is STILL a live pending
// login. A revoked or vanished row must never be resurrected — an unguarded
// UPDATE would flip a revoked row back to active and hand it a fresh session
// key, undoing the revocation. Zero matched rows is reported as 'gone'.
// 'duplicate' is unreachable in single-user mode (one live connection per
// channel); kept in the union so a future multi-account mode can produce it
// without a signature change.
export async function completeLogin(id: string, sessionString: string, account: ChannelAccount): Promise<'ok' | 'duplicate' | 'gone'> {
  const updated = await db.update(connections).set({
    status: 'active', externalAccountId: account.externalAccountId, displayName: account.displayName,
    sessionCiphertext: encryptSecret(sessionString), lastError: null,
    loginQrToken: null, loginQrAt: null, loginNeedsPassword: false,
    loginSecretCiphertext: null, loginSecretAt: null,
  }).where(and(
    eq(connections.id, id),
    eq(connections.status, 'pending'),
    isNull(connections.revokedAt),
  )).returning({ id: connections.id, channel: connections.channel })
  if (updated.length === 0) return 'gone'
  // Which channel, and nothing about whose account.
  track('channel_connected', { channel: updated[0].channel })
  return 'ok'
}

// A FAILED login is retryable, not revoked: error status plus a user-visible
// reason, login columns cleared so a fresh attempt starts clean.
export async function failLogin(id: string, message: string): Promise<void> {
  await db.update(connections).set({
    status: 'error', lastError: message,
    loginQrToken: null, loginQrAt: null, loginNeedsPassword: false,
    loginSecretCiphertext: null, loginSecretAt: null,
  }).where(and(eq(connections.id, id), isNull(connections.revokedAt)))
}

export async function recordSync(id: string): Promise<void> {
  await db.update(connections).set({ lastSyncAt: new Date() })
    .where(and(eq(connections.id, id), isNull(connections.revokedAt)))
}
