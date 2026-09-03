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

  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    log.info('worker stopping')
    await manager.stopAll()
    process.exit(0)
  }
  process.on('SIGTERM', () => { void stop() })
  process.on('SIGINT', () => { void stop() })

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
      log.error({ err: errorShape(e) }, 'tick failed')
    }
    await new Promise(r => setTimeout(r, TICK_MS))
  }
}

main().catch(e => { log.error({ err: errorShape(e) }, 'worker crashed'); process.exit(1) })
