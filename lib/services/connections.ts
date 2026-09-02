import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { chats, connections } from '@/lib/db/schema'
import { encryptSecret } from '@/lib/services/crypto'
import type { Channel } from '@/lib/channels/port'

// Portal-facing half of the connection lifecycle. The worker-facing half is
// lib/services/login.ts. Nothing here returns a ciphertext column: the login
// QR token is served (it IS the thing the owner scans), the session string
// and the stored 2FA password never are.

// last_error is a machine-readable sentinel for the one error the UI has to
// render as a form state rather than a message. Every other value is prose
// the portal shows verbatim.
export const PASSWORD_REJECTED = 'password_rejected'

export type ConnectionStatus = {
  id: string
  channel: Channel
  status: 'pending' | 'active' | 'revoked' | 'error'
  displayName: string | null
  createdAt: Date
  revokedAt: Date | null
  lastSyncAt: Date | null
  lastError: string | null
  // Non-null only while pending: a live handshake is the only time these
  // fields mean anything, and a stale QR on an active card is a lie.
  login: { qr: string | null; qrAt: Date | null; needsPassword: boolean; passwordRejected: boolean } | null
}

type Row = typeof connections.$inferSelect

function toStatus(row: Row): ConnectionStatus {
  return {
    id: row.id, channel: row.channel, status: row.status,
    displayName: row.displayName, createdAt: row.createdAt,
    revokedAt: row.revokedAt, lastSyncAt: row.lastSyncAt, lastError: row.lastError,
    login: row.status === 'pending' ? {
      qr: row.loginQrToken,
      qrAt: row.loginQrAt,
      needsPassword: row.loginNeedsPassword,
      // Derived, never stored: the worker recorded a rejection AND has since
      // consumed (nulled) the secret, so the form must come back.
      passwordRejected: row.loginNeedsPassword && row.loginSecretCiphertext === null && row.lastError === PASSWORD_REJECTED,
    } : null,
  }
}

// A LIVE row is one with revoked_at IS NULL. The partial unique index allows
// exactly one per channel, so a new attempt must first free the slot: an
// ACTIVE row blocks it outright; a dead one (pending/error) is deleted when it
// holds nothing and revoked when it holds an archive, which is never deleted
// behind the owner's back.
export async function createConnection(channel: Channel): Promise<{ ok: true; id: string } | { ok: false; reason: 'already_connected' }> {
  const live = await db.select({ id: connections.id, status: connections.status })
    .from(connections).where(and(eq(connections.channel, channel), isNull(connections.revokedAt)))

  if (live.some(r => r.status === 'active')) return { ok: false, reason: 'already_connected' }

  for (const row of live) {
    const [chat] = await db.select({ id: chats.id }).from(chats).where(eq(chats.connectionId, row.id)).limit(1)
    if (chat) await revokeConnection(row.id, 'Replaced by a new connection attempt.')
    else await db.delete(connections).where(eq(connections.id, row.id))
  }

  const [row] = await db.insert(connections).values({ channel, status: 'pending' }).returning({ id: connections.id })
  return { ok: true, id: row.id }
}

export async function listConnections(): Promise<ConnectionStatus[]> {
  const rows = await db.select().from(connections)
    .orderBy(desc(connections.createdAt), desc(connections.id))
  return rows.map(toStatus)
}

export async function getConnection(id: string): Promise<ConnectionStatus | null> {
  const [row] = await db.select().from(connections).where(eq(connections.id, id))
  return row ? toStatus(row) : null
}

// Stores the owner's 2FA password encrypted at rest for the worker to consume
// exactly once. Only a still-pending row accepts one.
export async function submitLoginPassword(id: string, password: string): Promise<boolean> {
  const res = await db.update(connections)
    .set({ loginSecretCiphertext: encryptSecret(password), loginSecretAt: new Date(), lastError: null })
    .where(and(eq(connections.id, id), eq(connections.status, 'pending'), isNull(connections.revokedAt)))
    .returning({ id: connections.id })
  return res.length > 0
}

// THE single revoke authority. status, revoked_at, and every secret/login
// column move in one update, so the partial unique index and the status column
// can never disagree. Called by the portal's Disconnect and by the worker when
// the phone kills the session. Nothing else in the repo writes status:'revoked'
// — a structural test enforces that.
export async function revokeConnection(id: string, reason: string): Promise<boolean> {
  const res = await db.update(connections).set({
    status: 'revoked', revokedAt: new Date(), lastError: reason,
    sessionCiphertext: null, loginQrToken: null, loginQrAt: null,
    loginNeedsPassword: false, loginSecretCiphertext: null, loginSecretAt: null,
  }).where(and(eq(connections.id, id), isNull(connections.revokedAt)))
    .returning({ id: connections.id })
  return res.length > 0
}

// Delete everything: revoke first so the session is torn down and the secrets
// are gone even if the delete below fails, then drop the row — chats, messages
// and (from M4) media rows follow by cascade. M2 adds the WhatsApp auth-dir
// removal here; M4 adds unlinking the media files.
export async function deleteConnection(id: string): Promise<boolean> {
  const [row] = await db.select({ id: connections.id }).from(connections).where(eq(connections.id, id))
  if (!row) return false
  await revokeConnection(id, 'Deleted, along with everything it archived.')
  await db.delete(connections).where(eq(connections.id, id))
  return true
}

export async function hasActiveConnection(): Promise<boolean> {
  const [row] = await db.select({ id: connections.id }).from(connections)
    .where(and(eq(connections.status, 'active'), isNull(connections.revokedAt))).limit(1)
  return row !== undefined
}
