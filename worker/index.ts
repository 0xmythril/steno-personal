import { env } from '@/lib/env'
import { log, errorShape } from '@/lib/log'
import { purgeExpiredSessions } from '@/lib/services/sessions'
import { SessionManager } from '@/lib/channels/session-manager'
import { buildPorts } from '@/lib/channels/ports'
import { buildDrains } from '@/worker/drains'
import { sendTelemetryPing } from '@/lib/services/telemetry'

const TICK_MS = 3000
const SESSION_PURGE_EVERY_MS = 60_000
// How often the worker ASKS. sendTelemetryPing enforces the real once-a-day
// interval itself, from a timestamp in the database, so a restart loop cannot
// turn into a flood.
const TELEMETRY_CHECK_EVERY_MS = 60 * 60_000

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

  // The schedule itself lives in worker/drains.ts, where it can be driven
  // without a process, a signal, or a timer. `stopping` is read through a
  // closure rather than passed by value: manager.tick() can run long, and a
  // drain must never be STARTED after a signal has arrived.
  const { drainMedia, drainAnalysis } = buildDrains({
    downloaders: () => manager.downloaders(),
    stopping: () => stopping,
  })

  let lastPurge = 0
  let lastTelemetryCheck = 0
  for (;;) {
    if (stopping) break
    try {
      await manager.tick()
      if (Date.now() - lastPurge > SESSION_PURGE_EVERY_MS) {
        lastPurge = Date.now()
        const purged = await purgeExpiredSessions()
        if (purged) log.info({ purged }, 'expired sessions purged')
      }
      await drainMedia()
      await drainAnalysis()
      if (Date.now() - lastTelemetryCheck > TELEMETRY_CHECK_EVERY_MS) {
        lastTelemetryCheck = Date.now()
        // Never throws: every failure path inside returns an outcome, so a
        // collector that is down cannot cost the archive a tick.
        const outcome = await sendTelemetryPing()
        if (outcome === 'sent') log.info('anonymous usage ping sent')
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
