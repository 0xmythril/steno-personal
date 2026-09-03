import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '@/lib/db/client'
import { media, mediaAnalysis, settings, messages } from '@/lib/db/schema'
import { sql, eq } from 'drizzle-orm'
import { resetDb } from './helpers/db'
import { makeAttachment } from './helpers/media-fixtures'

async function searchRows(messageId: string): Promise<string[]> {
  const rows = await db.all<{ body: string }>(
    sql`SELECT body FROM search_index WHERE message_id = ${messageId} ORDER BY body`)
  return rows.map(r => r.body)
}

describe('0002_media', () => {
  beforeEach(resetDb)

  it('seeds exactly one settings row with enrichment off', async () => {
    const rows = await db.select().from(settings)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(1)
    expect(rows[0].analyzeImages).toBe(false)
    expect(rows[0].analyzeAudio).toBe(false)
    expect(rows[0].openrouterKeyCiphertext).toBeNull()
  })

  it('defaults a queued media row to pending with zero attempts', async () => {
    const { media: md } = await makeAttachment({ mimeType: 'image/jpeg' })
    expect(md.status).toBe('pending')
    expect(md.attempts).toBe(0)
    expect(md.storagePath).toBeNull()
    expect(md.createdAt).toBeInstanceOf(Date)
  })

  it('cascades media and media_analysis when the message goes', async () => {
    const { message, media: md } = await makeAttachment()
    await db.insert(mediaAnalysis).values({ mediaId: md.id, medium: 'image' })
    await db.delete(messages).where(eq(messages.id, message.id))
    expect(await db.select().from(media)).toEqual([])
    expect(await db.select().from(mediaAnalysis)).toEqual([])
  })

  it('rejects two analysis rows for one media row', async () => {
    const { media: md } = await makeAttachment()
    await db.insert(mediaAnalysis).values({ mediaId: md.id, medium: 'image' })
    await expect(db.insert(mediaAnalysis).values({ mediaId: md.id, medium: 'image' })).rejects.toThrow()
  })

  it('indexes extracted text as a second search row for the message', async () => {
    const { message, media: md } = await makeAttachment({ mimeType: 'image/jpeg', status: 'done' })
    await db.update(messages).set({ text: 'look at this' }).where(eq(messages.id, message.id))
    await db.insert(mediaAnalysis).values({ mediaId: md.id, medium: 'image' })
    expect(await searchRows(message.id)).toEqual(['look at this'])

    await db.update(mediaAnalysis).set({ extractedText: 'WEB3 SUMMIT Nov 12' })
      .where(eq(mediaAnalysis.mediaId, md.id))
    expect(await searchRows(message.id)).toEqual(['WEB3 SUMMIT Nov 12', 'look at this'])
  })

  it('keeps the media text row when the message text is edited afterwards', async () => {
    // M1's messages_au clears every row for the message; the rebuilt version in
    // 0002_media.sql has to put the attachment's text back, or an edit silently
    // drops the OCR with no re-analysis path to restore it.
    const { message, media: md } = await makeAttachment({ mimeType: 'image/jpeg', status: 'done' })
    await db.insert(mediaAnalysis).values({ mediaId: md.id, medium: 'image' })
    await db.update(mediaAnalysis).set({ extractedText: 'WEB3 SUMMIT Nov 12' })
      .where(eq(mediaAnalysis.mediaId, md.id))
    await db.update(messages).set({ text: 'edited caption' }).where(eq(messages.id, message.id))
    expect(await searchRows(message.id)).toEqual(['WEB3 SUMMIT Nov 12', 'edited caption'])
  })

  it('leaves the index alone for a failed or skipped analysis', async () => {
    const { message, media: md } = await makeAttachment({ status: 'done' })
    await db.insert(mediaAnalysis).values({ mediaId: md.id, medium: 'image' })
    await db.update(mediaAnalysis).set({ status: 'failed', error: 'provider 500' })
      .where(eq(mediaAnalysis.mediaId, md.id))
    expect(await searchRows(message.id)).toEqual([''])
  })

  it('drops both search rows when the message is deleted', async () => {
    const { message, media: md } = await makeAttachment({ status: 'done' })
    await db.insert(mediaAnalysis).values({ mediaId: md.id, medium: 'image' })
    await db.update(mediaAnalysis).set({ extractedText: 'flyer text' }).where(eq(mediaAnalysis.mediaId, md.id))
    await db.delete(messages).where(eq(messages.id, message.id))
    expect(await searchRows(message.id)).toEqual([])
  })
})
