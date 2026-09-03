import { db } from '@/lib/db/client'
import { media, mediaAnalysis, messages } from '@/lib/db/schema'
import { env } from '@/lib/env'
import { mediaFilePath } from '@/lib/services/media'
import { getOpenrouterKey, getSettings } from '@/lib/services/settings'
import {
  AnalysisSkip, BilledError, type SkipUsage, type Transcriber, type VisionAnalyzer,
} from '@/lib/services/analyzers/types'
import { ANALYZABLE_MIMES, MAX_ANALYSIS_BYTES, openRouterVisionAnalyzer } from '@/lib/services/analyzers/vision'
import {
  MAX_TRANSCRIPTION_BYTES, MAX_TRANSCRIPTION_SECONDS, openRouterTranscriber, sttFormatFor,
} from '@/lib/services/analyzers/transcription'
import {
  costMicroUsd, getTranscriptionCatalogEntry, getVisionCatalogEntry, transcriptionCostMicroUsd,
  type TranscriptionCatalogEntry, type VisionCatalogEntry,
} from '@/lib/services/analysis-catalog'
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import { readFileSync } from 'node:fs'

// One import site for the pipeline's vocabulary, even though the
// implementations live beside the adapters.
export { AnalysisSkip, BilledError }
export type { VisionAnalyzer, Transcriber }

export type Medium = 'image' | 'audio'

// Queue fill. A media row is analyzable iff it is downloaded, its message is
// still live, and it matches the medium's shape. This is also the backfill:
// turning a toggle on makes history match, and `batch` meters it out one pass
// at a time. Newest first, so fresh media becomes searchable before old.
//
// Every audio predicate FAILS CLOSED on null: a row whose is_voice_note or
// duration_seconds is unknown is never enqueued, because unknown length must
// not become unbounded spend.
export async function enqueueMediaAnalysis(medium: Medium, opts: { batch?: number } = {}): Promise<number> {
  const batch = opts.batch ?? 20
  const mediumCond = medium === 'image'
    ? and(eq(messages.type, 'image'), inArray(media.mimeType, ANALYZABLE_MIMES))!
    : and(
        eq(messages.type, 'audio'),
        eq(media.isVoiceNote, true),
        isNotNull(media.durationSeconds),
        lte(media.durationSeconds, MAX_TRANSCRIPTION_SECONDS),
      )!
  const candidates = await db.select({ mediaId: media.id })
    .from(media)
    .innerJoin(messages, eq(media.messageId, messages.id))
    .leftJoin(mediaAnalysis, eq(mediaAnalysis.mediaId, media.id))
    .where(and(
      eq(media.status, 'done'),
      isNull(messages.deletedAt),
      isNull(mediaAnalysis.id),
      mediumCond,
    ))
    .orderBy(desc(messages.sentAt))
    .limit(batch)
  if (candidates.length === 0) return 0
  const inserted = await db.insert(mediaAnalysis)
    .values(candidates.map(c => ({ mediaId: c.mediaId, medium })))
    .onConflictDoNothing()
    .returning({ id: mediaAnalysis.id })
  return inserted.length
}

// `errors` holds the faults that could not even be recorded on their own row —
// a terminal write that itself threw. The row keeps whatever state it had and
// the next pass picks it up again; the pass still REPORTS the fault rather
// than swallowing it or abandoning the rows behind it.
export type DrainSummary = {
  done: number; failed: number; skipped: number; retried: number; errors: ErrorShape[]
}

export type AnalysisJob =
  | { medium: 'image'; analyzer: VisionAnalyzer; entry: Pick<VisionCatalogEntry, 'id' | 'inPerMTok' | 'outPerMTok'> }
  | { medium: 'audio'; transcriber: Transcriber; entry: Pick<TranscriptionCatalogEntry, 'id' | 'perSecondMicroUsd'> }

