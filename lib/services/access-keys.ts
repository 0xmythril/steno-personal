import { db } from '@/lib/db/client'
import { track } from '@/lib/services/telemetry'
import { accessKeys } from '@/lib/db/schema'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { createHash, randomBytes } from 'node:crypto'
import { decryptSecret, encryptSecret } from './crypto'

export const KEY_PREFIX = 'sp_'
export const MAX_LABEL_LENGTH = 100
const PREFIX_SHOWN = 8

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export type MintResult =
  | { ok: true; id: string; rawKey: string }
  | { ok: false; reason: 'label_empty' | 'label_too_long' }

// The raw key is returned exactly once here; afterwards it is reachable only
// through revealAccessKey (decrypting the ciphertext). There is no cap on the
// number of keys: one user, their own devices.
export async function mintAccessKey(label: string): Promise<MintResult> {
  const trimmed = label.trim()
  if (!trimmed) return { ok: false, reason: 'label_empty' }
  if (trimmed.length > MAX_LABEL_LENGTH) return { ok: false, reason: 'label_too_long' }
  const rawKey = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`
  const [row] = await db.insert(accessKeys).values({
    label: trimmed,
    keyHash: sha256(rawKey),
    keyCiphertext: encryptSecret(rawKey),
    prefix: rawKey.slice(KEY_PREFIX.length, KEY_PREFIX.length + PREFIX_SHOWN),
  }).returning({ id: accessKeys.id })
  // That a key was made. Never its label, prefix or value.
  track('access_key_minted', {})
  return { ok: true, id: row.id, rawKey }
}

// Shared by the portal login and (M3) the MCP bearer check.
export async function verifyAccessKey(rawKey: string): Promise<{ id: string; label: string } | null> {
  if (!rawKey.startsWith(KEY_PREFIX)) return null
  const [row] = await db.select({ id: accessKeys.id, label: accessKeys.label })
    .from(accessKeys)
    .where(and(eq(accessKeys.keyHash, sha256(rawKey)), isNull(accessKeys.revokedAt)))
  if (!row) return null
  await db.update(accessKeys).set({ lastUsedAt: new Date() }).where(eq(accessKeys.id, row.id))
  return row
}

// Selects only what the page shows — never the hash or ciphertext.
export async function listActiveAccessKeys() {
  return db.select({
    id: accessKeys.id, label: accessKeys.label, prefix: accessKeys.prefix,
    createdAt: accessKeys.createdAt, lastUsedAt: accessKeys.lastUsedAt,
  }).from(accessKeys)
    .where(isNull(accessKeys.revokedAt))
    .orderBy(desc(accessKeys.createdAt), desc(accessKeys.id))
}

// Whether ANY key row exists, revoked ones included. False means the instance
// is fresh — nobody has ever been let in — which is what opens /setup to the
// first visitor and nothing else: once a key has existed, even a revoked one,
// the only ways back in are a key, recovery, or the host (docs/self-hosting.md).
export async function hasAnyAccessKey(): Promise<boolean> {
  const [row] = await db.select({ id: accessKeys.id }).from(accessKeys).limit(1)
  return row !== undefined
}

export async function countActiveAccessKeys(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(accessKeys).where(isNull(accessKeys.revokedAt))
  return Number(row?.n ?? 0)
}

// Null for an unknown, revoked, or undecryptable key (SECRET_KEY changed).
export async function revealAccessKey(id: string): Promise<string | null> {
  const [row] = await db.select({ keyCiphertext: accessKeys.keyCiphertext })
    .from(accessKeys).where(and(eq(accessKeys.id, id), isNull(accessKeys.revokedAt)))
  return row ? decryptSecret(row.keyCiphertext) : null
}

export async function revokeAccessKey(id: string): Promise<boolean> {
  const res = await db.update(accessKeys).set({ revokedAt: new Date() })
    .where(and(eq(accessKeys.id, id), isNull(accessKeys.revokedAt))).returning({ id: accessKeys.id })
  return res.length > 0
}

export async function revokeAllAccessKeys(): Promise<number> {
  const res = await db.update(accessKeys).set({ revokedAt: new Date() })
    .where(isNull(accessKeys.revokedAt)).returning({ id: accessKeys.id })
  return res.length
}
