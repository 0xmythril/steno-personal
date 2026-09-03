import { describe, it, expect, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { media, mediaAnalysis, messages } from '@/lib/db/schema'
import { resetDb } from './helpers/db'
import { makeAttachment } from './helpers/media-fixtures'
import { mediaDir } from '@/lib/services/media'
import { updateSettings } from '@/lib/services/settings'
import { AnalysisSkip } from '@/lib/services/analyzers/types'
import type { AnalysisResult, Transcriber, TranscriptionResult, VisionAnalyzer } from '@/lib/services/analyzers/types'
import { MAX_ANALYSIS_BYTES } from '@/lib/services/analyzers/vision'
import {
  countRecentAnalyses, enqueueMediaAnalysis, processPendingAnalyses, runMediaAnalysis,
} from '@/lib/services/media-analysis'

const IMAGE_ENTRY = { id: 'qwen3-vl-32b', inPerMTok: 1, outPerMTok: 5 }
const AUDIO_ENTRY = { id: 'qwen3-asr-1.7b', perSecondMicroUsd: 8 }

const okImage: AnalysisResult = {
  ocrText: 'WEB3 SUMMIT\nNov 12', description: 'A conference flyer',
  kind: 'event', confidence: 0.9, inputTokens: 1000, outputTokens: 100, providerCostMicroUsd: null,
}
const okAudio: TranscriptionResult = {
  text: 'Let us push the launch to Friday.', description: 'Proposes moving the launch',
  language: 'en', seconds: 45, inputTokens: 300, outputTokens: 40, providerCostMicroUsd: null,
}

function stubAnalyzer(impl: () => Promise<AnalysisResult>): VisionAnalyzer & { calls: number } {
  const a = { calls: 0, analyze: async () => { a.calls++; return impl() } }
  return a
}
function stubTranscriber(impl: () => Promise<TranscriptionResult>): Transcriber & { calls: number } {
  const t = { calls: 0, transcribe: async () => { t.calls++; return impl() } }
  return t
}

// A downloaded attachment with real bytes on disk under DATA_DIR/media.
async function downloaded(opts: {
  type?: 'image' | 'audio'; mimeType?: string; sizeBytes?: number
  isVoiceNote?: boolean | null; durationSeconds?: number | null
} = {}) {
  const type = opts.type ?? 'image'
  const fixture = await makeAttachment({
    type,
    mimeType: opts.mimeType ?? (type === 'image' ? 'image/jpeg' : 'audio/ogg; codecs=opus'),
    status: 'done',
    sizeBytes: opts.sizeBytes ?? 15,
    isVoiceNote: opts.isVoiceNote === undefined ? (type === 'audio') : opts.isVoiceNote,
    durationSeconds: opts.durationSeconds === undefined ? (type === 'audio' ? 45 : null) : opts.durationSeconds,
  })
  const storagePath = `${fixture.media.id}.${type === 'image' ? 'jpg' : 'ogg'}`
  mkdirSync(mediaDir(), { recursive: true })
  writeFileSync(`${mediaDir()}/${storagePath}`, 'fake-bytes')
  await db.update(media).set({ storagePath }).where(eq(media.id, fixture.media.id))
  return fixture
}

describe('analysis enqueue', () => {
  beforeEach(resetDb)

  it('queues a downloaded image', async () => {
    const { media: md } = await downloaded()
    expect(await enqueueMediaAnalysis('image')).toBe(1)
    const [row] = await db.select().from(mediaAnalysis)
    expect(row).toMatchObject({ mediaId: md.id, medium: 'image', status: 'pending', attempts: 0 })
  })

  it('queues a downloaded voice note', async () => {
    await downloaded({ type: 'audio' })
    expect(await enqueueMediaAnalysis('audio')).toBe(1)
    expect((await db.select().from(mediaAnalysis))[0].medium).toBe('audio')
  })

  it.each([
    ['the media is not downloaded yet', { status: 'pending' as const }],
    ['the mime is not an analyzable image', { mimeType: 'application/pdf' }],
  ])('queues nothing when %s', async (_label, patch) => {
    const { media: md } = await downloaded()
    await db.update(media).set(patch).where(eq(media.id, md.id))
    expect(await enqueueMediaAnalysis('image')).toBe(0)
  })

  it('never queues a sticker, even though it is an image mime', async () => {
    const fixture = await makeAttachment({ type: 'document', mimeType: 'image/webp', status: 'done', storagePath: 's.webp' })
    await db.update(messages).set({ type: 'sticker' }).where(eq(messages.id, fixture.message.id))
    expect(await enqueueMediaAnalysis('image')).toBe(0)
  })

  it.each([
    ['it is not a voice note', { isVoiceNote: false }],
    ['its length is unknown', { durationSeconds: null }],
    ['it is longer than ten minutes', { durationSeconds: 601 }],
  ])('queues no audio when %s', async (_label, opts) => {
    await downloaded({ type: 'audio', ...opts })
    expect(await enqueueMediaAnalysis('audio')).toBe(0)
  })

  it('never queues an attachment of a deleted message', async () => {
    const { message } = await downloaded()
    await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, message.id))
    expect(await enqueueMediaAnalysis('image')).toBe(0)
  })

  it('is idempotent and honours the batch cap', async () => {
    for (let i = 0; i < 3; i++) await downloaded()
    expect(await enqueueMediaAnalysis('image', { batch: 2 })).toBe(2)
    expect(await enqueueMediaAnalysis('image', { batch: 2 })).toBe(1)
    expect(await enqueueMediaAnalysis('image', { batch: 2 })).toBe(0)
  })
})

