import { describe, it, expect, beforeEach } from 'vitest'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { media } from '@/lib/db/schema'
import { resetDb } from './helpers/db'
import { makeAttachment, makeConnection, makeChat, makeMessage, makeMedia } from './helpers/media-fixtures'
import {
  MAX_MEDIA_BYTES, coalesceRuns, enqueueMedia, extForMime, getServableMedia,
  mediaDir, mediaFilePath, processPendingMedia, type Downloader,
} from '@/lib/services/media'

const ok = (bytes: string, mimeType: string | null = null): Downloader =>
  async () => ({ data: Buffer.from(bytes), mimeType })

describe('media drain', () => {
  beforeEach(resetDb)

  it('maps mime types to extensions', () => {
    expect(extForMime('image/jpeg')).toBe('jpg')
    expect(extForMime('audio/ogg; codecs=opus')).toBe('ogg')
    expect(extForMime('application/x-weird')).toBe('bin')
    expect(extForMime(null)).toBe('bin')
  })

  it('mediaFilePath refuses a storage path that tries to escape DATA_DIR/media', () => {
    expect(() => mediaFilePath('../x')).toThrow()
    expect(() => mediaFilePath('../../etc/passwd')).toThrow()
    expect(() => mediaFilePath('sub/x.jpg')).toThrow() // a separator, even without '..'
    expect(() => mediaFilePath('a\\b')).toThrow() // a backslash separator too
    expect(mediaFilePath('x.jpg')).toBe(`${mediaDir()}/x.jpg`) // the ordinary shape still resolves
  })

  it('enqueues one pending row per message, carrying the declared facts', async () => {
    const connection = await makeConnection()
    const chat = await makeChat(connection.id)
    const message = await makeMessage(chat.id, { type: 'audio' })
    await enqueueMedia(message.id, connection.id, {
      mimeType: 'audio/ogg; codecs=opus', sizeBytes: 4096, isVoiceNote: true, durationSeconds: 45,
    })
    // A replayed message must not queue the same attachment twice.
    await enqueueMedia(message.id, connection.id, {
      mimeType: 'audio/ogg; codecs=opus', sizeBytes: 4096, isVoiceNote: true, durationSeconds: 45,
    })
    const rows = await db.select().from(media)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      messageId: message.id, connectionId: connection.id, status: 'pending',
      mimeType: 'audio/ogg; codecs=opus', sizeBytes: 4096, isVoiceNote: true, durationSeconds: 45,
    })
  })

  it('downloads to a relative path under DATA_DIR/media and marks done', async () => {
    const { connection, media: md } = await makeAttachment({ mimeType: 'image/jpeg' })
    const out = await processPendingMedia(new Map([[connection.id, ok('fake-jpeg-bytes')]]))
    expect(out).toEqual({ done: 1, failed: 0, skipped: 0 })
    const [after] = await db.select().from(media)
    expect(after.status).toBe('done')
    expect(after.storagePath).toBe(`${md.id}.jpg`)
    expect(after.sizeBytes).toBe(15)
    expect(readFileSync(mediaFilePath(after.storagePath!)).toString()).toBe('fake-jpeg-bytes')
  })

  it('writes atomically: no .tmp file is left behind after a successful drain', async () => {
    const { connection, media: md } = await makeAttachment({ mimeType: 'image/jpeg' })
    const out = await processPendingMedia(new Map([[connection.id, ok('fake-jpeg-bytes')]]))
    expect(out).toEqual({ done: 1, failed: 0, skipped: 0 })
    const files = readdirSync(mediaDir())
    expect(files.some(f => f.endsWith('.tmp'))).toBe(false)
    expect(files).toContain(`${md.id}.jpg`)
  })

  it('leaves the row un-done and cleans up the temp file when the rename fails', async () => {
    const { connection, media: md } = await makeAttachment({ mimeType: 'image/jpeg' })
    // Pre-create a directory AT the final path: renaming a file onto an
    // existing directory always fails (EISDIR), so this exercises a real
    // rename failure without mocking fs.
    mkdirSync(mediaFilePath(`${md.id}.jpg`), { recursive: true })
    const out = await processPendingMedia(new Map([[connection.id, ok('fake-jpeg-bytes')]]), { maxAttempts: 3 })
    expect(out).toEqual({ done: 0, failed: 0, skipped: 0 })
    const [after] = await db.select().from(media)
    expect(after.status).not.toBe('done')
    expect(after.storagePath).toBeNull()
    const files = readdirSync(mediaDir())
    expect(files.some(f => f.endsWith('.tmp'))).toBe(false)
  })

  it('takes the downloader mime when ingest declared none', async () => {
    const { connection } = await makeAttachment({ mimeType: null })
    await processPendingMedia(new Map([[connection.id, ok('x', 'image/png')]]))
    const [after] = await db.select().from(media)
    expect(after.mimeType).toBe('image/png')
    expect(after.storagePath).toMatch(/\.png$/)
  })

  it('leaves rows pending, and burns no attempt, when the connection has no live session', async () => {
    await makeAttachment({ mimeType: 'image/jpeg' })
    const out = await processPendingMedia(new Map([['some-other-connection', ok('x')]]))
    expect(out).toEqual({ done: 0, failed: 0, skipped: 1 })
    const [after] = await db.select().from(media)
    expect(after.status).toBe('pending')
    expect(after.attempts).toBe(0)
  })

  it('stores the mime stripped of its parameters', async () => {
    // M5: the analysis enqueue predicate compares media.mime_type exactly, so
    // a stored 'audio/ogg; codecs=opus' would silently never be transcribed.
    const { media: md } = await makeAttachment({ type: 'audio', mimeType: 'audio/ogg; codecs=opus' })
    const { connection } = await db.select({ connection: media.connectionId })
      .from(media).where(eq(media.id, md.id)).then(r => r[0])
    expect(await processPendingMedia(new Map([[connection, ok('voice')]]))).toMatchObject({ done: 1 })
    const [after] = await db.select().from(media).where(eq(media.id, md.id))
    expect(after.mimeType).toBe('audio/ogg')
    expect(after.storagePath).toBe(`${md.id}.ogg`)
  })

  it('a dead connection\'s backlog cannot starve a live connection', async () => {
    // C1: the batch used to be selected oldest-first across ALL pending rows
    // and only then filtered against the live map, so `batch` rows on a
    // revoked connection occupied every slot on every pass, forever.
    const dead = await makeConnection('telegram')
    const deadChat = await makeChat(dead.id)
    for (let i = 0; i < 3; i++) {
      const m = await makeMessage(deadChat.id)
      const md = await makeMedia(m.id, dead.id, { mimeType: 'image/png' })
      // Explicitly older than the fresh row, so the starving order is the one
      // the drain would actually see rather than an insertion-time accident.
      await db.update(media).set({ createdAt: new Date(Date.now() - 60_000) }).where(eq(media.id, md.id))
    }
    // A reconnect: makeConnection revokes the prior live row on the channel,
    // which is exactly how a Disconnect strands the rows above.
    const live = await makeConnection('telegram')
    const liveChat = await makeChat(live.id)
    const freshMessage = await makeMessage(liveChat.id)
    const fresh = await makeMedia(freshMessage.id, live.id, { mimeType: 'image/png' })

    const out = await processPendingMedia(new Map([[live.id, ok('fresh-bytes')]]), { batch: 3 })
    expect(out).toEqual({ done: 1, failed: 0, skipped: 3 })
    const [after] = await db.select().from(media).where(eq(media.id, fresh.id))
    expect(after.status).toBe('done')
  })

  it('does not even query when no session is live', async () => {
    const { media: md } = await makeAttachment()
    const out = await processPendingMedia(new Map())
    expect(out).toEqual({ done: 0, failed: 0, skipped: 0 })
    const [after] = await db.select().from(media).where(eq(media.id, md.id))
    expect(after.status).toBe('pending')
    expect(after.attempts).toBe(0)
  })

  it('fails an over-cap declared payload without downloading it', async () => {
    const { connection } = await makeAttachment({ mimeType: 'application/pdf', sizeBytes: MAX_MEDIA_BYTES + 1 })
    let downloaded = false
    const out = await processPendingMedia(new Map([[connection.id, async () => {
      downloaded = true
      return { data: Buffer.alloc(0), mimeType: null }
    }]]))
    expect(downloaded).toBe(false)
    expect(out).toEqual({ done: 0, failed: 1, skipped: 0 })
    const [after] = await db.select().from(media)
    expect(after.status).toBe('failed')
    expect(after.storagePath).toBeNull()
  })

  it('fails a payload that buffered over the cap despite a small declaration', async () => {
    const { connection } = await makeAttachment({ mimeType: 'application/pdf', sizeBytes: 10 })
    const over = MAX_MEDIA_BYTES + 1
    // Fake the length instead of allocating 100 MiB of real bytes.
    const fake = { length: over } as unknown as Buffer
    const out = await processPendingMedia(new Map([[connection.id, async () => ({ data: fake, mimeType: null })]]))
    expect(out).toEqual({ done: 0, failed: 1, skipped: 0 })
    const [after] = await db.select().from(media)
    expect(after.status).toBe('failed')
    expect(after.sizeBytes).toBe(over)
  })

  it('drains at most `batch` rows per pass, oldest first', async () => {
    const connection = await makeConnection()
    const chat = await makeChat(connection.id)
    const rows = []
    for (let i = 0; i < 3; i++) {
      const message = await makeMessage(chat.id)
      rows.push(await makeMedia(message.id, connection.id, { mimeType: 'image/jpeg' }))
    }
    const t0 = Date.parse('2026-09-01T00:00:00Z')
    for (const [i, r] of rows.entries()) {
      await db.update(media).set({ createdAt: new Date(t0 + i * 60_000) }).where(eq(media.id, r.id))
    }
    let downloads = 0
    await processPendingMedia(new Map([[connection.id, async () => {
      downloads++
      return { data: Buffer.from('x'), mimeType: null }
    }]]), { batch: 2 })
    expect(downloads).toBe(2)
    const byId = new Map((await db.select().from(media)).map(r => [r.id, r.status]))
    expect(byId.get(rows[0].id)).toBe('done')
    expect(byId.get(rows[1].id)).toBe('done')
    expect(byId.get(rows[2].id)).toBe('pending')
  })

  it('retries a download error, then fails it at maxAttempts', async () => {
    const { connection } = await makeAttachment({ mimeType: 'image/jpeg' })
    const boom = new Map<string, Downloader>([[connection.id, async () => { throw new Error('expired url') }]])
    await processPendingMedia(boom, { maxAttempts: 3 })
    await processPendingMedia(boom, { maxAttempts: 3 })
    let [after] = await db.select().from(media)
    expect(after.status).toBe('pending')
    expect(after.attempts).toBe(2)
    const out = await processPendingMedia(boom, { maxAttempts: 3 })
    expect(out.failed).toBe(1)
    ;[after] = await db.select().from(media)
    expect(after.status).toBe('failed')
  })

  it('serves only a downloaded attachment of a live message', async () => {
    const { message, media: md } = await makeAttachment({ mimeType: 'image/jpeg', status: 'done', storagePath: 'x.jpg' })
    expect(await getServableMedia(md.id)).toMatchObject({ id: md.id, storagePath: 'x.jpg', mimeType: 'image/jpeg' })
    expect(await getServableMedia('no-such-id')).toBeNull()

    const pending = await makeAttachment({ mimeType: 'image/jpeg' })
    expect(await getServableMedia(pending.media.id)).toBeNull()

    const { messages } = await import('@/lib/db/schema')
    await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, message.id))
    expect(await getServableMedia(md.id)).toBeNull()
  })
})

// The drain is kicked from the worker's tick and again right after a
// productive pass. Unguarded overlap double-selects the same pending rows:
// every file downloaded twice, and one real failure counted as two attempts.
describe('coalesceRuns', () => {
  it('coalesces overlapping calls into one run plus one trailing rerun', async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const kick = coalesceRuns(async () => { calls++; if (calls === 1) await gate })

    const first = kick()
    const second = kick()
    const third = kick()
    expect(calls).toBe(1)
    expect(second).toBe(first)
    expect(third).toBe(first)

    release()
    await first
    expect(calls).toBe(2)
  })

  it('runs again for a call that arrives after a run finished', async () => {
    let calls = 0
    const kick = coalesceRuns(async () => { calls++ })
    await kick()
    await kick()
    expect(calls).toBe(2)
  })

  it('propagates a rejection and recovers for the next call', async () => {
    let calls = 0
    const kick = coalesceRuns(async () => { calls++; if (calls === 1) throw new Error('db down') })
    await expect(kick()).rejects.toThrow('db down')
    await expect(kick()).resolves.toBeUndefined()
    expect(calls).toBe(2)
  })
})
