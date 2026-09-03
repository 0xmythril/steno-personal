import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '@/lib/db/client'
import { settings } from '@/lib/db/schema'
import { resetDb } from './helpers/db'
import { getOpenrouterKey, getSettings, updateSettings } from '@/lib/services/settings'
import { DEFAULT_TRANSCRIPTION_MODEL, DEFAULT_VISION_MODEL } from '@/lib/services/analysis-catalog'

describe('settings service', () => {
  beforeEach(resetDb)

  it('starts with enrichment off and the recommended models', async () => {
    expect(await getSettings()).toEqual({
      hasOpenrouterKey: false, analyzeImages: false, analyzeAudio: false,
      visionModel: DEFAULT_VISION_MODEL, transcriptionModel: DEFAULT_TRANSCRIPTION_MODEL,
    })
    expect(await getOpenrouterKey()).toBeNull()
  })

  it('stores the OpenRouter key encrypted and reads it back', async () => {
    await updateSettings({ openrouterKey: '  sk-or-v1-secret  ' })
    const [row] = await db.select().from(settings)
    expect(row.openrouterKeyCiphertext).toBeTruthy()
    // Never in plaintext, and never the raw value in any surfaced shape.
    expect(row.openrouterKeyCiphertext).not.toContain('sk-or-v1-secret')
    expect(await getOpenrouterKey()).toBe('sk-or-v1-secret')
    expect(await getSettings()).toMatchObject({ hasOpenrouterKey: true })
    expect(JSON.stringify(await getSettings())).not.toContain('sk-or')
  })

  it('clears the key with an explicit null', async () => {
    await updateSettings({ openrouterKey: 'sk-or-x' })
    await updateSettings({ openrouterKey: null })
    expect(await getOpenrouterKey()).toBeNull()
    expect(await getSettings()).toMatchObject({ hasOpenrouterKey: false })
  })

  it('leaves the key alone when the patch does not mention it', async () => {
    await updateSettings({ openrouterKey: 'sk-or-x' })
    await updateSettings({ analyzeImages: true })
    expect(await getOpenrouterKey()).toBe('sk-or-x')
    expect(await getSettings()).toMatchObject({ hasOpenrouterKey: true, analyzeImages: true })
  })

  it('toggles each medium independently', async () => {
    await updateSettings({ analyzeImages: true })
    expect(await getSettings()).toMatchObject({ analyzeImages: true, analyzeAudio: false })
    await updateSettings({ analyzeAudio: true, analyzeImages: false })
    expect(await getSettings()).toMatchObject({ analyzeImages: false, analyzeAudio: true })
  })

  it('accepts catalog model ids and ignores anything else', async () => {
    await updateSettings({ visionModel: 'glm-4.6v', transcriptionModel: 'whisper-large-v3-turbo' })
    expect(await getSettings()).toMatchObject({
      visionModel: 'glm-4.6v', transcriptionModel: 'whisper-large-v3-turbo',
    })
    await updateSettings({ visionModel: 'claude-opus-5', transcriptionModel: '' })
    expect(await getSettings()).toMatchObject({
      visionModel: 'glm-4.6v', transcriptionModel: 'whisper-large-v3-turbo',
    })
  })

  it('falls back to the default when a stored model leaves the catalog', async () => {
    await db.update(settings).set({ visionModel: 'delisted-model' })
    expect(await getSettings()).toMatchObject({ visionModel: DEFAULT_VISION_MODEL })
  })

  it('never writes a second settings row', async () => {
    await updateSettings({ analyzeImages: true })
    await updateSettings({ analyzeAudio: true })
    expect(await db.select().from(settings)).toHaveLength(1)
  })
})
