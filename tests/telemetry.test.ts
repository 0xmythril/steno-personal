import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// These tests reason about "no key" and "a key"; the build's real default
// would turn every "no key" case into "a key". Hoisted, so lib/env.ts sees it.
vi.mock('@/lib/telemetry-defaults', () => ({ POSTHOG_DEFAULT_KEY: '', POSTHOG_DEFAULT_HOST: 'https://us.i.posthog.com' }))
import { resetDb } from './helpers/db'
import { seedConnection, seedChat, seedMessage } from './helpers/archive'
import { mintAccessKey } from '@/lib/services/access-keys'
import { getSettings, updateSettings } from '@/lib/services/settings'
import { EVENTS, ALLOWED_PROPERTY_KEYS, sendEvent, telemetryInstanceId, track } from '@/lib/services/telemetry'
import { APP_VERSION } from '@/lib/version'
import { _resetEnvCacheForTests } from '@/lib/env'

function withKey(key: string | undefined) {
  if (key === undefined) delete process.env.STENO_POSTHOG_KEY
  else process.env.STENO_POSTHOG_KEY = key
  _resetEnvCacheForTests()
}

// The default key is '' until a build is pointed at a project, so a test
// that wants sending ON must set one; the tests that want it off rely on the
// same default the shipped build has today.
describe('telemetry', () => {
  beforeEach(async () => {
    await resetDb()
    withKey(undefined)
    delete process.env.DO_NOT_TRACK
    vi.restoreAllMocks()
  })
  afterEach(() => { withKey(undefined); delete process.env.DO_NOT_TRACK })

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

  it('posts a PostHog capture event: token, name, instance id, properties plus version', async () => {
    withKey('phc_test')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }))
    expect(await sendEvent('search', { surface: 'portal' })).toBe('sent')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://us.i.posthog.com/i/v0/e/')
    expect(init?.method).toBe('POST')
    const body = JSON.parse(String(init?.body))
    expect(body).toEqual({
      api_key: 'phc_test',
      event: 'search',
      distinct_id: await telemetryInstanceId(),
      properties: { surface: 'portal', version: APP_VERSION },
    })
  })

  it('honours STENO_POSTHOG_HOST', async () => {
    withKey('phc_test')
    process.env.STENO_POSTHOG_HOST = 'https://eu.i.posthog.com/'
    _resetEnvCacheForTests()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }))
    await sendEvent('transcript_viewed', {})
    expect(fetchSpy.mock.calls[0][0]).toBe('https://eu.i.posthog.com/i/v0/e/')
    delete process.env.STENO_POSTHOG_HOST
  })

  // The whole promise in one test: an archive full of things that must never
  // leave, and an event body that contains none of them.
  it('carries nothing from the archive', async () => {
    withKey('phc_test')
    const conn = await seedConnection({ channel: 'whatsapp', displayName: 'Ada Lovelace' })
    const chat = await seedChat(conn, { channel: 'whatsapp', title: 'Family +447700900123' })
    await seedMessage(chat, { text: 'meet me at the pier', senderName: 'Mum' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }))

    await mintAccessKey('laptop')           // fires access_key_minted itself
    await sendEvent('search', { surface: 'mcp' })
    await sendEvent('channel_connected', { channel: 'whatsapp' })
    // Let the fire-and-forget from mintAccessKey land.
    await new Promise(r => setTimeout(r, 20))

    const bodies = fetchSpy.mock.calls.map(c => String(c[1]?.body)).join('\n')
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(3)
    for (const secret of ['Ada Lovelace', 'Family', '447700900123', 'meet me at the pier', 'Mum', 'laptop', 'sp_', chat, conn]) {
      expect(bodies).not.toContain(secret)
    }
    for (const c of fetchSpy.mock.calls) {
      const body = JSON.parse(String(c[1]?.body))
      expect(EVENTS).toContain(body.event)
      for (const k of Object.keys(body.properties)) expect(ALLOWED_PROPERTY_KEYS).toContain(k)
    }
  })

  it('sends nothing without a key, however the toggle is set', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    expect(await sendEvent('search', { surface: 'portal' })).toBe('no_key')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sends nothing when the owner has opted out', async () => {
    withKey('phc_test')
    await updateSettings({ telemetryEnabled: false })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    expect(await sendEvent('search', { surface: 'portal' })).toBe('disabled')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('honours DO_NOT_TRACK on the host, before anything else', async () => {
    withKey('phc_test')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    for (const v of ['1', 'true', 'yes']) {
      process.env.DO_NOT_TRACK = v
      expect(await sendEvent('search', { surface: 'portal' })).toBe('disabled')
    }
    for (const v of ['0', 'false', '']) {
      process.env.DO_NOT_TRACK = v
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 200 }))
      expect(await sendEvent('search', { surface: 'portal' })).toBe('sent')
    }
  })

  // A collector that is down, slow or hostile must never be able to affect
  // the archive or fail a page.
  it('swallows a network failure', async () => {
    withKey('phc_test')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await sendEvent('search', { surface: 'portal' })).toBe('failed')
  })

  it('swallows a non-2xx answer', async () => {
    withKey('phc_test')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 500 }))
    expect(await sendEvent('search', { surface: 'portal' })).toBe('failed')
  })

  it('track() returns synchronously and never throws', async () => {
    withKey('phc_test')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'))
    expect(() => track('transcript_viewed', {})).not.toThrow()
    await new Promise(r => setTimeout(r, 20))
  })
})
