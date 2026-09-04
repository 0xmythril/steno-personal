import path from 'node:path'
import { env } from '@/lib/env'
import { hasTelegramCredentials } from './telegram-credentials'
import { log } from '@/lib/log'
import { MtcuteTelegramPort } from '@/lib/channels/telegram'
import { BaileysWhatsAppPort } from '@/lib/channels/whatsapp'
import type { Channel, ChannelPort } from '@/lib/channels/port'

// Pure, so the "no credentials" path is testable without starting a loop.
// M2 adds the WhatsApp port here.
export function buildPorts(
  cfg: { apiId: number; apiHash: string },
  warn: (msg: string) => void = m => log.warn(m),
): Map<Channel, ChannelPort> {
  const ports = new Map<Channel, ChannelPort>()
  if (hasTelegramCredentials(cfg)) {
    ports.set('telegram', new MtcuteTelegramPort({ apiId: cfg.apiId, apiHash: cfg.apiHash }))
  } else {
    // Not fatal: the project ships its own pair, so this is an explicit
    // TELEGRAM_API_ID=0 (or a fork without the pair), and a worker with no
    // channel port still does useful work (purging sessions) and still lets
    // the portal load. One warning at start, never one per tick.
    warn('TELEGRAM_API_ID=0: running without the Telegram port')
  }
  // WhatsApp needs no credentials of its own: the QR pairs the owner's account
  // and Baileys keeps its signal keys on the volume at
  // DATA_DIR/whatsapp/wa-<connectionId> (spec decision 9). The port is always
  // registered, so it sits outside the credential guard above.
  ports.set('whatsapp', new BaileysWhatsAppPort({ authRoot: path.join(env.DATA_DIR, 'whatsapp') }))
  return ports
}
