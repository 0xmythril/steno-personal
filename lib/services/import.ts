import { z } from 'zod'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { connections } from '@/lib/db/schema'
import { applyDelete, applyEdit, recordMessage, type IncomingMessage } from '@/lib/services/ingest'
import { SOURCE_TYPE_RE } from '@/lib/services/sources'

// The push door's format and its service. One batch names one source and
// carries messages and deletes in the ingest DTO's own field names, so a
// validated entry maps onto IncomingMessage without a translation layer.
// Validation is all-or-nothing; ingest is per message and idempotent, so a
// batch cut off half-way is safe to resend in full.

export const FORMAT = 'steno/1'
export const MAX_BATCH_ITEMS = 1_000
export const MAX_BODY_BYTES = 8 * 1024 * 1024
export const MAX_TEXT_BYTES = 64 * 1024
export const MAX_NAME_BYTES = 1024
export const MAX_ID_BYTES = 256
export const MAX_PROBLEMS = 20
export const MAX_LABEL_LENGTH = 100
const EARLIEST_MS = Date.parse('1990-01-01T00:00:00Z')
const ONE_DAY_MS = 86_400_000

const MESSAGE_TYPES = ['text', 'image', 'video', 'audio', 'document', 'sticker', 'reaction', 'poll', 'location', 'contact', 'system', 'unknown'] as const

const bytes = (max: number) => z.string().refine(s => Buffer.byteLength(s) <= max, { message: `at most ${max} bytes` })
const id = bytes(MAX_ID_BYTES).min(1)
const slug = z.string().regex(SOURCE_TYPE_RE, { message: 'a lowercase slug: ^[a-z][a-z0-9-]{1,31}$' })
const timestamp = z.iso.datetime({ offset: true })
const sentAt = timestamp.refine(iso => {
  const t = Date.parse(iso)
  return t >= EARLIEST_MS && t <= Date.now() + ONE_DAY_MS
}, { message: 'sentAt must be between 1990-01-01 and one day from now' })

const messageSchema = z.object({
  externalChatId: id,
  chatKind: z.enum(['dm', 'group', 'channel']),
  chatTitle: bytes(MAX_NAME_BYTES).nullable().default(null),
  externalMessageId: id,
  senderExternalId: id.nullable().default(null),
  senderName: bytes(MAX_NAME_BYTES).nullable().default(null),
  fromOwner: z.boolean().default(false),
  sentAt,
  type: z.enum(MESSAGE_TYPES).default('text'),
  text: bytes(MAX_TEXT_BYTES).nullable().default(null),
  replyToExternalId: id.nullable().default(null),
  editedAt: timestamp.nullable().default(null),
  raw: z.record(z.string(), z.unknown())
    .refine(r => Buffer.byteLength(JSON.stringify(r)) <= MAX_TEXT_BYTES, { message: `at most ${MAX_TEXT_BYTES} bytes` })
    .optional(),
  // Attachments stay at the source in this version: steno never fetches a
  // URL, and bytes inside a batch are not accepted yet. z.undefined({ error })
  // alone rejects an absent key too (it means "must be present and
  // undefined", not "may be absent"), so absence is allowed explicitly and
  // only a present value is refused, by name, in the message an entry sees.
  media: z.unknown().optional().refine(v => v === undefined, { message: 'media_not_supported' }),
})

const deleteSchema = z.object({ externalChatId: id, externalMessageId: id })

export const batchSchema = z.object({
  format: z.literal(FORMAT),
  source: z.object({ type: slug, id: slug, label: z.string().trim().min(1).max(MAX_LABEL_LENGTH) }),
  messages: z.array(messageSchema).max(MAX_BATCH_ITEMS).default([]),
  deletes: z.array(deleteSchema).max(MAX_BATCH_ITEMS).default([]),
})

export type Batch = z.infer<typeof batchSchema>
export type ImportProblem = { index: number | null; path: string; reason: string }
export type ImportResult = { source: { id: string }; inserted: number; duplicates: number; edited: number; deleted: number }

export function parseBatch(input: unknown): { ok: true; batch: Batch } | { ok: false; problems: ImportProblem[] } {
  const r = batchSchema.safeParse(input)
  if (r.success) return { ok: true, batch: r.data }
  const problems = r.error.issues.slice(0, MAX_PROBLEMS).map(i => ({
    index: i.path.length >= 2 && typeof i.path[1] === 'number' ? i.path[1] : null,
    path: i.path.map(String).join('.'),
    reason: i.message,
  }))
  return { ok: false, problems }
}

// One row per (type, id) among live pushed sources — connections_push_source
// makes that unique — so the second batch for a source finds the first's row
// and only refreshes the label. The select-or-insert runs in one immediate
// transaction so two pushers racing for the same (type, id) cannot both pass
// the select and both insert — the second would throw on the partial unique
// index instead of finding the first's row.
async function upsertSource(keyId: string, source: Batch['source']): Promise<string> {
  return db.transaction((tx): string => {
    const existing = tx.select({ id: connections.id }).from(connections)
      .where(and(
        eq(connections.mode, 'push'), eq(connections.channel, source.type),
        eq(connections.externalAccountId, source.id), isNull(connections.revokedAt),
      )).get()
    if (existing) {
      tx.update(connections).set({ displayName: source.label }).where(eq(connections.id, existing.id)).run()
      return existing.id
    }
    return tx.insert(connections).values({
      channel: source.type, mode: 'push', status: 'active', purpose: 'archive',
      externalAccountId: source.id, displayName: source.label, pushKeyId: keyId,
    }).returning({ id: connections.id }).get().id
  }, { behavior: 'immediate' })
}

function toIncoming(m: Batch['messages'][number]): IncomingMessage {
  return {
    externalChatId: m.externalChatId, chatKind: m.chatKind, chatTitle: m.chatTitle,
    externalMessageId: m.externalMessageId, senderExternalId: m.senderExternalId, senderName: m.senderName,
    fromOwner: m.fromOwner, sentAt: new Date(m.sentAt), type: m.type, text: m.text,
    media: null, replyToExternalId: m.replyToExternalId,
    // Every other batch field already has its own column, so this fallback
    // (rather than the batch's real raw payload) loses nothing and does not
    // duplicate the entry's own fields into raw a second time.
    raw: m.raw ?? { externalMessageId: m.externalMessageId, sentAt: m.sentAt },
  }
}

export async function importBatch(keyId: string, batch: Batch): Promise<ImportResult> {
  const sourceId = await upsertSource(keyId, batch.source)
  let inserted = 0, duplicates = 0, edited = 0, deleted = 0
  for (const m of batch.messages) {
    const dto = toIncoming(m)
    const res = await recordMessage(sourceId, batch.source.type, dto)
    if (res.inserted) { inserted++; continue }
    duplicates++
    // A known message resent with editedAt is an edit; without it, a replay.
    // A fresh insert already carries the edited text, so it is not counted
    // twice. No actor: the source vouches for its own edits.
    if (m.editedAt) { await applyEdit(sourceId, batch.source.type, dto); edited++ }
  }
  for (const d of batch.deletes) {
    deleted += await applyDelete(sourceId, { externalChatId: d.externalChatId, externalMessageId: d.externalMessageId })
  }
  await db.update(connections).set({ lastSyncAt: new Date() }).where(eq(connections.id, sourceId))
  return { source: { id: sourceId }, inserted, duplicates, edited, deleted }
}
