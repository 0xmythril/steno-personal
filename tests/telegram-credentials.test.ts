import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { _resetEnvCacheForTests } from '@/lib/env'
import { hasTelegramCredentials, telegramConfigured } from '@/lib/channels/telegram-credentials'
import { createConnection } from '@/lib/services/connections'
import { startRecovery } from '@/lib/services/recovery'
import { resetDb } from './helpers/db'
import { makeConnection } from './helpers/fixtures'

// A one-click deploy ships without a Telegram application pair until the
// project registers one. Before this guard, choosing Telegram on a fresh
// instance wrote a pending row that no worker would ever answer, and the
// reader sat on "waiting for a login code" for good. Now the pages say so
// up front and no pending row is written for a channel that cannot pair.

function withTelegramUnset(fn: () => Promise<void>) {
  return async () => {
    const id = process.env.TELEGRAM_API_ID
    const hash = process.env.TELEGRAM_API_HASH
    delete process.env.TELEGRAM_API_ID
    delete process.env.TELEGRAM_API_HASH
    _resetEnvCacheForTests()
    try {
      await fn()
    } finally {
      if (id !== undefined) process.env.TELEGRAM_API_ID = id
      if (hash !== undefined) process.env.TELEGRAM_API_HASH = hash
      _resetEnvCacheForTests()
    }
  }
}

describe('Telegram credentials', () => {
  it('a pair is present only when both halves are', () => {
    expect(hasTelegramCredentials({ apiId: 0, apiHash: '' })).toBe(false)
    expect(hasTelegramCredentials({ apiId: 12345, apiHash: '' })).toBe(false)
    expect(hasTelegramCredentials({ apiId: 0, apiHash: 'abc' })).toBe(false)
    expect(hasTelegramCredentials({ apiId: 12345, apiHash: 'abc' })).toBe(true)
  })

  it('telegramConfigured() reads the environment', async () => {
    expect(telegramConfigured()).toBe(true)
    await withTelegramUnset(async () => { expect(telegramConfigured()).toBe(false) })()
  })

  it('the worker decides on the same predicate', () => {
    // buildPorts must not grow a second, drifting definition of "configured".
    const ports = readFileSync('lib/channels/ports.ts', 'utf8')
    expect(ports).toContain('hasTelegramCredentials(')
    expect(ports).not.toMatch(/apiId > 0/)
  })
})

describe('pairing without a Telegram pair', () => {
  beforeEach(resetDb)
  afterEach(_resetEnvCacheForTests)

  it('createConnection refuses Telegram and still allows WhatsApp', withTelegramUnset(async () => {
    expect(await createConnection('telegram')).toEqual({ ok: false, reason: 'telegram_unconfigured' })
    expect((await createConnection('whatsapp')).ok).toBe(true)
  }))

  it('createConnection allows Telegram once a pair is set', async () => {
    expect((await createConnection('telegram')).ok).toBe(true)
  })

  it('startRecovery refuses Telegram even for a known account', withTelegramUnset(async () => {
    await makeConnection({ channel: 'telegram', status: 'revoked', externalAccountId: 'tg:1' })
    expect(await startRecovery('telegram')).toEqual({ ok: false, reason: 'telegram_unconfigured' })
  }))
})

describe('the pages say Telegram is unavailable instead of waiting forever', () => {
  // Every page that can start a Telegram pairing checks the same predicate
  // and names the two variables the host has to set, so a deployer is told
  // what is missing on the page rather than in a worker log they never see.
  for (const page of ['app/setup/page.tsx', 'app/connections/page.tsx', 'app/login/recover/page.tsx']) {
    it(`${page} gates the Telegram card on telegramConfigured()`, () => {
      const src = readFileSync(page, 'utf8')
      expect(src).toContain('telegramConfigured()')
      expect(src).toContain('<TelegramUnavailable')
    })
  }
  it('the unavailable card names the variables and where the pair comes from', () => {
    const src = readFileSync('app/connections/telegram-unavailable.tsx', 'utf8')
    expect(src).toContain('TELEGRAM_API_ID')
    expect(src).toContain('TELEGRAM_API_HASH')
    expect(src).toContain('my.telegram.org')
    expect(src).not.toContain('ConnectButton')
  })
})
