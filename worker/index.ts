import { env } from '@/lib/env'
import { log, errorShape } from '@/lib/log'
import { purgeExpiredSessions } from '@/lib/services/sessions'
import { SessionManager } from '@/lib/channels/session-manager'
import { buildPorts } from '@/lib/channels/ports'

const TICK_MS = 3000
const SESSION_PURGE_EVERY_MS = 60_000

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