// Sequential on purpose: this is background enrichment, and one in-flight
// provider call keeps rate limits and spend easy to reason about.
export async function processPendingAnalyses(
  job: AnalysisJob, opts: { batch?: number; maxAttempts?: number } = {},
): Promise<DrainSummary> {
  const batch = opts.batch ?? 20
  const maxAttempts = opts.maxAttempts ?? 3
  const summary: DrainSummary = { done: 0, failed: 0, skipped: 0, retried: 0, errors: [] }
  const rows = await db.select({
    id: mediaAnalysis.id,
    attempts: mediaAnalysis.attempts,
    // Read so a later UNBILLED failure cannot erase the completed_at stamp of
    // an earlier billed attempt and hide that spend from the daily cap.
    costMicroUsd: mediaAnalysis.costMicroUsd,
    messageId: messages.id,
    storagePath: media.storagePath,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes,
    // Sender-declared duration: the transcriber's fallback cost basis.
    durationSeconds: media.durationSeconds,
    deletedAt: messages.deletedAt,
  })
    .from(mediaAnalysis)
    .innerJoin(media, eq(mediaAnalysis.mediaId, media.id))
    .innerJoin(messages, eq(media.messageId, messages.id))
    .where(and(eq(mediaAnalysis.status, 'pending'), eq(mediaAnalysis.medium, job.medium)))
    .orderBy(mediaAnalysis.createdAt)
    .limit(batch)

  for (const row of rows) {
    try {
      // The free gates first, so a row that can never be analyzed costs
      // nothing to reject.
      //
      // A message tombstoned before the batch was fetched must never be sent
      // to a provider (invariant 4).
      if (row.deletedAt) throw new AnalysisSkip('message deleted')
      if (!row.storagePath || !row.mimeType) throw new AnalysisSkip('media incomplete')
      // Checked BEFORE the read: media is capped at 100 MiB and an oversize
      // row must not be loaded into the worker's heap just to be thrown away.
      // FAILS CLOSED — an unknown size is not a licence to hand a provider an
      // unbounded payload, so null skips exactly as an oversize row does.
      const maxBytes = job.medium === 'image' ? MAX_ANALYSIS_BYTES : MAX_TRANSCRIPTION_BYTES
      if (row.sizeBytes === null || row.sizeBytes > maxBytes) {
        throw new AnalysisSkip('size unknown or over cap')
      }
      // The snapshot above was taken when the whole batch was fetched, and the
      // rows ahead of this one each took a provider call's worth of wall
      // clock. One cheap re-read immediately before the spend closes that
      // window: a message deleted mid-drain never reaches a provider.
      const [live] = await db.select({ deletedAt: messages.deletedAt })
        .from(messages).where(eq(messages.id, row.messageId)).limit(1)
      if (!live || live.deletedAt) throw new AnalysisSkip('message deleted')
      const bytes = readFileSync(mediaFilePath(row.storagePath))
      const fields = job.medium === 'image'
        ? await runImage(job, row.mimeType, bytes)
        : await runAudio(job, row.mimeType, bytes, row.durationSeconds)
      await db.update(mediaAnalysis).set({ ...fields, status: 'done', completedAt: new Date() })
        .where(eq(mediaAnalysis.id, row.id))
      summary.done++
    } catch (err) {
      // The terminal write is itself a database call and can fail — a locked
      // file, a closed handle. If it does, this row keeps its current state
      // (the next pass re-reads it) and the remaining rows still get their
      // turn; one unwritable row must not abandon the rest of the batch.
      try {
        if (err instanceof AnalysisSkip) {
          await db.update(mediaAnalysis)
            .set({ status: 'skipped', completedAt: new Date(), error: err.message, ...billedFields(job, err.usage) })
            .where(eq(mediaAnalysis.id, row.id))
          summary.skipped++
        } else {
          const attempts = row.attempts + 1
          const failed = attempts >= maxAttempts
          // A BilledError is a call the provider accepted and charged for whose
          // body was unusable. It still burns an attempt — the fault may be
          // transient — but the money is spent, so the cost is written now
          // rather than at the third attempt. countRecentAnalyses filters on
          // completed_at, so a billed attempt is timestamped even while it
          // remains 'pending'; and a row that already carries a cost keeps its
          // stamp, so a later unbilled failure cannot hide earlier spend.
          const billed = err instanceof BilledError
          const stamped = failed || billed || row.costMicroUsd !== null
          await db.update(mediaAnalysis)
            .set({
              attempts, status: failed ? 'failed' : 'pending',
              // Provider diagnostics, capped. Stored, never logged.
              error: errorShape(err).message.slice(0, 300),
              completedAt: stamped ? new Date() : null,
              ...(billed ? billedFields(job, err.usage) : {}),
            })
            .where(eq(mediaAnalysis.id, row.id))
          if (failed) summary.failed++
          else summary.retried++
        }
      } catch (writeErr) {
        summary.errors.push(errorShape(writeErr))
      }
    }
  }
  return summary
}

