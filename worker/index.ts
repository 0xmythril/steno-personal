import { env } from '@/lib/env'
import { log, errorShape } from '@/lib/log'
import { purgeExpiredSessions } from '@/lib/services/sessions'
import { SessionManager } from '@/lib/channels/session-manager'
import { buildPorts } from '@/lib/channels/ports'
import { coalesceRuns, processPendingMedia } from '@/lib/services/media'
import { runMediaAnalysis, type MediumResult } from '@/lib/services/media-analysis'

const TICK_MS = 3000
const SESSION_PURGE_EVERY_MS = 60_000
// Analysis is the expensive, rate-limited half: a fixed floor between passes,
// plus an immediate pass after any media actually lands so a new image becomes
// searchable in about the time one provider call takes, not in five minutes.
const ANALYSIS_INTERVAL_MS = 5 * 60_000

// Ensures at most one call to fn() is in flight at a time; a caller that
// arrives while one is running joins that same promise rather than starting a
// second one. Unlike coalesceRuns, there is no queued rerun — the spending
// drain must not double-bill, so a join here just reuses the in-flight
// result rather than triggering a second pass. Nothing in this worker can
// actually trigger an overlapping call today (the tick loop awaits every
// drain in strict sequence), so this is a cheap invariant rather than a
// scheduling primitive the current wiring depends on.
function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null
  return () => {
    if (!inFlight) inFlight = fn().finally(() => { inFlight = null })
    return inFlight
  }
}

// What the analysis drain logs: counts and kinds only — never the ErrorShape
// text a fault carries (invariant 6), so `errors` is collapsed to a count.
function summarizeMedium(m: MediumResult) {
  return m.ran
    ? { ran: true as const, done: m.done, failed: m.failed, skipped: m.skipped, retried: m.retried, errors: m.errors.length }
    : { ran: false as const, reason: m.reason }
}

async function main() {
  const ports = buildPorts({ apiId: env.TELEGRAM_API_ID, apiHash: env.TELEGRAM_API_HASH })
  const manager = new SessionManager(ports)
  log.info({ channels: [...ports.keys()] }, 'worker started')

  // Shutdown is cooperative: the signal only flips the flag and wakes the
  // sleep. stopAll() runs AFTER the loop exits, so it never overlaps an
  // in-flight tick() on the same SessionManager state.
  let stopping = false
  let wake: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    stopping = true
    if (timer) clearTimeout(timer)
    wake?.()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  let analysisDueAt = 0

  // Coalesced: the tick and the post-pass kick can land together, and an
  // unguarded overlap downloads every file twice (see coalesceRuns).
  const drainMedia = coalesceRuns(async () => {
    const { done, failed, skipped } = await processPendingMedia(manager.downloaders())
    // Counts and kinds only — never a filename, mime, or chat (invariant 6).
    if (done || failed) log.info({ done, failed, skipped }, 'media drained')
    // Something new is on disk: analyse it now rather than at the next
    // interval. Gated inside runMediaAnalysis, so this is free when
    // enrichment is off.
    if (done > 0) analysisDueAt = 0
  })

  const runAnalysisOnce = singleFlight(runMediaAnalysis)

  const drainAnalysis = async () => {
    if (Date.now() < analysisDueAt) return
    analysisDueAt = Date.now() + ANALYSIS_INTERVAL_MS
    const res = await runAnalysisOnce()
    if (res.ran) log.info({ image: summarizeMedium(res.image), audio: summarizeMedium(res.audio) }, 'analysis drained')
  }

  let lastPurge = 0
  for (;;) {
    if (stopping) break
    try {
      await manager.tick()
      if (Date.now() - lastPurge > SESSION_PURGE_EVERY_MS) {
        lastPurge = Date.now()
        const purged = await purgeExpiredSessions()
        if (purged) log.info({ purged }, 'expired sessions purged')
      }
      // Re-checked here, not just at the top of the loop: manager.tick() can
      // run long, and a drain must never be STARTED after a signal has asked
      // the worker to stop — it would only delay stopAll(). One already in
      // flight is still awaited to completion; only a not-yet-started one is
      // skipped.
      if (!stopping) {
        await drainMedia()
        if (!stopping) await drainAnalysis()
      }
    } catch (e) {
      // One bad tick must never end the worker: the next one retries.
      // errorShape strips bound query parameters from driver errors.
      log.error({ err: errorShape(e) }, 'tick failed')
    }
    if (stopping) break // a signal that arrived during the tick must not wait out a sleep
    await new Promise<void>(r => { wake = r; timer = setTimeout(r, TICK_MS) })
    wake = null
  }
  log.info('worker stopping')
  await manager.stopAll()
  process.exit(0)
}

main().catch(e => { log.error({ err: errorShape(e) }, 'worker crashed'); process.exit(1) })
