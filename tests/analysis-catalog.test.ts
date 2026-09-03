import { describe, it, expect } from 'vitest'
import {
  OPENROUTER_BASE_URL,
  VISION_CATALOG, DEFAULT_VISION_MODEL, getVisionCatalogEntry, costMicroUsd,
  TRANSCRIPTION_CATALOG, DEFAULT_TRANSCRIPTION_MODEL, getTranscriptionCatalogEntry,
  transcriptionCostMicroUsd, SUMMARY_MODEL, SUMMARY_IN_PER_MTOK, SUMMARY_OUT_PER_MTOK,
} from '@/lib/services/analysis-catalog'

describe('analysis catalog', () => {
  it('is OpenRouter and nothing else', () => {
    expect(OPENROUTER_BASE_URL).toBe('https://openrouter.ai/api/v1')
    for (const e of [...VISION_CATALOG, ...TRANSCRIPTION_CATALOG]) {
      expect(e.provider).toMatch(/^OpenRouter/)
    }
    // The Anthropic-direct entries of the cloud catalog are gone: one
    // provider, one key, one adapter (spec 2.10).
    expect(VISION_CATALOG.map(e => e.id)).toEqual(['qwen3-vl-32b', 'glm-4.6v'])
    expect(VISION_CATALOG.some(e => e.model.startsWith('claude'))).toBe(false)
  })

  it('pins every vision entry against its model slug and price', () => {
    expect(VISION_CATALOG).toHaveLength(2)
    expect(VISION_CATALOG[0]).toMatchObject({
      id: 'qwen3-vl-32b', model: 'qwen/qwen3-vl-32b-instruct', inPerMTok: 0.104, outPerMTok: 0.416,
    })
    expect(VISION_CATALOG[1]).toMatchObject({
      id: 'glm-4.6v', model: 'z-ai/glm-4.6v', inPerMTok: 0.3, outPerMTok: 0.9,
    })
  })

  it('leads with the recommended defaults and resolves them', () => {
    expect(DEFAULT_VISION_MODEL).toBe('qwen3-vl-32b')
    expect(VISION_CATALOG[0].id).toBe(DEFAULT_VISION_MODEL)
    expect(DEFAULT_TRANSCRIPTION_MODEL).toBe('qwen3-asr-1.7b')
    expect(TRANSCRIPTION_CATALOG[0].id).toBe(DEFAULT_TRANSCRIPTION_MODEL)
    expect(getVisionCatalogEntry('glm-4.6v')?.model).toBe('z-ai/glm-4.6v')
    expect(getTranscriptionCatalogEntry('qwen3-asr-1.7b')?.model).toBe('qwen/qwen3-asr-1.7b')
  })

  it('rejects unknown and absent ids', () => {
    expect(getVisionCatalogEntry('claude-opus-5')).toBeNull()
    expect(getVisionCatalogEntry(null)).toBeNull()
    expect(getVisionCatalogEntry(undefined)).toBeNull()
    expect(getTranscriptionCatalogEntry('not-a-model')).toBeNull()
    expect(getTranscriptionCatalogEntry(null)).toBeNull()
  })

  it('pins all four transcription entries', () => {
    expect(TRANSCRIPTION_CATALOG).toHaveLength(4)
    const expected = [
      { id: 'qwen3-asr-1.7b', model: 'qwen/qwen3-asr-1.7b', perSecondMicroUsd: 8 },
      { id: 'whisper-large-v3-turbo', model: 'openai/whisper-large-v3-turbo', perSecondMicroUsd: 3 },
      { id: 'voxtral-mini-3b', model: 'mistralai/voxtral-mini-3b-2507', perSecondMicroUsd: 17 },
      { id: 'voxtral-small-24b-stt', model: 'mistralai/voxtral-small-24b-2507-stt', perSecondMicroUsd: 50 },
    ]
    for (let i = 0; i < 4; i++) expect(TRANSCRIPTION_CATALOG[i]).toMatchObject(expected[i])
  })

  it('computes integer micro-dollar image costs from catalog prices', () => {
    expect(costMicroUsd({ inPerMTok: 1, outPerMTok: 5 }, 1000, 100)).toBe(1500)
    expect(costMicroUsd({ inPerMTok: 0.104, outPerMTok: 0.416 }, 1300, 250)).toBe(239)
    expect(costMicroUsd({ inPerMTok: 5, outPerMTok: 25 }, 0, 0)).toBe(0)
  })

  it('derives the summary price from the vision entry it names', () => {
    const entry = VISION_CATALOG.find(e => e.model === SUMMARY_MODEL)
    expect(entry).toBeDefined()
    expect(SUMMARY_IN_PER_MTOK).toBe(entry!.inPerMTok)
    expect(SUMMARY_OUT_PER_MTOK).toBe(entry!.outPerMTok)
  })

  it('adds the summary call to the audio seconds, always an integer', () => {
    const summary = 300 * SUMMARY_IN_PER_MTOK + 40 * SUMMARY_OUT_PER_MTOK
    expect(transcriptionCostMicroUsd({ perSecondMicroUsd: 8 }, 45, 300, 40)).toBe(Math.round(360 + summary))
    expect(transcriptionCostMicroUsd({ perSecondMicroUsd: 8 }, 0, 0, 0)).toBe(0)
    expect(Number.isInteger(transcriptionCostMicroUsd({ perSecondMicroUsd: 17 }, 7.4, 123, 45))).toBe(true)
  })
})
