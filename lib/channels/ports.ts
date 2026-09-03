import { log } from '@/lib/log'
import { MtcuteTelegramPort } from '@/lib/channels/telegram'
import type { Channel, ChannelPort } from '@/lib/channels/port'

// Pure, so the "no credentials" path is testable without starting a loop.
// M2 adds the WhatsApp port here.
export function buildPorts(
  cfg: { apiId: number; apiHash: string },
  warn: (msg: string) => void = m => log.warn(m),
): Map<Channel, ChannelPort> {
  const ports = new Map<Channel, ChannelPort>()
  if (cfg.apiId > 0 && cfg.apiHash.length > 0) {
    ports.set('telegram', new MtcuteTelegramPort({ apiId: cfg.apiId, apiHash: cfg.apiHash }))
  } else {
    // Not fatal: the project defaults ship empty until the application is
    // registered, and a worker with no channel port still does useful work
    // (purging sessions) and still lets the portal load. One warning at start,
    // never one per tick.
    warn('TELEGRAM_API_ID / TELEGRAM_API_HASH are unset; running without the Telegram port')
  }
  return ports
}
