import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { settings } from '@/lib/db/schema'
import { env } from '@/lib/env'
import { log, errorShape } from '@/lib/log'
import { APP_VERSION } from '@/lib/version'
import { SETTINGS_ID } from '@/lib/services/settings'

// Anonymous usage events, posted to PostHog at the moment a feature is used.
//
// This is the one place in the repo that reports anything about how the
// software is used, and the whole of what it can report is written down here
// as a type: an event name from EVENTS, and the enum-valued properties that
// event allows. TypeScript refuses an unknown event or an extra property at
// every call site, and tests/launch-invariants.test.ts greps the call sites
// as well so a value smuggled in under an allowed key is caught too.
//
// Nothing here reads a chat, a message, a name, a number or a key. The only
// thing tying events together is an id minted with randomUUID() on first use
// and derived from nothing else.

// PostHog's ingest is a plain HTTP POST, so no vendor package is imported —
// the sweep in tests/launch-invariants.test.ts still bans the SDKs by name.
// The project token lives in lib/telemetry-defaults.ts.

export const MCP_TOOLS = [
  'list_chats', 'get_messages', 'search_messages', 'recent_messages', 'get_media', 'list_people', 'whoami',
] as const
export type McpTool = (typeof MCP_TOOLS)[number]

// The tracking plan. Every property is an enum or a boolean: nothing here can
// hold a query, a title, a name, a number, a chat id or a key, and a call site
// that tried to pass one would not compile.
export type Events = {
  search: { surface: 'portal' | 'mcp' }
  mcp_tool_call: { tool: McpTool }
  transcript_viewed: Record<never, never>
  person_linked: { source: 'manual' | 'phone_match' | 'name_match' | 'auto' }
  channel_connected: { channel: 'telegram' | 'whatsapp' }
  access_key_minted: Record<never, never>
  enrichment_toggled: { images: boolean; audio: boolean }
}
export type EventName = keyof Events
export const EVENTS = [
  'search', 'mcp_tool_call', 'transcript_viewed', 'person_linked',
  'channel_connected', 'access_key_minted', 'enrichment_toggled',
] as const satisfies readonly EventName[]

// Property keys any event may carry, for the structural test. `version` is
// added by the sender, never by a call site.
export const ALLOWED_PROPERTY_KEYS = ['surface', 'tool', 'source', 'channel', 'images', 'audio', 'version'] as const

export type TelemetryOutcome = 'sent' | 'disabled' | 'no_key' | 'failed'

async function readRow() {
  const [row] = await db.select().from(settings).where(eq(settings.id, SETTINGS_ID)).limit(1)
  return row ?? null
}

// Minted on first use and never re-minted. randomUUID, not a hash of anything
// this instance holds: it must identify the install to itself across events
// and be traceable to nothing else — not the volume, not the key, not the
// account.
export async function telemetryInstanceId(): Promise<string> {
  const existing = (await readRow())?.telemetryInstanceId
  if (existing) return existing
  const id = randomUUID()
  await db.insert(settings).values({ id: SETTINGS_ID, telemetryInstanceId: id })
    .onConflictDoUpdate({ target: settings.id, set: { telemetryInstanceId: id } })
  // Concurrent callers: the row is the single source of truth, so read back
  // rather than trusting the id this call generated.
  return (await readRow())?.telemetryInstanceId ?? id
}

// DO_NOT_TRACK is the convention CLI tools share (GitHub CLI honours it, for
// one). Any value but an explicit off means off — a person who set it at all
// meant it.
const doNotTrack = (): boolean => {
  const v = process.env.DO_NOT_TRACK?.trim().toLowerCase()
  return !!v && v !== '0' && v !== 'false'
}

// The three gates, in order and BEFORE any row is touched: the host's
// DO_NOT_TRACK, the key, then the owner's Settings toggle.
export async function sendEvent<N extends EventName>(name: N, props: Events[N]): Promise<TelemetryOutcome> {
  if (doNotTrack()) return 'disabled'
  const key = env.STENO_POSTHOG_KEY
  if (!key) return 'no_key'
  const row = await readRow()
  if (row && !row.telemetryEnabled) return 'disabled'

  const body = {
    api_key: key,
    event: name,
    distinct_id: await telemetryInstanceId(),
    properties: { ...props, version: APP_VERSION },
  }
  try {
    const res = await fetch(`${env.STENO_POSTHOG_HOST.replace(/\/$/, '')}/i/v0/e/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      // Status only. The collector's response body is untrusted input and
      // never reaches the log.
      log.warn({ status: res.status, event: name }, 'telemetry event refused')
      return 'failed'
    }
    return 'sent'
  } catch (e) {
    log.warn({ err: errorShape(e), event: name }, 'telemetry event failed')
    return 'failed'
  }
}

// Fire-and-forget for request handlers and server actions: never awaited,
// never throws, so a slow or absent collector cannot slow a page or fail an
// action. sendEvent already swallows every failure; the catch here is belt
// and braces against a rejection before it even starts.
export function track<N extends EventName>(name: N, props: Events[N]): void {
  void sendEvent(name, props).catch(() => {})
}
