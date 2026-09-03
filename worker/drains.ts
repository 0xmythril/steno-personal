import { log } from '@/lib/log'
import { coalesceRuns, processPendingMedia as realProcessPendingMedia, type Downloader } from '@/lib/services/media'
import { runMediaAnalysis as realRunMediaAnalysis, type MediumResult } from '@/lib/services/media-analysis'

// Analysis is the expensive, rate-limited half: a fixed floor between passes,
// plus an immediate pass after any media actually lands so a new image becomes
// searchable in about the time one provider call takes, not in five minutes.
export const ANALYSIS_INTERVAL_MS = 5 * 60_000

// Ensures at most one call to fn() is in flight at a time; a caller that
// arrives while one is running joins that same promise rather than starting a
// second one. Unlike coalesceRuns, there is no queued rerun — the spending
// drain must not double-bill, so a join here just reuses the in-flight result
// rather than triggering a second pass. Nothing in the worker's own loop can
// trigger an overlapping call today (it awaits every drain in strict
// sequence), so this is a cheap invariant rather than a scheduling primitive
// the current wiring depends on — which is exactly why it is tested.
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null
  return () => {
    if (!inFlight) inFlight = fn().finally(() => { inFlight = null })
    return inFlight
  }
}

// What the analysis drain logs: counts and kinds only — never the ErrorShape
// text a fault carries (invariant 6), so `errors` is collapsed to a count.
export function summarizeMedium(m: MediumResult) {
  return m.ran
    ? { ran: true as const, done: m.done, failed: m.failed, skipped: m.skipped, retried: m.retried, errors: m.errors.length }
    : { ran: false as const, reason: m.reason }
}

export type DrainDeps = {
  // The connections with a live session right now — SessionManager.downloaders.
  downloaders: () => Map<string, Downloader>
  // Cooperative shutdown. Checked INSIDE each drain rather than at the call
  // site so the loop stays two awaits: a drain must never be STARTED after a
  // signal has asked the worker to stop, because it would only delay stopAll().
  // One already in flight is still awaited to completion.
  stopping?: () => boolean
  // Injected so the scheduling can be driven directly in a test. Production
  // passes nothing and gets the real drains.
  processPendingMedia?: typeof realProcessPendingMedia
  runMediaAnalysis?: typeof realRunMediaAnalysis
  now?: () => number
  analysisIntervalMs?: number
}

export type Drains = { drainMedia: () => Promise<void>; drainAnalysis: () => Promise<void> }

// The worker's whole drain schedule, with nothing in it that needs a process,
// a signal handler, or a timer to exercise. worker/index.ts is then only the
// loop and the wiring.
export function buildDrains(deps: DrainDeps): Drains {
  const processMedia = deps.processPendingMedia ?? realProcessPendingMedia
  const runAnalysis = deps.runMediaAnalysis ?? realRunMediaAnalysis
  const now = deps.now ?? Date.now
  const interval = deps.analysisIntervalMs ?? ANALYSIS_INTERVAL_MS
  const stopping = deps.stopping ?? (() => false)

  let analysisDueAt = 0

  // Coalesced: the tick and the post-pass kick can land together, and an
  // unguarded overlap downloads every file twice (see coalesceRuns).
  const drainMedia = coalesceRuns(async () => {
    if (stopping()) return
    const { done, failed, skipped } = await processMedia(deps.downloaders())
    // Counts and kinds only — never a filename, mime, or chat (invariant 6).
    if (done || failed) log.info({ done, failed, skipped }, 'media drained')
    // Something new is on disk: analyse it now rather than at the next
    // interval. Gated inside runMediaAnalysis, so this is free when
    // enrichment is off.
    if (done > 0) analysisDueAt = 0
  })

  const runAnalysisOnce = singleFlight(runAnalysis)

  const drainAnalysis = async () => {
    if (stopping()) return
    if (now() < analysisDueAt) return
    analysisDueAt = now() + interval
    const res = await runAnalysisOnce()
    if (res.ran) log.info({ image: summarizeMedium(res.image), audio: summarizeMedium(res.audio) }, 'analysis drained')
  }

  return { drainMedia, drainAnalysis }
}
