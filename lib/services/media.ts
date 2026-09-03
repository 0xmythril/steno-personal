import { db } from '@/lib/db/client'
import { media, messages } from '@/lib/db/schema'
import { env } from '@/lib/env'
import type { IncomingMessage } from '@/lib/services/ingest'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// One media payload is buffered whole — by the worker's download and by the
// portal's read — so an unbounded one OOMs the process. 100 MiB sits above any
// real image, video, or document and bounds the blast radius of a hostile one.
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024

// Only the types we actually store get a real extension; everything else is
// `.bin`, which is also what the media route refuses to serve inline.
const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a', 'audio/wav': 'wav', 'application/pdf': 'pdf',
}

export function extForMime(mime: string | null): string {
  if (!mime) return 'bin'
  return EXT[mime.split(';')[0].trim().toLowerCase()] ?? 'bin'
}

export function mediaDir(): string {
  return path.join(env.DATA_DIR, 'media')
}

// storage_path is stored RELATIVE to DATA_DIR/media so the database survives
// the volume being mounted somewhere else. This is the only place the two
// halves are joined. storagePath is always server-generated (`${id}.${ext}`,
// never a sender-controlled string), but this is the one chokepoint every
// caller — the drain's own write, the route's read, deleteConnection's
// unlink — goes through, so it refuses anything shaped like an escape
// (a separator, `..`) outright, and re-checks the resolved path actually
// lands inside DATA_DIR/media before ever touching the filesystem with it.
export function mediaFilePath(storagePath: string): string {
  if (/[\\/]/.test(storagePath) || storagePath.includes('..')) {
    throw new Error('unsafe media storage path')
  }
  const dir = mediaDir()
  const resolved = path.join(dir, storagePath)
  const relative = path.relative(dir, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('unsafe media storage path')
  }
  return resolved
}

// Called by the session manager after ingest inserts a NEW message that
// carries an attachment. Idempotent by message: a history replay re-delivers
// the same message, and one attachment must never be queued twice.
export async function enqueueMedia(
  messageId: string, connectionId: string, meta: NonNullable<IncomingMessage['media']>,
): Promise<void> {
  const [existing] = await db.select({ id: media.id }).from(media)
    .where(eq(media.messageId, messageId)).limit(1)
  if (existing) return
  await db.insert(media).values({
    messageId, connectionId,
    mimeType: meta.mimeType, sizeBytes: meta.sizeBytes,
    isVoiceNote: meta.isVoiceNote, durationSeconds: meta.durationSeconds,
  })
}

// Exactly ChannelSession.downloadMedia, so the worker can hand one straight
// through without an adapter.
export type Downloader = (raw: unknown) => Promise<{ data: Buffer; mimeType: string | null }>

// Single-flight with one trailing rerun, for the drain's two triggers (the
// worker's tick and the post-pass kick). Overlap without this double-selects
// the same pending rows: every file downloaded twice, and one real failure
// counted as two attempts. A call landing mid-run joins the in-flight promise
// and exactly one rerun follows, so a row inserted after the in-flight SELECT
// is picked up promptly instead of waiting for the next tick.
//
// A rejection rejects every joined caller, clears the state, and DROPS the
// queued rerun on purpose: if the SELECT itself failed the database is down
// and the rerun would hit the same wall — the next tick retries anyway.
export function coalesceRuns(fn: () => Promise<void>): () => Promise<void> {
  let current: Promise<void> | null = null
  let rerun = false
  const cycle = (): Promise<void> => fn().then(() => {
    if (rerun) { rerun = false; return cycle() }
  })
  return function kick(): Promise<void> {
    if (current) { rerun = true; return current }
    current = cycle().finally(() => { current = null; rerun = false })
    return current
  }
}

export type MediaDrainSummary = { done: number; failed: number; skipped: number }

