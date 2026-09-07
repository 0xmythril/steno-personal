import { db } from '@/lib/db/client'
import { track } from '@/lib/services/telemetry'
import { accessKeys, chats, connections, messages } from '@/lib/db/schema'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { createHash, randomBytes } from 'node:crypto'
import { decryptSecret, encryptSecret } from './crypto'
import { deleteConnection } from '@/lib/services/connections'

export const KEY_PREFIX = 'sp_'
export const MAX_LABEL_LENGTH = 100
export type KeyCapability = 'read' | 'push'
export type KeyCapabilities = { read: boolean; push: boolean }
const PREFIX_SHOWN = 8

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export type MintResult =
  | { ok: true; id: string; rawKey: string }
  | { ok: false; reason: 'label_empty' | 'label_too_long' | 'not_first' | 'no_capability' }

function newKeyRow(label: string, caps: KeyCapabilities) {
  const rawKey = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`
  return {
    rawKey,
    values: {
      label,
      canRead: caps.read,
      canPush: caps.push,
      keyHash: sha256(rawKey),
      keyCiphertext: encryptSecret(rawKey),
      prefix: rawKey.slice(KEY_PREFIX.length, KEY_PREFIX.length + PREFIX_SHOWN),
    },
  }
}

function checkLabel(label: string): { ok: true; label: string } | { ok: false; reason: 'label_empty' | 'label_too_long' } {
  const trimmed = label.trim()
  if (!trimmed) return { ok: false, reason: 'label_empty' }
  if (trimmed.length > MAX_LABEL_LENGTH) return { ok: false, reason: 'label_too_long' }
  return { ok: true, label: trimmed }
}

// The raw key is returned exactly once here; afterwards it is reachable only
// through revealAccessKey (decrypting the ciphertext). There is no cap on the
// number of keys: one user, their own devices.
export async function mintAccessKey(label: string, caps: KeyCapabilities = { read: true, push: false }): Promise<MintResult> {
  const checked = checkLabel(label)
  if (!checked.ok) return checked
  if (!caps.read && !caps.push) return { ok: false, reason: 'no_capability' }
  const { rawKey, values } = newKeyRow(checked.label, caps)
  const [row] = await db.insert(accessKeys).values(values).returning({ id: accessKeys.id })
  // That a key was made. Never its label, prefix or value.
  track('access_key_minted', {})
  return { ok: true, id: row.id, rawKey }
}

// The first key ever: what closes /setup. The "no key exists yet" check and
// the insert run inside one write transaction, so two finish requests racing
// through the fresh-instance guard cannot both mint — the second sees a row
// and gets 'not_first'. Revoked rows count: once a key has existed the
// instance is no longer fresh (see hasAnyAccessKey).
export async function mintFirstAccessKey(label: string): Promise<MintResult> {
  const checked = checkLabel(label)
  if (!checked.ok) return checked
  const { rawKey, values } = newKeyRow(checked.label, { read: true, push: false })
  const row = db.transaction(tx => {
    const existing = tx.select({ id: accessKeys.id }).from(accessKeys).limit(1).all()
    if (existing.length > 0) return null
    return tx.insert(accessKeys).values(values).returning({ id: accessKeys.id }).get()
  }, { behavior: 'immediate' })
  if (!row) return { ok: false, reason: 'not_first' }
  track('access_key_minted', {})
  return { ok: true, id: row.id, rawKey }
}

// Shared by the portal login, the MCP bearer check and the import door. The
// caller says which capability it is a door for, and a key without it is no
// key at all here: a push-only key cannot read, a read-only key cannot push,
// and a refusal leaves last_used_at alone because nothing was used.
export async function verifyAccessKey(rawKey: string, need: KeyCapability): Promise<{ id: string; label: string; canRead: boolean; canPush: boolean } | null> {
  if (!rawKey.startsWith(KEY_PREFIX)) return null
  const capCheck = need === 'read' ? eq(accessKeys.canRead, true) : eq(accessKeys.canPush, true)
  const [row] = await db.select({ id: accessKeys.id, label: accessKeys.label, canRead: accessKeys.canRead, canPush: accessKeys.canPush })
    .from(accessKeys)
    .where(and(eq(accessKeys.keyHash, sha256(rawKey)), capCheck, isNull(accessKeys.revokedAt)))
  if (!row) return null
  await db.update(accessKeys).set({ lastUsedAt: new Date() }).where(eq(accessKeys.id, row.id))
  return row
}

// Selects only what the page shows — never the hash or ciphertext.
export async function listActiveAccessKeys() {
  return db.select({
    id: accessKeys.id, label: accessKeys.label, canRead: accessKeys.canRead, canPush: accessKeys.canPush, prefix: accessKeys.prefix,
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

// How many live (undeleted) messages this key has pushed. What the Settings
// page names in the revoke-and-purge confirm before the owner commits to it.
export async function messagesPushedByKey(keyId: string): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(messages)
    .where(and(eq(messages.pushKeyId, keyId), isNull(messages.deletedAt)))
  return Number(row?.n ?? 0)
}

// Revoke a push key and take its pushes with it. The messages it delivered
// are a real delete — the messages_ad trigger prunes the FTS index the same
// way it does for any other row deletion — not the deleted_at tombstone the
// import door uses for dedupe; a revoked key's text must actually be gone,
// not just hidden from reads. Any pushed source that consequently holds no
// live message at all is removed the same way "Delete everything" removes
// one, through deleteConnection, so revoked_at and the row's existence never
// disagree about whether a source is still there.
export async function revokeAccessKeyAndPurge(id: string): Promise<{ revoked: boolean; messagesDeleted: number; sourcesDeleted: number }> {
  const revoked = await revokeAccessKey(id)
  const deletedRows = await db.delete(messages).where(eq(messages.pushKeyId, id)).returning({ id: messages.id })
  const messagesDeleted = deletedRows.length

  const pushSources = await db.select({ id: connections.id }).from(connections)
    .where(and(eq(connections.mode, 'push'), isNull(connections.revokedAt)))
  let sourcesDeleted = 0
  for (const source of pushSources) {
    const [{ n }] = await db.select({ n: sql<number>`count(*)` })
      .from(messages).innerJoin(chats, eq(chats.id, messages.chatId))
      .where(and(eq(chats.connectionId, source.id), isNull(messages.deletedAt)))
    if (Number(n) === 0) {
      await deleteConnection(source.id)
      sourcesDeleted++
    }
  }
  return { revoked, messagesDeleted, sourcesDeleted }
}

export async function revokeAllAccessKeys(): Promise<number> {
  const res = await db.update(accessKeys).set({ revokedAt: new Date() })
    .where(isNull(accessKeys.revokedAt)).returning({ id: accessKeys.id })
  return res.length
}
