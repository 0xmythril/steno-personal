import type { Channel } from '@/lib/channels/port'

// A source type names where a conversation came from: the `channel` column
// on connections and chats. Live sources are the two ports the worker can
// open; a pushed source may use any slug, including those two (a pushed
// WhatsApp export is still WhatsApp). The rule is deliberately narrow so a
// type is safe in a URL, a filename and a filter without escaping.
export const SOURCE_TYPE_RE = /^[a-z][a-z0-9-]{1,31}$/

export function isSourceType(value: unknown): value is string {
  return typeof value === 'string' && SOURCE_TYPE_RE.test(value)
}

export const LIVE_SOURCE_TYPES: readonly Channel[] = ['telegram', 'whatsapp']

export function isLiveChannel(value: string): value is Channel {
  return (LIVE_SOURCE_TYPES as readonly string[]).includes(value)
}
