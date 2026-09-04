import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { media, mediaAnalysis, messages } from '@/lib/db/schema'
import { resetDb } from './helpers/db'
import { makeAttachment } from './helpers/media-fixtures'
import { getMessages, mediaView, searchMessages } from '@/lib/services/queries'
import { updateSettings } from '@/lib/services/settings'

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

  it('says pending, with no url, while the attachment is still pending', async () => {
    const fixture = await makeAttachment({ mimeType: 'image/jpeg' })
    const page = await getMessages(fixture.chat.id)
    expect(page!.messages[0].media).toMatchObject({ id: fixture.media.id, status: 'pending', url: null, mimeType: 'image/jpeg' })
  })

  it('carries the id, the route url, the mime, and no extracted text yet', async () => {
    const fixture = await makeAttachment({ mimeType: 'image/jpeg', status: 'done', storagePath: 'a.jpg' })
    const page = await getMessages(fixture.chat.id)
    expect(page!.messages[0].media).toEqual({
      id: fixture.media.id, status: 'ready', url: `/media/${fixture.media.id}`,
      mimeType: 'image/jpeg', sizeBytes: null, durationSeconds: null, isVoiceNote: null,
      extractedText: null, description: null, analysis: 'off',
    })
  })

  it('carries the extracted text once analysis is done', async () => {
    const fixture = await analysed('WEB3 SUMMIT Nov 12')
    const page = await getMessages(fixture.chat.id)
    expect(page!.messages[0].media).toMatchObject({ extractedText: 'WEB3 SUMMIT Nov 12' })
  })

  it('ignores text on an analysis row that is not done', async () => {
    // M7: the join now states the status rather than trusting that
    // extracted_text is only ever written on a done row.
    const fixture = await analysed('WEB3 SUMMIT Nov 12')
    await db.update(mediaAnalysis).set({ status: 'failed' })
      .where(eq(mediaAnalysis.mediaId, fixture.media.id))
    const page = await getMessages(fixture.chat.id)
    // The attachment itself still comes back — only its text is withheld.
    expect(page!.messages[0].media).toMatchObject({ id: fixture.media.id, extractedText: null })
  })

  it('says whether analysis is off, queued, done, failed, skipped or unsupported', async () => {
    // extractedText: null on a ready image meant five different things to a
    // tester — no key in Settings, not run yet, nothing found, failed — and
    // they could not tell which. Now the state is named.
    const state = async (chatId: string) => (await getMessages(chatId))!.messages[0].media!.analysis
    const image = await makeAttachment({ mimeType: 'image/jpeg', status: 'done', storagePath: 'a.jpg' })
    expect(await state(image.chat.id)).toBe('off')
    await updateSettings({ openrouterKey: 'sk-test', analyzeImages: true, analyzeAudio: false })
    expect(await state(image.chat.id)).toBe('queued')
    await updateSettings({ analyzeImages: false })
    expect(await state(image.chat.id)).toBe('off')
    await updateSettings({ analyzeImages: true })

    await db.insert(mediaAnalysis).values({ mediaId: image.media.id, medium: 'image' })
    expect(await state(image.chat.id)).toBe('queued')
    for (const status of ['done', 'failed', 'skipped'] as const) {
      await db.update(mediaAnalysis).set({ status }).where(eq(mediaAnalysis.mediaId, image.media.id))
      expect(await state(image.chat.id)).toBe(status)
    }
    // A finished row stays what it is even after the switch is turned off.
    await db.update(mediaAnalysis).set({ status: 'done' }).where(eq(mediaAnalysis.mediaId, image.media.id))
    await updateSettings({ analyzeImages: false })
    expect(await state(image.chat.id)).toBe('done')

    // Nothing analyses a PDF yet, whatever the settings say.
    const pdf = await makeAttachment({ type: 'document', mimeType: 'application/pdf', status: 'done', storagePath: 'd.pdf' })
    expect(await state(pdf.chat.id)).toBe('unsupported')
    // A voice note within the cap is transcribable; audio that is not a
    // voice note, or is too long, is not.
    const note = await makeAttachment({ type: 'audio', mimeType: 'audio/ogg', status: 'done', storagePath: 'v.ogg', isVoiceNote: true, durationSeconds: 30 })
    expect(await state(note.chat.id)).toBe('off')
    await updateSettings({ analyzeAudio: true })
    expect(await state(note.chat.id)).toBe('queued')
    const song = await makeAttachment({ type: 'audio', mimeType: 'audio/mpeg', status: 'done', storagePath: 's.mp3', isVoiceNote: false, durationSeconds: 30 })
    expect(await state(song.chat.id)).toBe('unsupported')
    const long = await makeAttachment({ type: 'audio', mimeType: 'audio/ogg', status: 'done', storagePath: 'l.ogg', isVoiceNote: true, durationSeconds: 601 })
    expect(await state(long.chat.id)).toBe('unsupported')

    // get_media's view says the same thing.
    expect((await mediaView(pdf.media.id))!.analysis).toBe('unsupported')
    expect((await mediaView(image.media.id))!.analysis).toBe('done')
  })

  it('fills media on search hits too', async () => {
    const fixture = await analysed('WEB3 SUMMIT Nov 12')
    const hits = (await searchMessages('SUMMIT')).hits
    expect(hits).toHaveLength(1)
    expect(hits[0].id).toBe(fixture.message.id)
    expect(hits[0].media).toMatchObject({ url: `/media/${fixture.media.id}`, extractedText: 'WEB3 SUMMIT Nov 12' })
  })
})
