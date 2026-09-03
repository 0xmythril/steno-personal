import { db } from '@/lib/db/client'
import { passkeys } from '@/lib/db/schema'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { MAX_LABEL_LENGTH } from './access-keys'

// Rows only. Everything WebAuthn — options, verification, the relying party —
// lives in lib/services/webauthn.ts, the one importer of the library.

export type StoredPasskey = {
  id: string; label: string; credentialId: string; publicKey: string; counter: number; transports: string[] | null
}
export type NewPasskey = {
  label: string; credentialId: string; publicKey: string; counter: number; transports?: string[]; backedUp: boolean
}
export type SaveResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'label_empty' | 'label_too_long' | 'duplicate' }

export async function savePasskey(input: NewPasskey): Promise<SaveResult> {
  const label = input.label.trim()
  if (!label) return { ok: false, reason: 'label_empty' }
  if (label.length > MAX_LABEL_LENGTH) return { ok: false, reason: 'label_too_long' }
  // credential_id is unique across revoked rows too: a credential id is
  // minted by the authenticator per registration, so a repeat is a replay.
  const [dup] = await db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.credentialId, input.credentialId))
  if (dup) return { ok: false, reason: 'duplicate' }
  const [row] = await db.insert(passkeys).values({
    label, credentialId: input.credentialId, publicKey: input.publicKey, counter: input.counter,
    transports: input.transports ?? null, backedUp: input.backedUp,
  }).returning({ id: passkeys.id })
  return { ok: true, id: row.id }
}

export async function findActivePasskeyByCredentialId(credentialId: string): Promise<StoredPasskey | null> {
  const [row] = await db.select({
    id: passkeys.id, label: passkeys.label, credentialId: passkeys.credentialId,
    publicKey: passkeys.publicKey, counter: passkeys.counter, transports: passkeys.transports,
  }).from(passkeys).where(and(eq(passkeys.credentialId, credentialId), isNull(passkeys.revokedAt)))
  return row ? { ...row, transports: row.transports ?? null } : null
}

export async function recordPasskeyUse(id: string, newCounter: number): Promise<void> {
  await db.update(passkeys).set({ counter: newCounter, lastUsedAt: new Date() }).where(eq(passkeys.id, id))
}

// Selects only what the page shows — never the public key.
export async function listActivePasskeys() {
  return db.select({
    id: passkeys.id, label: passkeys.label, backedUp: passkeys.backedUp,
    createdAt: passkeys.createdAt, lastUsedAt: passkeys.lastUsedAt,
  }).from(passkeys).where(isNull(passkeys.revokedAt)).orderBy(desc(passkeys.createdAt), desc(passkeys.id))
}

// For excludeCredentials: an authenticator that already holds one of these
// is refused a second registration instead of silently replacing the first.
export async function listActiveCredentials(): Promise<{ id: string; transports?: string[] }[]> {
  const rows = await db.select({ id: passkeys.credentialId, transports: passkeys.transports })
    .from(passkeys).where(isNull(passkeys.revokedAt))
  return rows.map(r => (r.transports ? { id: r.id, transports: r.transports } : { id: r.id }))
}

export async function countActivePasskeys(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(passkeys).where(isNull(passkeys.revokedAt))
  return Number(row?.n ?? 0)
}

export async function revokePasskey(id: string): Promise<boolean> {
  const res = await db.update(passkeys).set({ revokedAt: new Date() })
    .where(and(eq(passkeys.id, id), isNull(passkeys.revokedAt))).returning({ id: passkeys.id })
  return res.length > 0
}

export async function revokeAllPasskeys(): Promise<number> {
  const res = await db.update(passkeys).set({ revokedAt: new Date() })
    .where(isNull(passkeys.revokedAt)).returning({ id: passkeys.id })
  return res.length
}
