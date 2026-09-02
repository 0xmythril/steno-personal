import { log } from '@/lib/log'
import { purgeExpiredSessions } from '@/lib/services/sessions'

const TICK_MS = 60_000

async function main() {
  log.info('worker started (no channels yet)')
  let stopping = false
  let wake: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  // The sleep between ticks is a promise we can resolve early (and a timer
  // we can clear), not a bare await-setTimeout, so SIGTERM/SIGINT wakes the
  // loop immediately instead of waiting up to TICK_MS and blowing past
  // Docker's stop grace period.
  const stop = () => {
    stopping = true
    if (timer) clearTimeout(timer)
    wake?.()
  }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
  for (;;) {
    if (stopping) break
    try {
      const purged = await purgeExpiredSessions()
      if (purged) log.info({ purged }, 'expired sessions purged')
    } catch (e) { log.error({ err: e }, 'tick failed') }
    await new Promise<void>(r => { wake = r; timer = setTimeout(r, TICK_MS) })
  }
  process.exit(0)
}

main().catch(e => { log.error({ err: e }, 'worker crashed'); process.exit(1) })
