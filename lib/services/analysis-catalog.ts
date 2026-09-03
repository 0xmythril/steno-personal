// The menu of models the owner may pick for each enriched medium. Checked in
// rather than a table on purpose: which provider receives your chat images is
// a decision that belongs in a diff you can read, and the prices ride along so
// per-row cost can be computed at analysis time (media_analysis.cost_microusd).
//
// One provider, one key, one adapter: there are deliberately no
// direct-to-vendor entries — they would mean a second secret, a second SDK,
// and a second wire format for no gain to a self-hoster who already has an
// OpenRouter key.
//
// `provider` is the data-destination disclosure the settings picker shows:
// switching models is switching who receives your images and voice notes.
// Prices are snapshotted 2026-09 — re-verify when editing this list.

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

export type VisionCatalogEntry = {
  id: string
  label: string
  // Model name as OpenRouter expects it.
  model: string
  provider: string
  // $ per million tokens.
  inPerMTok: number
  outPerMTok: number
}

// Ordered by recommendation: the first entry is what the settings picker
// preselects. Qwen leads — at roughly $0.26 per thousand images the budget
// tier is where a personal archive should start.
export const VISION_CATALOG: readonly VisionCatalogEntry[] = [
  {
    id: 'qwen3-vl-32b', label: 'Qwen3-VL 32B (recommended, budget)',
    model: 'qwen/qwen3-vl-32b-instruct', provider: 'OpenRouter → Alibaba Qwen',
    inPerMTok: 0.104, outPerMTok: 0.416,
  },
  {
    id: 'glm-4.6v', label: 'GLM-4.6V (budget)',
    model: 'z-ai/glm-4.6v', provider: 'OpenRouter → Zhipu AI',
    inPerMTok: 0.3, outPerMTok: 0.9,
  },
]

export const DEFAULT_VISION_MODEL = VISION_CATALOG[0].id

export function getVisionCatalogEntry(id: string | null | undefined): VisionCatalogEntry | null {
  if (!id) return null
  return VISION_CATALOG.find(e => e.id === id) ?? null
}

// $/MTok is exactly micro-dollars per token, so integer micro-USD is a
// straight multiply-and-round — no float money is ever stored.
export function costMicroUsd(
  entry: Pick<VisionCatalogEntry, 'inPerMTok' | 'outPerMTok'>, inputTokens: number, outputTokens: number,
): number {
  return Math.round(inputTokens * entry.inPerMTok + outputTokens * entry.outPerMTok)
}

// The transcription half. Every entry is served by OpenRouter's
// /audio/transcriptions endpoint, so the whole list runs on the one key the
// vision catalog already needs.
//
// Prices are integer MICRO-dollars per SECOND, not dollars: $0.000008/s IS 8
// micro-USD/s, so cost stays an integer multiply. Slugs and prices read off
// OpenRouter's transcription list — re-verify when editing, same rule as above.
export type TranscriptionCatalogEntry = {
  id: string
  label: string
  model: string
  provider: string
  perSecondMicroUsd: number
}

export const TRANSCRIPTION_CATALOG: readonly TranscriptionCatalogEntry[] = [
  {
    id: 'qwen3-asr-1.7b', label: 'Qwen3 ASR 1.7B (recommended)',
    model: 'qwen/qwen3-asr-1.7b', provider: 'OpenRouter → Alibaba Qwen',
    perSecondMicroUsd: 8,
  },
  {
    id: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo (cheapest)',
    model: 'openai/whisper-large-v3-turbo', provider: 'OpenRouter → OpenAI',
    perSecondMicroUsd: 3,
  },
  {
    id: 'voxtral-mini-3b', label: 'Voxtral Mini 3B (EU provider)',
    model: 'mistralai/voxtral-mini-3b-2507', provider: 'OpenRouter → Mistral',
    perSecondMicroUsd: 17,
  },
  {
    id: 'voxtral-small-24b-stt', label: 'Voxtral Small 24B (best quality)',
    model: 'mistralai/voxtral-small-24b-2507-stt', provider: 'OpenRouter → Mistral',
    perSecondMicroUsd: 50,
  },
]

export const DEFAULT_TRANSCRIPTION_MODEL = TRANSCRIPTION_CATALOG[0].id

export function getTranscriptionCatalogEntry(id: string | null | undefined): TranscriptionCatalogEntry | null {
  if (!id) return null
  return TRANSCRIPTION_CATALOG.find(e => e.id === id) ?? null
}

// ASR returns text only, so the one-line summary is a second, text-only call.
// ONE model rather than a per-entry field: every entry would name the same
// slug, and this one is already in the vision catalog above — already priced,
// already disclosed.
export const SUMMARY_MODEL = 'qwen/qwen3-vl-32b-instruct'
// Derived, not duplicated: a literal copy here would keep billing the old rate
// the day that entry is repriced.
const SUMMARY_ENTRY = VISION_CATALOG.find(e => e.model === SUMMARY_MODEL)
if (!SUMMARY_ENTRY) throw new Error(`SUMMARY_MODEL '${SUMMARY_MODEL}' has no matching VISION_CATALOG entry`)
export const SUMMARY_IN_PER_MTOK = SUMMARY_ENTRY.inPerMTok
export const SUMMARY_OUT_PER_MTOK = SUMMARY_ENTRY.outPerMTok

// Audio seconds plus the summary's tokens, as one integer micro-dollar figure,
// so cost_microusd means the same thing whatever medium produced the row.
export function transcriptionCostMicroUsd(
  entry: Pick<TranscriptionCatalogEntry, 'perSecondMicroUsd'>,
  seconds: number, inputTokens: number, outputTokens: number,
): number {
  return Math.round(
    seconds * entry.perSecondMicroUsd
    + inputTokens * SUMMARY_IN_PER_MTOK
    + outputTokens * SUMMARY_OUT_PER_MTOK,
  )
}
