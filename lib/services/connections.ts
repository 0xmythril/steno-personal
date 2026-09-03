import { rm } from 'node:fs/promises'
import path from 'node:path'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { chats, connections, media } from '@/lib/db/schema'
import { encryptSecret, decryptSecret } from '@/lib/services/crypto'
import { mediaFilePath } from '@/lib/services/media'
import { errorShape, log } from '@/lib/log'
import type { Channel } from '@/lib/channels/port'
import { env } from '@/lib/env'

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

// Pure so the race path (two requests both pass the pre-check, then lose the
// insert to the partial unique index) can be unit-tested without contriving
// real concurrency. better-sqlite3 throws with code === 'SQLITE_CONSTRAINT_UNIQUE'
// directly; drizzle may wrap that in a DrizzleQueryError whose .cause carries
// the same code. Anything else is not this race and must propagate.
export function mapInsertError(err: unknown): 'already_connected' | null {
  const code = (err as { code?: unknown; cause?: { code?: unknown } })?.code
  const causeCode = (err as { cause?: { code?: unknown } })?.cause?.code
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || causeCode === 'SQLITE_CONSTRAINT_UNIQUE' ? 'already_connected' : null
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

  try {
    const [row] = await db.insert(connections).values({ channel, status: 'pending' }).returning({ id: connections.id })
    return { ok: true, id: row.id }
  } catch (err) {
    // A concurrent request won the insert between our pre-check and here:
    // the partial unique index caught what the pre-check could not.
    const reason = mapInsertError(err)
    if (reason) return { ok: false, reason }
    throw err
  }
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
// exactly once. Only a still-pending row that has actually asked for a
// password accepts one — otherwise nothing is listening for it on the other
// side, and a stray submit would silently overwrite loginSecretAt for no
// reason.
export async function submitLoginPassword(id: string, password: string): Promise<boolean> {
  const res = await db.update(connections)
    .set({ loginSecretCiphertext: encryptSecret(password), loginSecretAt: new Date(), lastError: null })
    .where(and(
      eq(connections.id, id), eq(connections.status, 'pending'), isNull(connections.revokedAt),
      eq(connections.loginNeedsPassword, true),
    ))
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

// The auth directory name is deterministic: lib/channels/whatsapp.ts derives
// it from the connection id alone (`sessionStringFor`, and SESSION_RE there is
// the source of truth for this shape). It is re-typed rather than imported
// because importing the port would pull the Baileys-naming module into the
// Next.js bundle — nothing outside the worker reaches for it today.
const WA_DIR_RE = /^wa-[A-Za-z0-9._-]+$/
// connections.id is a randomUUID (lib/db/schema.ts), so it can never contain a
// path separator; this says so out loud rather than trusting it.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Every auth directory this connection could own, most likely first.
//
// The id-derived name is the one that matters: session_ciphertext is nulled by
// revokeConnection, and a WhatsApp row reaches delete already revoked on three
// ordinary paths (Disconnect then Delete; a phone-side unlink caught by the
// worker; a login that never finished and never wrote a ciphertext). Deriving
// the name from that column left Signal identity keys — and, on the Disconnect
// path, still-linked device credentials — on the volume forever, with no row
// left naming them.
//
// The decrypted session string is still consulted, as a fallback only, so a
// directory written under some other name by an older build is not orphaned.
function whatsappDirsFor(id: string, sessionCiphertext: string | null): string[] {
  const dirs: string[] = []
  if (UUID_RE.test(id)) dirs.push(`wa-${id}`)
  if (sessionCiphertext) {
    // decryptSecret returns null on a tampered or unreadable payload (M0), so
    // guard the name before it is ever joined to a path.
    const dir = decryptSecret(sessionCiphertext)
    if (dir && WA_DIR_RE.test(dir) && !dirs.includes(dir)) dirs.push(dir)
  }
  return dirs
}

// Removes every auth directory this WhatsApp connection could own. Idempotent
// (`force: true`, so a directory already gone is not an error) and it never
// throws: the worker calls this from inside its tick, where one stubborn
// directory must not stop the other connections converging. The path itself is
// never logged — Node's own fs messages embed it — so only name/code go out.
export async function removeWhatsappAuthDirs(id: string, sessionCiphertext: string | null): Promise<void> {
  for (const dir of whatsappDirsFor(id, sessionCiphertext)) {
    try {
      await rm(path.join(env.DATA_DIR, 'whatsapp', dir), { recursive: true, force: true })
    } catch (err) {
      const { name, code } = errorShape(err)
      log.error({ connectionId: id, err: { name, code } }, 'failed to remove a WhatsApp auth directory')
    }
  }
}

// Revoked WhatsApp rows whose signal keys may still be on the volume. The
// worker sweeps these every tick, which is what makes "Disconnect removes the
// WhatsApp auth files once the worker has run" true even for a Disconnect
// performed while the worker was down. revokeConnection has already nulled
// session_ciphertext by then, so the id-derived name is all there is to go on
// — which is exactly why whatsappDirsFor derives it from the id first.
export async function revokedWhatsappConnectionIds(): Promise<string[]> {
  const rows = await db.select({ id: connections.id }).from(connections)
    .where(and(eq(connections.channel, 'whatsapp'), eq(connections.status, 'revoked')))
  return rows.map(r => r.id)
}

// Delete everything: revoke first so the session is torn down and the secrets
// are gone even if the delete below fails, then drop the row — chats, messages
// and media rows follow by cascade. WhatsApp's auth directory is removed
// after the row is gone.
export async function deleteConnection(id: string): Promise<boolean> {
  const [row] = await db.select({
    id: connections.id,
    channel: connections.channel,
    sessionCiphertext: connections.sessionCiphertext,
  }).from(connections).where(eq(connections.id, id))
  if (!row) return false

  // WhatsApp keeps its signal keys on the volume, not in the database (spec
  // decision 9); deleting a connection must take them with it. The ciphertext
  // is read here because revokeConnection below nulls session_ciphertext.
  const whatsappCiphertext = row.channel === 'whatsapp' ? row.sessionCiphertext : null
  const isWhatsapp = row.channel === 'whatsapp'

  await revokeConnection(id, 'Deleted, along with everything it archived.')

  // The media rows cascade away with the connection row, but the bytes do not.
  // Collect the paths while the rows still exist and unlink them here, so
  // "Delete everything" reaches the volume too — PRIVACY.md promises exactly
  // that. force: true because a file that is already gone (a failed download,
  // a hand-cleaned volume) is not an error. A single stubborn file (a
  // directory somehow written at that path, a permissions problem) must
  // never abort the row delete — the archive is gone either way, and the
  // owner asked for it gone — so every failure is caught and counted rather
  // than thrown. Only name/code from the first failure is logged: Node's own
  // fs error messages (EISDIR, EACCES, ...) embed the absolute path, and
  // errorShape's message passthrough exists for drizzle's query errors, not
  // this — the path itself must never reach the log.
  const files = await db.select({ storagePath: media.storagePath })
    .from(media).where(eq(media.connectionId, id))
  let unlinkFailures = 0
  let firstUnlinkError: unknown = null
  for (const f of files) {
    if (!f.storagePath) continue
    try {
      await rm(mediaFilePath(f.storagePath), { force: true })
    } catch (err) {
      unlinkFailures++
      firstUnlinkError ??= err
    }
  }
  if (unlinkFailures > 0) {
    const { name, code } = errorShape(firstUnlinkError)
    log.error({ connectionId: id, unlinkFailures, err: { name, code } }, 'failed to unlink some media files')
  }

  await db.delete(connections).where(eq(connections.id, id))
  if (isWhatsapp) await removeWhatsappAuthDirs(row.id, whatsappCiphertext)
  return true
}

export async function hasActiveConnection(): Promise<boolean> {
  const [row] = await db.select({ id: connections.id }).from(connections)
    .where(and(eq(connections.status, 'active'), isNull(connections.revokedAt))).limit(1)
  return row !== undefined
}
