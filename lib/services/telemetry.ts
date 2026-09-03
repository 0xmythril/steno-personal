import { randomUUID } from 'node:crypto'
import { count, eq, isNull, and } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { accessKeys, chats, connections, messages, people, settings } from '@/lib/db/schema'
import { env } from '@/lib/env'
import { log, errorShape } from '@/lib/log'
import { APP_VERSION } from '@/lib/version'
import { SETTINGS_ID, getSettings } from '@/lib/services/settings'

// One ping a day at most. The worker asks far more often than that; the
// clock is kept in the database so a restart does not reset it.
export const TELEMETRY_INTERVAL_MS = 24 * 60 * 60 * 1000

// The complete list of what a ping may contain, exported so a test can assert
// the payload against it. Adding a field here is the deliberate act that
// widens what leaves the machine — PRIVACY.md describes this shape, and
// tests/telemetry.test.ts fails if the two drift apart.
export const TELEMETRY_PAYLOAD_KEYS = [
  'instanceId', 'version', 'sentAt', 'channels', 'counts', 'features',
] as const

export type TelemetryPayload = {
  instanceId: string
  version: string
  sentAt: string
  channels: { telegram: boolean; whatsapp: boolean }
  counts: { chats: number; messages: number; people: number; accessKeys: number }
  features: { enrichmentKey: boolean; analyzeImages: boolean; analyzeAudio: boolean }
}

export type TelemetryOutcome = 'sent' | 'disabled' | 'no_endpoint' | 'too_soon' | 'failed'

async function readRow() {
  const [row] = await db.select().from(settings).where(eq(settings.id, SETTINGS_ID)).limit(1)
  return row ?? null
}

// Minted on first use and never re-minted. randomUUID, not a hash of anything
// this instance holds: it must identify the install to itself across pings and
// be traceable to nothing else — not the volume, not the key, not the account.
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

async function countRows(table: typeof chats | typeof messages | typeof people): Promise<number> {
  const [row] = await db.select({ n: count() }).from(table)
  return row?.n ?? 0
}

// Aggregates only. Every number here is a count of rows; no column that holds
// a name, a title, a phone number, a body or a key is read at all.
export async function buildTelemetryPayload(): Promise<TelemetryPayload> {
  // getSettings, not the row: it already reduces the saved OpenRouter key to a
  // boolean, so no ciphertext column is read on this path at all.
  const prefs = await getSettings()
  const [chatCount, messageCount, peopleCount] = await Promise.all([
    countRows(chats), countRows(messages), countRows(people),
  ])
  const [keys] = await db.select({ n: count() }).from(accessKeys).where(isNull(accessKeys.revokedAt))
  const live = await db.select({ channel: connections.channel }).from(connections)
    .where(and(eq(connections.purpose, 'archive'), isNull(connections.revokedAt)))
  const channelsLive = new Set(live.map(c => c.channel))

  return {
    instanceId: await telemetryInstanceId(),
    version: APP_VERSION,
    sentAt: new Date().toISOString(),
    channels: {
      telegram: channelsLive.has('telegram'),
      whatsapp: channelsLive.has('whatsapp'),
    },
    counts: {
      chats: chatCount,
      messages: messageCount,
      people: peopleCount,
      accessKeys: keys?.n ?? 0,
    },
    features: {
      enrichmentKey: prefs.hasOpenrouterKey,
      analyzeImages: prefs.analyzeImages,
      analyzeAudio: prefs.analyzeAudio,
    },
  }
}

// Order matters and is the guarantee: the endpoint and the toggle are both
// checked BEFORE any archive row is read, so an opted-out instance never even
// builds a payload.
export async function sendTelemetryPing(now = new Date()): Promise<TelemetryOutcome> {
  const endpoint = env.STENO_TELEMETRY_URL
  if (!endpoint) return 'no_endpoint'

  const row = await readRow()
  if (row && !row.telemetryEnabled) return 'disabled'

  const last = row?.telemetryLastSentAt
  if (last && now.getTime() - last.getTime() < TELEMETRY_INTERVAL_MS) return 'too_soon'

  const payload = await buildTelemetryPayload()
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      // Status only. A collector's response body is untrusted input and never
      // reaches the log.
      log.warn({ status: res.status }, 'telemetry ping refused')
      return 'failed'
    }
  } catch (e) {
    log.warn({ err: errorShape(e) }, 'telemetry ping failed')
    return 'failed'
  }

  await db.insert(settings).values({ id: SETTINGS_ID, telemetryLastSentAt: now })
    .onConflictDoUpdate({ target: settings.id, set: { telemetryLastSentAt: now } })
  return 'sent'
}
