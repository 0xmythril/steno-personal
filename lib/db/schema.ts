import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core'
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

// One row per connection attempt on one channel. A row is LIVE while
// revoked_at IS NULL; the partial unique index in 0001_channels.sql allows
// exactly one live row per channel, which is what "one person, one account
// per channel" means with no users table. Revoked rows are kept: the archive
// they produced outlives the session that produced it.
export const connections = sqliteTable('connections', {
  id: text('id').primaryKey().$defaultFn(randomUUID),
  channel: text('channel', { enum: ['telegram', 'whatsapp'] }).notNull(),
  status: text('status', { enum: ['pending', 'active', 'revoked', 'error'] }).notNull().default('pending'),
  externalAccountId: text('external_account_id'),
  displayName: text('display_name'),
  // AES-GCM. Telegram: the mtcute session string. WhatsApp (M2): the auth
  // directory name — encrypted too, so the column means exactly one thing.
  sessionCiphertext: text('session_ciphertext'),
  loginQrToken: text('login_qr_token'),
  loginQrAt: integer('login_qr_at', { mode: 'timestamp_ms' }),
  loginNeedsPassword: integer('login_needs_password', { mode: 'boolean' }).notNull().default(false),
  loginSecretCiphertext: text('login_secret_ciphertext'),
  loginSecretAt: integer('login_secret_at', { mode: 'timestamp_ms' }),
  lastError: text('last_error'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
  revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
  lastSyncAt: integer('last_sync_at', { mode: 'timestamp_ms' }),
})

export const chats = sqliteTable('chats', {
  id: text('id').primaryKey().$defaultFn(randomUUID),
  connectionId: text('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  channel: text('channel', { enum: ['telegram', 'whatsapp'] }).notNull(),
  externalChatId: text('external_chat_id').notNull(),
  kind: text('kind', { enum: ['dm', 'group', 'channel'] }).notNull(),
  title: text('title'),
  lastMessageAt: integer('last_message_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
}, t => [uniqueIndex('chats_connection_chat_unique').on(t.connectionId, t.externalChatId)])

// Message identity is (chat_id, external_message_id), first-writer-wins: a
// backfill that replays what live ingest already stored is a no-op. deleted_at
// is a tombstone kept for dedupe only — no read path ever returns the row.
export const messages = sqliteTable('messages', {
  id: text('id').primaryKey().$defaultFn(randomUUID),
  chatId: text('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
  externalMessageId: text('external_message_id').notNull(),
  senderExternalId: text('sender_external_id'),
  senderName: text('sender_name'),
  fromOwner: integer('from_owner', { mode: 'boolean' }).notNull().default(false),
  sentAt: integer('sent_at', { mode: 'timestamp_ms' }).notNull(),
  type: text('type', { enum: ['text', 'image', 'video', 'audio', 'document', 'sticker', 'system', 'unknown'] }).notNull(),
  text: text('text'),
  hasMedia: integer('has_media', { mode: 'boolean' }).notNull().default(false),
  editedAt: integer('edited_at', { mode: 'timestamp_ms' }),
  deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  raw: text('raw', { mode: 'json' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
}, t => [
  uniqueIndex('messages_external_unique').on(t.chatId, t.externalMessageId),
  index('messages_chat_sent_idx').on(t.chatId, t.sentAt),
])

// Downloaded attachment bytes, one row per message that carries one. Queued
// by ingest (status 'pending'), drained by the worker into DATA_DIR/media.
// connection_id is denormalized from the message's chat so the drain can pick
// the right live session's downloader without a three-table join, and so
// deleting a connection cascades its files' rows directly.
export const media = sqliteTable('media', {
  id: text('id').primaryKey().$defaultFn(randomUUID),
  messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  connectionId: text('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  mimeType: text('mime_type'),
  sizeBytes: integer('size_bytes'),
  storagePath: text('storage_path'),          // relative to DATA_DIR/media
  status: text('status', { enum: ['pending', 'done', 'failed'] }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  isVoiceNote: integer('is_voice_note', { mode: 'boolean' }),
  durationSeconds: integer('duration_seconds'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
}, t => [index('media_message_idx').on(t.messageId), index('media_status_idx').on(t.status)])

// Queue + result for one enriched attachment. A table of its own rather than
// columns on `media`: media rows belong to the download drain and have their
// own status/attempts lifecycle, and "re-analyze" is "delete this row".
// `confidence` is spec 4.4; the shared-interfaces block omits it, and the
// spec wins.
export const mediaAnalysis = sqliteTable('media_analysis', {
  id: text('id').primaryKey().$defaultFn(randomUUID),
  mediaId: text('media_id').notNull().unique().references(() => media.id, { onDelete: 'cascade' }),
  medium: text('medium', { enum: ['image', 'audio'] }).notNull(),
  status: text('status', { enum: ['pending', 'done', 'failed', 'skipped'] }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  extractedText: text('extracted_text'),
  description: text('description'),
  kind: text('kind'),
  confidence: real('confidence'),
  language: text('language'),
  // The catalog id that actually produced the row, written at completion —
  // the truth even if the model was switched while the row sat in the queue.
  model: text('model'),
  // Integer micro-dollars: OpenRouter's own usage.cost when it reports one,
  // the catalog estimate otherwise. Money never floats.
  costMicroUsd: integer('cost_microusd'),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
  completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
}, t => [index('media_analysis_status_idx').on(t.status)])

// Exactly one row, id = 1, seeded by the migration. No users table, so this
// is the whole of "the user's preferences".
export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey(),
  openrouterKeyCiphertext: text('openrouter_key_ciphertext'),
  analyzeImages: integer('analyze_images', { mode: 'boolean' }).notNull().default(false),
  analyzeAudio: integer('analyze_audio', { mode: 'boolean' }).notNull().default(false),
  visionModel: text('vision_model'),
  transcriptionModel: text('transcription_model'),
})
