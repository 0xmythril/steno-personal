import { db } from '@/lib/db/client'
import { accessKeys, sessions } from '@/lib/db/schema'
import { and, eq, gt, isNull, lt } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'

export const SESSION_TTL_MS = 30 * 86_400_000
// Extend at most once a day so a busy portal does not write on every request.
const SLIDE_AFTER_MS = 86_400_000

export async function createSession(keyId: string, now: Date = new Date()): Promise<string> {
  const id = randomBytes(32).toString('base64url')
  await db.insert(sessions).values({ id, keyId, createdAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) })
  return id
}

// Joins the key so a revoked key ends its sessions on the next request.
export async function resolveSession(id: string, now: Date = new Date()) {
  const [row] = await db.select({ sessionId: sessions.id, keyId: sessions.keyId, label: accessKeys.label, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(accessKeys, eq(sessions.keyId, accessKeys.id))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, now), isNull(accessKeys.revokedAt)))
  if (!row) return null
  const remaining = row.expiresAt.getTime() - now.getTime()
  if (SESSION_TTL_MS - remaining > SLIDE_AFTER_MS) {
    await db.update(sessions).set({ expiresAt: new Date(now.getTime() + SESSION_TTL_MS) }).where(eq(sessions.id, id))
  }
  return { sessionId: row.sessionId, keyId: row.keyId, label: row.label }
}

export async function deleteSession(id: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id))
}

export async function purgeExpiredSessions(now: Date = new Date()): Promise<number> {
  const res = await db.delete(sessions).where(lt(sessions.expiresAt, now)).returning({ id: sessions.id })
  return res.length
}
