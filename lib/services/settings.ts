import { db } from '@/lib/db/client'
import { settings } from '@/lib/db/schema'
import { decryptSecret, encryptSecret } from '@/lib/services/crypto'
import {
  DEFAULT_TRANSCRIPTION_MODEL, DEFAULT_VISION_MODEL,
  getTranscriptionCatalogEntry, getVisionCatalogEntry,
} from '@/lib/services/analysis-catalog'
import { eq } from 'drizzle-orm'

// There is no users table, so this one row IS the preferences. The migration
// seeds it; every write upserts so a hand-emptied table self-heals.
export const SETTINGS_ID = 1

export type Settings = {
  hasOpenrouterKey: boolean
  analyzeImages: boolean
  analyzeAudio: boolean
  visionModel: string
  transcriptionModel: string
  telemetryEnabled: boolean
}

async function readRow() {
  const [row] = await db.select().from(settings).where(eq(settings.id, SETTINGS_ID)).limit(1)
  return row ?? null
}

// Portal-facing: the key is reported as a boolean and never returned, in any
// shape, to any caller but getOpenrouterKey (invariant 5). A stored model id
// that has since left the catalog reads back as the current default rather
// than as a value no picker can render.
export async function getSettings(): Promise<Settings> {
  const row = await readRow()
  return {
    hasOpenrouterKey: !!row?.openrouterKeyCiphertext,
    analyzeImages: row?.analyzeImages ?? false,
    analyzeAudio: row?.analyzeAudio ?? false,
    visionModel: getVisionCatalogEntry(row?.visionModel)?.id ?? DEFAULT_VISION_MODEL,
    transcriptionModel: getTranscriptionCatalogEntry(row?.transcriptionModel)?.id ?? DEFAULT_TRANSCRIPTION_MODEL,
    // Defaults to true, matching the column, so a row the migration has not
    // reached yet reads the same as one it has.
    telemetryEnabled: row?.telemetryEnabled ?? true,
  }
}

export type SettingsPatch = Partial<{
  openrouterKey: string | null
  analyzeImages: boolean
  analyzeAudio: boolean
  visionModel: string
  transcriptionModel: string
  telemetryEnabled: boolean
}>

// Absent field = leave alone; `openrouterKey: null` = clear it. That
// distinction is why the key check is `in patch` rather than `!== undefined`:
// "clear the key" and "do not touch the key" must not collapse.
//
// A model id that is not in the catalog is IGNORED rather than thrown: the
// only way to send one is a tampered form post, and a 500 on the settings
// page is a worse answer than a no-op the next render makes obvious.
export async function updateSettings(patch: SettingsPatch): Promise<void> {
  const values: Partial<typeof settings.$inferInsert> = {}
  if ('openrouterKey' in patch) {
    const key = patch.openrouterKey?.trim()
    values.openrouterKeyCiphertext = key ? encryptSecret(key) : null
  }
  if (patch.analyzeImages !== undefined) values.analyzeImages = patch.analyzeImages
  if (patch.analyzeAudio !== undefined) values.analyzeAudio = patch.analyzeAudio
  if (patch.visionModel !== undefined && getVisionCatalogEntry(patch.visionModel)) {
    values.visionModel = patch.visionModel
  }
  if (patch.transcriptionModel !== undefined && getTranscriptionCatalogEntry(patch.transcriptionModel)) {
    values.transcriptionModel = patch.transcriptionModel
  }
  if (patch.telemetryEnabled !== undefined) values.telemetryEnabled = patch.telemetryEnabled
  if (Object.keys(values).length === 0) return
  await db.insert(settings).values({ id: SETTINGS_ID, ...values })
    .onConflictDoUpdate({ target: settings.id, set: values })
}

// Worker only. Returns null when nothing is saved, and also when the
// ciphertext no longer decrypts (SECRET_KEY changed) — which reads to every
// caller as "enrichment is off", exactly the safe outcome.
export async function getOpenrouterKey(): Promise<string | null> {
  const row = await readRow()
  if (!row?.openrouterKeyCiphertext) return null
  return decryptSecret(row.openrouterKeyCiphertext)
}
