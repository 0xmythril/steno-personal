import { db } from '@/lib/db/client'
import { accessKeys, passkeys, sessions } from '@/lib/db/schema'
import { and, eq, gt, isNotNull, isNull, lt, or } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'

export const SESSION_TTL_MS = 30 * 86_400_000
// Extend at most once a day so a busy portal does not write on every request.
const SLIDE_AFTER_MS = 86_400_000

// Exactly one of the two: the key that was pasted, or the passkey that signed.
export type SessionCredential = { keyId: string } | { passkeyId: string }
export type ResolvedSession = {
  sessionId: string; via: 'key' | 'passkey'; keyId: string | null; passkeyId: string | null; label: string
}

export async function createSession(credential: SessionCredential, now: Date = new Date()): Promise<string> {
  const id = randomBytes(32).toString('base64url')
  await db.insert(sessions).values({
    id,
    keyId: 'keyId' in credential ? credential.keyId : null,
    passkeyId: 'passkeyId' in credential ? credential.passkeyId : null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  })
  return id
}

// Joins the bound credential so revoking it ends its sessions on the next
// request. Left joins, because a session has one of the two, and the WHERE
// insists that the one it has is still live.
export async function resolveSession(id: string, now: Date = new Date()): Promise<ResolvedSession | null> {
  const [row] = await db.select({
    sessionId: sessions.id, keyId: sessions.keyId, passkeyId: sessions.passkeyId, expiresAt: sessions.expiresAt,
    keyLabel: accessKeys.label, passkeyLabel: passkeys.label,
  })
    .from(sessions)
    .leftJoin(accessKeys, eq(sessions.keyId, accessKeys.id))
    .leftJoin(passkeys, eq(sessions.passkeyId, passkeys.id))
    .where(and(
      eq(sessions.id, id),
      gt(sessions.expiresAt, now),
      or(
        and(isNotNull(sessions.keyId), isNull(accessKeys.revokedAt)),
        and(isNotNull(sessions.passkeyId), isNull(passkeys.revokedAt)),
      ),
    ))
  if (!row) return null
  const remaining = row.expiresAt.getTime() - now.getTime()
  if (SESSION_TTL_MS - remaining > SLIDE_AFTER_MS) {
    await db.update(sessions).set({ expiresAt: new Date(now.getTime() + SESSION_TTL_MS) }).where(eq(sessions.id, id))
  }
  const via = row.keyId ? 'key' : 'passkey'
  return {
    sessionId: row.sessionId, via, keyId: row.keyId, passkeyId: row.passkeyId,
    label: (via === 'key' ? row.keyLabel : row.passkeyLabel) ?? '',
  }
}

export async function deleteSession(id: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id))
}

export async function purgeExpiredSessions(now: Date = new Date()): Promise<number> {
  const res = await db.delete(sessions).where(lt(sessions.expiresAt, now)).returning({ id: sessions.id })
  return res.length
}
