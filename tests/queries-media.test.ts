import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { media, mediaAnalysis, messages } from '@/lib/db/schema'
import { resetDb } from './helpers/db'
import { makeAttachment } from './helpers/media-fixtures'
import { getMessages, searchMessages } from '@/lib/services/queries'

async function analysed(text: string) {
  const fixture = await makeAttachment({ mimeType: 'image/jpeg', status: 'done', storagePath: 'a.jpg' })
  await db.insert(mediaAnalysis).values({ mediaId: fixture.media.id, medium: 'image' })
  await db.update(mediaAnalysis).set({ status: 'done', extractedText: text, description: 'A flyer' })
    .where(eq(mediaAnalysis.mediaId, fixture.media.id))
  return fixture
}

describe('MessageView.media', () => {
  beforeEach(resetDb)

  it('is null for a plain text message', async () => {
    const fixture = await makeAttachment({ type: 'document' })
    await db.update(messages).set({ type: 'text', text: 'hello', hasMedia: false })
      .where(eq(messages.id, fixture.message.id))
    await db.delete(media).where(eq(media.id, fixture.media.id))
    const page = await getMessages(fixture.chat.id)
    expect(page!.messages[0].media).toBeNull()
  })

  it('is null while the attachment is still pending', async () => {
    const fixture = await makeAttachment({ mimeType: 'image/jpeg' })
    const page = await getMessages(fixture.chat.id)
    expect(page!.messages[0].media).toBeNull()
  })

  it('carries the id, the route url, the mime, and no extracted text yet', async () => {
    const fixture = await makeAttachment({ mimeType: 'image/jpeg', status: 'done', storagePath: 'a.jpg' })
    const page = await getMessages(fixture.chat.id)
    expect(page!.messages[0].media).toEqual({
      id: fixture.media.id, url: `/media/${fixture.media.id}`,
      mimeType: 'image/jpeg', extractedText: null,
    })
  })

  it('carries the extracted text once analysis is done', async () => {
    const fixture = await analysed('WEB3 SUMMIT Nov 12')
    const page = await getMessages(fixture.chat.id)
    expect(page!.messages[0].media).toMatchObject({ extractedText: 'WEB3 SUMMIT Nov 12' })
  })

  it('fills media on search hits too', async () => {
    const fixture = await analysed('WEB3 SUMMIT Nov 12')
    const hits = await searchMessages('SUMMIT')
    expect(hits).toHaveLength(1)
    expect(hits[0].id).toBe(fixture.message.id)
    expect(hits[0].media).toMatchObject({ url: `/media/${fixture.media.id}`, extractedText: 'WEB3 SUMMIT Nov 12' })
  })
})