// A skip decided AFTER a paid call (a silent note) still records the model and
// the cost, so the daily limit and any cost read see it. A skip decided before
// any call carries no usage and writes none of this: its cost column stays
// null, which is what "never billed" looks like.
function billedFields(job: AnalysisJob, usage: SkipUsage | undefined) {
  if (!usage) return {}
  const inputTokens = usage.inputTokens ?? 0
  const outputTokens = usage.outputTokens ?? 0
  const catalog = job.medium === 'image'
    ? costMicroUsd(job.entry, inputTokens, outputTokens)
    : transcriptionCostMicroUsd(job.entry, usage.seconds ?? 0, inputTokens, outputTokens)
  return { model: job.entry.id, costMicroUsd: usage.providerCostMicroUsd ?? catalog }
}

// The two medium-specific halves. Everything else about a row — the gates, the
// size limit, attempts, terminal states — is shared above.
async function runImage(job: Extract<AnalysisJob, { medium: 'image' }>, mime: string, bytes: Buffer) {
  const r = await job.analyzer.analyze(bytes, mime)
  return {
    extractedText: r.ocrText, description: r.description, kind: r.kind, confidence: r.confidence,
    model: job.entry.id,
    // The provider's own figure is what will appear on the user's bill; the
    // catalog estimate is the fallback when it reports nothing.
    costMicroUsd: r.providerCostMicroUsd ?? costMicroUsd(job.entry, r.inputTokens, r.outputTokens),
  }
}

async function runAudio(
  job: Extract<AnalysisJob, { medium: 'audio' }>, mime: string, bytes: Buffer, declaredDurationSeconds: number | null,
) {
  // A mime the endpoint will not accept is a fact about the file: skipped,
  // never retried.
  const format = sttFormatFor(mime)
  if (!format) throw new AnalysisSkip('unsupported audio format')
  const r = await job.transcriber.transcribe(bytes, format, declaredDurationSeconds)
  return {
    extractedText: r.text, description: r.description, language: r.language, model: job.entry.id,
    costMicroUsd: r.providerCostMicroUsd
      ?? transcriptionCostMicroUsd(job.entry, r.seconds, r.inputTokens, r.outputTokens),
  }
}

// Backstop against runaway spend: BILLED analyses in the trailing 24 h — every
// row with a cost, i.e. done rows plus skips decided after a paid call.
// Counting only 'done' would let a run of silent notes spend without tripping;
// counting 'failed' rows, which never reached a billable response, would stop
// the drain over calls nobody paid for.
export async function countRecentAnalyses(): Promise<number> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(mediaAnalysis)
    .where(and(isNotNull(mediaAnalysis.costMicroUsd), gt(mediaAnalysis.completedAt, dayAgo)))
  return Number(row?.n ?? 0)
}

// What a pass that threw reports: strings only — the class, a driver code if
// there is one, and the message. Never the error object, which can carry a
// statement and its bound parameters.
export type ErrorShape = { name: string; code: string | null; message: string }
export function errorShape(err: unknown): ErrorShape {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code
    return { name: err.name, code: typeof code === 'string' ? code : null, message: err.message }
  }
  return { name: 'Error', code: null, message: String(err) }
}