describe('analysis drain', () => {
  beforeEach(resetDb)

  it('writes text, model, and cost, and makes the text searchable', async () => {
    const { message } = await downloaded()
    await enqueueMediaAnalysis('image')
    const analyzer = stubAnalyzer(async () => okImage)
    const summary = await processPendingAnalyses({ medium: 'image', analyzer, entry: IMAGE_ENTRY })
    expect(summary).toEqual({ done: 1, failed: 0, skipped: 0, retried: 0 })
    expect(analyzer.calls).toBe(1)

    const [row] = await db.select().from(mediaAnalysis)
    expect(row.status).toBe('done')
    expect(row.extractedText).toContain('WEB3 SUMMIT')
    expect(row.description).toBe('A conference flyer')
    expect(row.kind).toBe('event')
    expect(row.confidence).toBeCloseTo(0.9)
    expect(row.model).toBe('qwen3-vl-32b')
    // 1000 tokens at $1/MTok + 100 at $5/MTok = 1500 micro-dollars.
    expect(row.costMicroUsd).toBe(1500)
    expect(row.completedAt).toBeInstanceOf(Date)

    const { searchMessages } = await import('@/lib/services/queries')
    const hits = await searchMessages('SUMMIT')
    expect(hits.map(h => h.id)).toEqual([message.id])
  })

  it('prefers the provider-reported cost over the catalog estimate', async () => {
    await downloaded()
    await enqueueMediaAnalysis('image')
    await processPendingAnalyses({
      medium: 'image', entry: IMAGE_ENTRY,
      analyzer: stubAnalyzer(async () => ({ ...okImage, providerCostMicroUsd: 239 })),
    })
    expect((await db.select().from(mediaAnalysis))[0].costMicroUsd).toBe(239)
  })

  it('writes a transcript and its audio cost', async () => {
    await downloaded({ type: 'audio' })
    await enqueueMediaAnalysis('audio')
    await processPendingAnalyses({
      medium: 'audio', entry: AUDIO_ENTRY, transcriber: stubTranscriber(async () => okAudio),
    })
    const [row] = await db.select().from(mediaAnalysis)
    expect(row.status).toBe('done')
    expect(row.extractedText).toBe('Let us push the launch to Friday.')
    expect(row.language).toBe('en')
    // 45 s at 8 micro-USD/s = 360, plus the summary tokens.
    expect(row.costMicroUsd).toBeGreaterThanOrEqual(360)
    expect(Number.isInteger(row.costMicroUsd!)).toBe(true)
  })

  it('retries a provider error, then fails it at maxAttempts, recording why', async () => {
    await downloaded()
    await enqueueMediaAnalysis('image')
    const boom = stubAnalyzer(async () => { throw new Error('rate limited') })
    const job = { medium: 'image', analyzer: boom, entry: IMAGE_ENTRY } as const
    expect(await processPendingAnalyses(job, { maxAttempts: 3 })).toMatchObject({ retried: 1 })
    await processPendingAnalyses(job, { maxAttempts: 3 })
    let [row] = await db.select().from(mediaAnalysis)
    expect(row.status).toBe('pending')
    expect(row.attempts).toBe(2)
    expect(await processPendingAnalyses(job, { maxAttempts: 3 })).toMatchObject({ failed: 1 })
    ;[row] = await db.select().from(mediaAnalysis)
    expect(row.status).toBe('failed')
    expect(row.error).toContain('rate limited')
  })

  it('marks a skip skipped, never retried, and records what was billed', async () => {
    await downloaded({ type: 'audio' })
    await enqueueMediaAnalysis('audio')
    const summary = await processPendingAnalyses({
      medium: 'audio', entry: AUDIO_ENTRY,
      transcriber: stubTranscriber(async () => { throw new AnalysisSkip('empty transcript', { seconds: 3 }) }),
    })
    expect(summary.skipped).toBe(1)
    const [row] = await db.select().from(mediaAnalysis)
    expect(row.status).toBe('skipped')
    expect(row.attempts).toBe(0)
    expect(row.costMicroUsd).toBe(24) // 3 s at 8 micro-USD/s
  })

  it('records no cost for a skip decided before any call', async () => {
    await downloaded({ sizeBytes: MAX_ANALYSIS_BYTES + 1 })
    await enqueueMediaAnalysis('image')
    const analyzer = stubAnalyzer(async () => okImage)
    expect(await processPendingAnalyses({ medium: 'image', analyzer, entry: IMAGE_ENTRY }))
      .toMatchObject({ skipped: 1 })
    expect(analyzer.calls).toBe(0)
    expect((await db.select().from(mediaAnalysis))[0].costMicroUsd).toBeNull()
  })

  it('skips, without calling the provider, a message deleted after enqueue', async () => {
    const { message } = await downloaded()
    await enqueueMediaAnalysis('image')
    await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, message.id))
    const analyzer = stubAnalyzer(async () => okImage)
    expect(await processPendingAnalyses({ medium: 'image', analyzer, entry: IMAGE_ENTRY }))
      .toMatchObject({ skipped: 1 })
    expect(analyzer.calls).toBe(0)
  })

  it('counts only billed rows from the trailing 24 hours', async () => {
    await downloaded()
    await enqueueMediaAnalysis('image')
    await processPendingAnalyses({ medium: 'image', analyzer: stubAnalyzer(async () => okImage), entry: IMAGE_ENTRY })
    expect(await countRecentAnalyses()).toBe(1)
    await db.update(mediaAnalysis).set({ completedAt: new Date(Date.now() - 25 * 3600_000) })
    expect(await countRecentAnalyses()).toBe(0)
  })
})

