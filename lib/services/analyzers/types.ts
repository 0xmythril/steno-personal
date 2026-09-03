// The vocabulary the pipeline speaks. It never sees a vendor: swapping models
// is a catalog change plus, at most, one adapter.

export type MediaKind = 'screenshot' | 'event' | 'photo' | 'document' | 'meme' | 'chart' | 'other'
export const MEDIA_KINDS = ['screenshot', 'event', 'photo', 'document', 'meme', 'chart', 'other'] as const

export type AnalysisResult = {
  ocrText: string | null
  description: string | null
  kind: MediaKind
  confidence: number
  inputTokens: number
  outputTokens: number
  // What OpenRouter itself said the call cost, in integer micro-USD, or null
  // when it reported nothing. Preferred over the catalog estimate when
  // present: it is the number that will appear on the user's own bill.
  providerCostMicroUsd: number | null
}

export type VisionAnalyzer = {
  analyze(image: Buffer, mime: string): Promise<AnalysisResult>
}

// What one transcribed voice note yields. `text` is the verbatim transcript
// (the searchable payload) and `description` the one-line summary — the same
// pairing an image produces, so the drain writes both media the same way.
export type TranscriptionResult = {
  text: string
  description: string
  language: string | null
  // Provider-billed audio seconds: what cost is computed from.
  seconds: number
  // Summary call only — ASR is not billed by token.
  inputTokens: number
  outputTokens: number
  providerCostMicroUsd: number | null
}

export type Transcriber = {
  // `declaredDurationSeconds` is media.duration_seconds, already checked
  // against MAX_TRANSCRIPTION_SECONDS by the enqueue gate. It is the fallback
  // cost basis when the provider's own usage.seconds is absent or non-numeric,
  // so a malformed response degrades to a real number instead of billing zero.
  transcribe(audio: Buffer, format: string, declaredDurationSeconds: number | null): Promise<TranscriptionResult>
}

// Provider `usage.cost` is dollars as a float; storage is integer micro-USD.
// Anything absent, non-numeric, or negative is "not reported", never 0 — a 0
// would read as a free call.
export function usdToMicroUsd(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v * 1e6) : null
}

// Some models wrap JSON in a markdown fence despite instructions. Both
// adapters parse through this, so the defence lives once.
export function extractJson(text: string): unknown {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
}

// Provider usage a skip decision was made AFTER paying for — a silent note's
// ASR seconds. Carried on the skip so the row still records what was billed;
// a skip decided before any call has none.
export type SkipUsage = {
  seconds?: number
  inputTokens?: number
  outputTokens?: number
  providerCostMicroUsd?: number | null
}

// A deliberate non-result (silence, an unusable format, an oversize file, a
// toggle turned off mid-queue): the row is marked 'skipped' and never retried,
// unlike a thrown Error which burns an attempt.
export class AnalysisSkip extends Error {
  constructor(message: string, public readonly usage?: SkipUsage) {
    super(message)
    this.name = 'AnalysisSkip'
  }
}

// A call the provider ACCEPTED and billed, whose body could not be used — a
// truncated or fenced JSON object, a refusal, a changed wire format. Not an
// AnalysisSkip: the fault may well be transient, so the row still burns an
// attempt and is retried. But the money is already spent, so the usage rides
// along and the drain records it on the row — otherwise the daily cap, which
// counts rows with a recorded cost, cannot see spend from a model that
// systematically answers with something unparseable.
export class BilledError extends Error {
  constructor(message: string, public readonly usage: SkipUsage) {
    super(message)
    this.name = 'BilledError'
  }
}