export type MediumResult =
  | { ran: false; reason: 'no_key' | 'disabled' | 'daily_limit' }
  | { ran: false; reason: 'error'; error: ErrorShape }
  | ({ ran: true; enqueued: number } & DrainSummary)

// The whole drain as the worker calls it. NEVER throws, under any fault: the
// worker runs it out of a timer, and an escaped rejection there takes the
// container down. The gate reads are inside the guard too — a settings read
// or a count against a locked database is exactly the kind of fault that
// would otherwise escape before the per-medium isolation below begins.
export async function runMediaAnalysis(
  opts: { batch?: number } = {},
): Promise<{ ran: boolean; image: MediumResult; audio: MediumResult }> {
  try {
    return await gatedMediaAnalysis(opts)
  } catch (err) {
    const failure = (): MediumResult => ({ ran: false, reason: 'error', error: errorShape(err) })
    return { ran: false, image: failure(), audio: failure() }
  }
}

// Resolve the gates, enqueue, process. The key and both toggles are re-read on
// every pass, so revoking a key or turning a medium off takes effect at the
// next tick rather than at the next restart.
async function gatedMediaAnalysis(
  opts: { batch?: number },
): Promise<{ ran: boolean; image: MediumResult; audio: MediumResult }> {
  const both = (reason: 'no_key' | 'daily_limit') =>
    ({ ran: false, image: { ran: false, reason } as MediumResult, audio: { ran: false, reason } as MediumResult })

  const key = await getOpenrouterKey()
  if (!key) return both('no_key')
  // 0 is a deliberate full stop, not "no limit configured".
  const limit = env.ANALYSIS_DAILY_LIMIT
  if (await countRecentAnalyses() >= limit) return both('daily_limit')

  const s = await getSettings()
  const batch = opts.batch ?? env.ANALYSIS_BACKFILL_BATCH
  const image = s.analyzeImages
    ? await safePass(() => runImagePass(s.visionModel, key, batch))
    : { ran: false, reason: 'disabled' } as MediumResult
  const audio = s.analyzeAudio
    ? await safePass(() => runAudioPass(s.transcriptionModel, key, batch))
    : { ran: false, reason: 'disabled' } as MediumResult
  return { ran: image.ran || audio.ran, image, audio }
}

// Isolates one medium's pass from the other. Most faults are already caught
// per row inside processPendingAnalyses, but the queries OUTSIDE that try —
// the row fetch and the enqueue — are not, and a rejection there must not
// cancel the other medium's pass for the tick.
async function safePass(run: () => Promise<MediumResult>): Promise<MediumResult> {
  try {
    return await run()
  } catch (err) {
    return { ran: false, reason: 'error', error: errorShape(err) }
  }
}

// getSettings maps a stored model id that has left the catalog back to the
// current default, so neither lookup below can miss. There is therefore no
// 'not_configured' result: it was unreachable, and a result variant nothing
// can produce is a variant no caller ever handles honestly. If the invariant
// were ever broken the throw becomes safePass's `reason: 'error'`, which is
// what a genuinely impossible state deserves.
async function runImagePass(modelId: string, apiKey: string, batch: number): Promise<MediumResult> {
  const entry = getVisionCatalogEntry(modelId)
  if (!entry) throw new Error(`vision model is not in the catalog: ${modelId}`)
  const analyzer = openRouterVisionAnalyzer(entry, apiKey)
  const enqueued = await enqueueMediaAnalysis('image', { batch })
  return { ran: true, enqueued, ...await processPendingAnalyses({ medium: 'image', analyzer, entry }, { batch }) }
}

async function runAudioPass(modelId: string, apiKey: string, batch: number): Promise<MediumResult> {
  const entry = getTranscriptionCatalogEntry(modelId)
  if (!entry) throw new Error(`transcription model is not in the catalog: ${modelId}`)
  const transcriber = openRouterTranscriber(entry, apiKey)
  const enqueued = await enqueueMediaAnalysis('audio', { batch })
  return { ran: true, enqueued, ...await processPendingAnalyses({ medium: 'audio', transcriber, entry }, { batch }) }
}
