import type { Channel } from '@/lib/channels/port'

// A source type names where a conversation came from: the `channel` column
// on connections and chats. Live sources are the two ports the worker can
// open. The schema itself still allows a pushed row to reuse either slug
// (tests/sources-live-only.test.ts exercises exactly that with a raw insert,
// to prove such a row stays invisible to the worker and the address book
// either way), but the push door itself (lib/services/import.ts parseBatch)
// refuses one: 'telegram' and 'whatsapp' mean a paired live account, so a
// pushed export of one uses another slug, e.g. 'whatsapp-export'. The rule is
// deliberately narrow so a type is safe in a URL, a filename and a filter
// without escaping.
export const SOURCE_TYPE_RE = /^[a-z][a-z0-9-]{1,31}$/

export function isSourceType(value: unknown): value is string {
  return typeof value === 'string' && SOURCE_TYPE_RE.test(value)
}

export const LIVE_SOURCE_TYPES: readonly Channel[] = ['telegram', 'whatsapp', 'wechat']

export function isLiveChannel(value: string): value is Channel {
  return (LIVE_SOURCE_TYPES as readonly string[]).includes(value)
}
