import { sqliteTable, text, integer, real, index, uniqueIndex, primaryKey, check } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
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

// One row per passkey (WebAuthn discoverable credential). A passkey logs
// into the portal only — never a bearer token for the MCP route. The public
// key is not a secret, so it is stored plain (base64url of the COSE bytes).
// Revocation is soft (revoked_at) so the list keeps history, as for keys.
export const passkeys = sqliteTable('passkeys', {
  id: text('id').primaryKey().$defaultFn(randomUUID),
  label: text('label').notNull(),
  credentialId: text('credential_id').notNull().unique(),
  publicKey: text('public_key').notNull(),
  counter: integer('counter').notNull().default(0),
  transports: text('transports', { mode: 'json' }).$type<string[]>(),
  backedUp: integer('backed_up', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
  revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
})

// A portal login. Bound to exactly one credential — the key that was pasted
// or the passkey that signed — and resolving a session re-checks that the
// credential is still unrevoked, so revoking either ends its sessions on the
// next request.
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  keyId: text('key_id').references(() => accessKeys.id, { onDelete: 'cascade' }),
  passkeyId: text('passkey_id').references(() => passkeys.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
}, t => [
  index('sessions_key_idx').on(t.keyId),
  index('sessions_passkey_idx').on(t.passkeyId),
  check('sessions_one_credential', sql`(${t.keyId} IS NULL) <> (${t.passkeyId} IS NULL)`),
])

// One row per connection attempt on one channel. A row is LIVE while
// revoked_at IS NULL; the partial unique index below allows exactly one live
// row per (channel, purpose), which is what "one person, one account per
// channel" means with no users table. Revoked rows are kept: the archive they
// produced outlives the session that produced it.
//
// purpose: 'archive' is the connection that reads the account; 'recovery' is a
// pair-again attempt that only proves the owner still holds the same account
// (lib/services/recovery.ts). A recovery row never becomes active, never
// stores a session, and never owns a chat; it ends revoked with an outcome.
export const connections = sqliteTable('connections', {
  id: text('id').primaryKey().$defaultFn(randomUUID),
  channel: text('channel', { enum: ['telegram', 'whatsapp'] }).notNull(),
  purpose: text('purpose', { enum: ['archive', 'recovery'] }).notNull().default('archive'),
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
  // Recovery rows only. The key is minted by the worker at match time and
  // claimed exactly once by the browser that started the attempt, which nulls
  // recovery_key_id so it cannot be handed out twice.
  recoveryOutcome: text('recovery_outcome', { enum: ['matched', 'mismatched'] }),
  recoveryKeyId: text('recovery_key_id').references(() => accessKeys.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
  revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
  lastSyncAt: integer('last_sync_at', { mode: 'timestamp_ms' }),
}, t => [
  uniqueIndex('connections_live_channel_purpose').on(t.channel, t.purpose).where(sql`revoked_at IS NULL`),
])

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
// `confidence` is the model's own 0–1 estimate of its reading, kept so a
// shaky transcript can be shown as shaky rather than as fact.
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
  // Anonymous usage events (lib/services/telemetry.ts). On by default,
  // turned off from Settings or with DO_NOT_TRACK. The instance id is minted
  // on the first event and is random — not derived from the key, the volume,
  // the account or the machine — so it links one instance's events to each
  // other and to nothing else.
  telemetryEnabled: integer('telemetry_enabled', { mode: 'boolean' }).notNull().default(true),
  telemetryInstanceId: text('telemetry_instance_id'),
})

// The address book. A person is the owner's own annotation over the channel
// identities the archive already stores — nothing here is fetched from, or
// pushed back to, a channel. Deleting a person touches no chat or message
// (people design decision 7).
//
// name_source is who chose the name: 'channel' means it was copied from a
// contact list and a later sync may refresh it, 'owner' means the owner typed
// it and no sync ever overwrites it (decision 13). archived_at is what
// "delete" now does (decision 14): the person disappears from every listing,
// from every read path and from every agent, but keeps its identity rows so
// the populater never offers to create them again.
export const people = sqliteTable('people', {
  id: text('id').primaryKey().$defaultFn(randomUUID),
  name: text('name').notNull(),
  notes: text('notes'),
  nameSource: text('name_source', { enum: ['channel', 'owner'] }).notNull().default('channel'),
  archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
}, t => [index('people_archived_idx').on(t.archivedAt)])

// One channel identity belongs to at most one person: unique(channel,
// external_id) is what makes "who is this?" a single-row answer on every read
// path, and what makes a second link attempt an `already_linked` rather than a
// silent duplicate. `source` records how the link was made — a suggestion
// never links on its own, so 'phone_match'/'name_match' mean "the owner
// confirmed a suggestion of that kind", not "the machine decided". 'auto' is
// the one source the machine does write by itself (decision 11): a contact or
// a DM counterparty with a name and no person yet gets one, which is a
// bookkeeping entry over what the archive already holds, not a guess about
// who is who — the only guess, matching two channels to one person, still
// needs an equal phone number (decision 12) or the owner's yes.
// Deliberately NOT tied to a connection: reconnecting an account must not
// erase the owner's address book.
export const personIdentities = sqliteTable('person_identities', {
  id: text('id').primaryKey().$defaultFn(randomUUID),
  personId: text('person_id').notNull().references(() => people.id, { onDelete: 'cascade' }),
  channel: text('channel', { enum: ['telegram', 'whatsapp'] }).notNull(),
  externalId: text('external_id').notNull(),
  displayName: text('display_name'),
  phone: text('phone'),
  source: text('source', { enum: ['manual', 'phone_match', 'name_match', 'auto'] }).notNull().default('manual'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
}, t => [
  uniqueIndex('person_identities_channel_external_unique').on(t.channel, t.externalId),
  index('person_identities_person_idx').on(t.personId),
])

// A cache of what the channel already told us about the owner's own contacts,
// refreshed by the worker. It exists so a phone number can be matched offline
// and so a candidate list can show a name for someone who has not written a
// message yet. It belongs to the connection that read it: disconnecting the
// account drops the cache, while the person links above survive.
export const channelContacts = sqliteTable('channel_contacts', {
  id: text('id').primaryKey().$defaultFn(randomUUID),
  connectionId: text('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  channel: text('channel', { enum: ['telegram', 'whatsapp'] }).notNull(),
  externalId: text('external_id').notNull(),
  displayName: text('display_name'),
  phone: text('phone'),
  syncedAt: integer('synced_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
}, t => [
  uniqueIndex('channel_contacts_connection_external_unique').on(t.connectionId, t.externalId),
  index('channel_contacts_channel_external_idx').on(t.channel, t.externalId),
])

// "No, those two are not the same person." Suggestions themselves are
// computed, never stored, so this table is the only memory the matcher has —
// without it a dismissed pair would come back on the next page load. The pair
// itself is the key; there is nothing else to say about it.
export const dismissedSuggestions = sqliteTable('dismissed_suggestions', {
  telegramExternalId: text('telegram_external_id').notNull(),
  whatsappExternalId: text('whatsapp_external_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(now),
}, t => [primaryKey({ columns: [t.telegramExternalId, t.whatsappExternalId] })])
