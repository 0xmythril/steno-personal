import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { randomUUID } from 'node:crypto'

const now = () => new Date()

// One row per access key. key_hash is the lookup; key_ciphertext exists so
// the owner can reveal the key again from Settings (spec decision 7).
// Revocation is soft (revoked_at) so the list keeps history.
export const accessKeys = sqliteTable('access_keys', {
  id: text('id').primaryKey().$defaultFn(randomUUID),
  label: text('label').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  keyCiphertext: text('key_ciphertext').notNull(),
  // First 8 chars after the prefix, shown in lists so a reader can match a
  // key to an agent config without revealing it.
  prefix: text('prefix').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
  revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
})

// A portal login. Bound to the key that was pasted; resolving a session
// re-checks that the key is still unrevoked, so revoking a key ends its
// sessions on the next request.
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  keyId: text('key_id').notNull().references(() => accessKeys.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
}, t => [index('sessions_key_idx').on(t.keyId)])
