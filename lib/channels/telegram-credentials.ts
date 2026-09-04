import { env } from '@/lib/env'

// The one definition of "this deploy can pair Telegram". The worker uses it
// to decide whether to build the Telegram port, and every page that offers a
// Telegram pairing uses it to say up front when there is none — a pending
// row for a channel with no port would wait for a login code forever.
// WhatsApp needs no credentials of its own and is never gated.
export function hasTelegramCredentials(cfg: { apiId: number; apiHash: string }): boolean {
  return cfg.apiId > 0 && cfg.apiHash.length > 0
}

export function telegramConfigured(): boolean {
  return hasTelegramCredentials({ apiId: env.TELEGRAM_API_ID, apiHash: env.TELEGRAM_API_HASH })
}
