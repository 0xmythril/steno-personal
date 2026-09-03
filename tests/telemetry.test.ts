import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { db } from '@/lib/db/client'
import { settings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { resetDb } from './helpers/db'
import { seedConnection, seedChat, seedMessage } from './helpers/archive'
import { mintAccessKey } from '@/lib/services/access-keys'
import { getSettings, updateSettings, SETTINGS_ID } from '@/lib/services/settings'
import {
  TELEMETRY_PAYLOAD_KEYS, buildTelemetryPayload, telemetryInstanceId, sendTelemetryPing,
} from '@/lib/services/telemetry'
import { _resetEnvCacheForTests } from '@/lib/env'

function withEndpoint(url: string | undefined) {
  if (url === undefined) delete process.env.STENO_TELEMETRY_URL
  else process.env.STENO_TELEMETRY_URL = url
  _resetEnvCacheForTests()
}

describe('telemetry', () => {
  beforeEach(async () => {
    await resetDb()
    withEndpoint(undefined)
    vi.restoreAllMocks()
  })
  afterEach(() => { withEndpoint(undefined) })

  it('is on by default, and the toggle turns it off', async () => {
    expect(await getSettings()).toMatchObject({ telemetryEnabled: true })
    await updateSettings({ telemetryEnabled: false })
    expect(await getSettings()).toMatchObject({ telemetryEnabled: false })
  })

  it('mints one random instance id and keeps it', async () => {
    const first = await telemetryInstanceId()
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(await telemetryInstanceId()).toBe(first)
  })

  // The whole promise of this feature in one test: the payload is aggregate
  // counts, and nothing a chat carries can reach it.
  it('carries no message text, chat title, name or phone number', async () => {
    const conn = await seedConnection({ channel: 'whatsapp', displayName: 'Ada Lovelace' })
    const chat = await seedChat(conn, { channel: 'whatsapp', title: 'Family +447700900123' })
    await seedMessage(chat, { text: 'meet me at the pier', senderName: 'Mum' })
    await mintAccessKey('laptop')

    const payload = await buildTelemetryPayload()
    const json = JSON.stringify(payload)
    for (const secret of ['Ada Lovelace', 'Family', '447700900123', 'meet me at the pier', 'Mum', 'laptop']) {
      expect(json).not.toContain(secret)
    }
  })

  it('reports only the allowlisted keys, at every level', async () => {
    const payload = await buildTelemetryPayload()
    expect(Object.keys(payload).sort()).toEqual([...TELEMETRY_PAYLOAD_KEYS].sort())
    expect(Object.keys(payload.counts).sort()).toEqual(['accessKeys', 'chats', 'messages', 'people'])
    expect(Object.keys(payload.channels).sort()).toEqual(['telegram', 'whatsapp'])
  })

  it('counts what it says it counts', async () => {
    const conn = await seedConnection({ channel: 'telegram' })
    const chat = await seedChat(conn, { channel: 'telegram' })
    await seedMessage(chat, { text: 'one' })
    await seedMessage(chat, { text: 'two' })
    const payload = await buildTelemetryPayload()
    expect(payload.counts).toMatchObject({ chats: 1, messages: 2 })
    expect(payload.channels).toEqual({ telegram: true, whatsapp: false })
  })

  it('sends nothing when no endpoint is configured, however the toggle is set', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    expect(await sendTelemetryPing()).toBe('no_endpoint')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sends nothing when the user has opted out', async () => {
    withEndpoint('https://telemetry.example/ping')
    await updateSettings({ telemetryEnabled: false })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    expect(await sendTelemetryPing()).toBe('disabled')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('posts the payload to the configured endpoint and records the send', async () => {
    withEndpoint('https://telemetry.example/ping')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 202 }))
    expect(await sendTelemetryPing()).toBe('sent')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://telemetry.example/ping')
    expect(init?.method).toBe('POST')
    const body = JSON.parse(String(init?.body))
    expect(Object.keys(body).sort()).toEqual([...TELEMETRY_PAYLOAD_KEYS].sort())

    const [row] = await db.select().from(settings).where(eq(settings.id, SETTINGS_ID))
    expect(row.telemetryLastSentAt).toBeInstanceOf(Date)
  })

  it('does not send twice within a day, and sends again after one', async () => {
    withEndpoint('https://telemetry.example/ping')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 202 }))
    expect(await sendTelemetryPing()).toBe('sent')
    expect(await sendTelemetryPing()).toBe('too_soon')
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    await db.update(settings).set({ telemetryLastSentAt: twoDaysAgo }).where(eq(settings.id, SETTINGS_ID))
    expect(await sendTelemetryPing()).toBe('sent')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  // A telemetry endpoint that is down, slow or hostile must never be able to
  // affect the archive or stop the worker.
  it('swallows a network failure', async () => {
    withEndpoint('https://telemetry.example/ping')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await sendTelemetryPing()).toBe('failed')
  })

  it('swallows a non-2xx answer and does not record it as sent', async () => {
    withEndpoint('https://telemetry.example/ping')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 500 }))
    expect(await sendTelemetryPing()).toBe('failed')
    const [row] = await db.select().from(settings).where(eq(settings.id, SETTINGS_ID))
    expect(row.telemetryLastSentAt).toBeNull()
  })
})