// One bounded pass, oldest first. Unbounded, a history replay of a media-heavy
// chat would select every pending row and buffer each file whole in one pass —
// memory and runtime both scaling with the backlog. Oldest first because a
// channel's media URLs expire: the rows nearest expiry go first.
//
// `downloaders` is the set of connections with a live session RIGHT NOW. A row
// whose connection is not in it is skipped without an attempt: there is no
// session to download it with, and burning a retry on that would exhaust the
// three attempts of every queued row during a reconnect.
export async function processPendingMedia(
  downloaders: Map<string, Downloader>,
  opts: { maxAttempts?: number; batch?: number } = {},
): Promise<MediaDrainSummary> {
  const maxAttempts = opts.maxAttempts ?? 3
  const batch = opts.batch ?? 20
  const summary: MediaDrainSummary = { done: 0, failed: 0, skipped: 0 }
  if (downloaders.size === 0) return summary

  const pending = await db.select({ md: media, raw: messages.raw })
    .from(media)
    .innerJoin(messages, eq(media.messageId, messages.id))
    .where(and(eq(media.status, 'pending'), isNull(messages.deletedAt)))
    .orderBy(asc(media.createdAt), asc(media.id))
    .limit(batch)
  if (pending.length === 0) return summary
  mkdirSync(mediaDir(), { recursive: true })

  for (const { md, raw } of pending) {
    const download = downloaders.get(md.connectionId)
    if (!download) { summary.skipped++; continue }
    // Tracked outside the try so the catch block can clean up a partial
    // write: a crash or a thrown error between the temp write and the
    // rename must never leave a `.tmp` file behind, and must never leave a
    // half-written file sitting at the FINAL path either.
    let tmpPath: string | null = null
    try {
      // The sender-declared length, checked BEFORE buffering — the OOM this
      // cap exists to prevent. Attacker-controllable, so it can only skip a
      // download, never authorise one: a lying-small declaration is caught by
      // the post-download check below. Both are permanent failures, not
      // retries; no number of attempts shrinks a file.
      if (md.sizeBytes !== null && md.sizeBytes > MAX_MEDIA_BYTES) {
        await db.update(media).set({ status: 'failed' }).where(eq(media.id, md.id))
        summary.failed++
        continue
      }
      const { data, mimeType } = await download(raw)
      if (data.length > MAX_MEDIA_BYTES) {
        await db.update(media).set({ status: 'failed', sizeBytes: data.length }).where(eq(media.id, md.id))
        summary.failed++
        continue
      }
      // Ingest's declaration wins; the channel's own answer fills a gap.
      const mime = md.mimeType ?? mimeType
      const storagePath = `${md.id}.${extForMime(mime)}`
      const finalPath = mediaFilePath(storagePath)
      // Write beside the final name, then rename — a rename within the same
      // directory is atomic, so a reader (or a retry of this same row) never
      // observes a partially-written file at the final path.
      tmpPath = `${finalPath}.tmp`
      writeFileSync(tmpPath, data)
      renameSync(tmpPath, finalPath)
      tmpPath = null // renamed: nothing left at tmpPath to clean up
      await db.update(media)
        .set({ status: 'done', storagePath, mimeType: mime, sizeBytes: statSync(finalPath).size })
        .where(eq(media.id, md.id))
      summary.done++
    } catch {
      // Best-effort: the write or the rename may have failed before any
      // file existed at all, so a missing tmp file here is expected, not an
      // error worth surfacing.
      if (tmpPath) { try { rmSync(tmpPath, { force: true }) } catch {} }
      // Deliberately swallowed: the error carries a URL, a filename, or a
      // channel diagnostic, and none of those may reach a log line. The
      // attempts counter IS the record that this row is failing.
      const attempts = md.attempts + 1
      const failed = attempts >= maxAttempts
      await db.update(media).set({ attempts, status: failed ? 'failed' : 'pending' }).where(eq(media.id, md.id))
      if (failed) summary.failed++
    }
  }
  return summary
}

export type ServableMedia = { id: string; storagePath: string; mimeType: string | null }

// What /media/[id] is allowed to hand back: a downloaded file whose message is
// still live. Tombstoned messages are never served (invariant 4), and a
// pending or failed row has no bytes on disk.
export async function getServableMedia(id: string): Promise<ServableMedia | null> {
  const [row] = await db.select({ id: media.id, storagePath: media.storagePath, mimeType: media.mimeType })
    .from(media)
    .innerJoin(messages, eq(media.messageId, messages.id))
    .where(and(eq(media.id, id), eq(media.status, 'done'), isNull(messages.deletedAt)))
    .limit(1)
  if (!row || !row.storagePath) return null
  return { id: row.id, storagePath: row.storagePath, mimeType: row.mimeType }
}
