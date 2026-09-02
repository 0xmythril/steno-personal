import { log } from '@/lib/log'
import { purgeExpiredSessions } from '@/lib/services/sessions'

const TICK_MS = 60_000

async function main() {
  log.info('worker started (no channels yet)')
  let stopping = false
  const stop = () => { stopping = true }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
  for (;;) {
    if (stopping) break
    try {
      const purged = await purgeExpiredSessions()
      if (purged) log.info({ purged }, 'expired sessions purged')
    } catch (e) { log.error({ err: e }, 'tick failed') }
    await new Promise(r => setTimeout(r, TICK_MS))
  }
  process.exit(0)
}

main().catch(e => { log.error({ err: e }, 'worker crashed'); process.exit(1) })