describe('runMediaAnalysis', () => {
  beforeEach(resetDb)

  it('does nothing with no key saved', async () => {
    await updateSettings({ analyzeImages: true, analyzeAudio: true })
    await downloaded()
    const res = await runMediaAnalysis()
    expect(res.ran).toBe(false)
    expect(res.image).toEqual({ ran: false, reason: 'no_key' })
    expect(res.audio).toEqual({ ran: false, reason: 'no_key' })
    expect(await db.select().from(mediaAnalysis)).toEqual([])
  })

  it('reports each medium\'s own toggle', async () => {
    await updateSettings({ openrouterKey: 'sk-or-x', analyzeImages: true })
    const res = await runMediaAnalysis()
    expect(res.image).toMatchObject({ ran: true })
    expect(res.audio).toEqual({ ran: false, reason: 'disabled' })
    expect(res.ran).toBe(true)
  })

  it('stops both media at the daily limit', async () => {
    await updateSettings({ openrouterKey: 'sk-or-x', analyzeImages: true, analyzeAudio: true })
    await downloaded()
    await enqueueMediaAnalysis('image')
    await processPendingAnalyses({ medium: 'image', analyzer: stubAnalyzer(async () => okImage), entry: IMAGE_ENTRY })
    process.env.ANALYSIS_DAILY_LIMIT = '1'
    const { _resetEnvCacheForTests } = await import('@/lib/env')
    _resetEnvCacheForTests()
    try {
      const res = await runMediaAnalysis()
      expect(res.image).toEqual({ ran: false, reason: 'daily_limit' })
      expect(res.audio).toEqual({ ran: false, reason: 'daily_limit' })
    } finally {
      delete process.env.ANALYSIS_DAILY_LIMIT
      _resetEnvCacheForTests()
    }
  })

  it('never throws: one medium\'s fault does not take the other down', async () => {
    await updateSettings({ openrouterKey: 'sk-or-x', analyzeImages: true, analyzeAudio: true })
    // A stored model that has left the catalog is the cheapest way to make one
    // half fail outside the per-row try.
    const { settings } = await import('@/lib/db/schema')
    await db.update(settings).set({ visionModel: 'delisted' })
    const res = await runMediaAnalysis()
    expect(res.audio).toMatchObject({ ran: true })
  })
})
