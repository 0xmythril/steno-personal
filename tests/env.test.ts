import { describe, it, expect } from 'vitest'
import { envSchema, env, _resetEnvCacheForTests } from '@/lib/env'

describe('env schema', () => {
  it('applies defaults', () => {
    const e = envSchema.parse({ DATA_DIR: '/tmp/x' })
    expect(e.PORT).toBe(3000)
    expect(e.LOG_LEVEL).toBe('info')
    expect(e.SECRET_KEY).toBeUndefined()
  })
  it('treats empty strings as unset', () => {
    const e = envSchema.parse({ DATA_DIR: '/tmp/x', SECRET_KEY: '', PORT: '', LOG_LEVEL: '' })
    expect(e.SECRET_KEY).toBeUndefined()
    expect(e.PORT).toBe(3000)
    expect(e.LOG_LEVEL).toBe('info')
  })
  it('accepts silent as a log level, and nothing outside pino\'s set', () => {
    // The test run sets LOG_LEVEL=silent; if the enum rejected it every suite
    // would fail at env parse time rather than here.
    expect(envSchema.parse({ DATA_DIR: '/tmp/x', LOG_LEVEL: 'silent' }).LOG_LEVEL).toBe('silent')
    expect(() => envSchema.parse({ DATA_DIR: '/tmp/x', LOG_LEVEL: 'quiet' })).toThrow()
  })

  it('rejects a short SECRET_KEY', () => {
    expect(() => envSchema.parse({ DATA_DIR: '/tmp/x', SECRET_KEY: 'short' })).toThrow()
  })
  it('defaults DATA_DIR to ./data', () => {
    expect(envSchema.parse({}).DATA_DIR).toBe('./data')
  })

  it('falls back to the project Telegram defaults, and treats blanks as unset', () => {
    const bare = envSchema.parse({ DATA_DIR: '/tmp/x' })
    expect(bare.TELEGRAM_API_ID).toBe(0)
    expect(bare.TELEGRAM_API_HASH).toBe('')
    const blanked = envSchema.parse({ DATA_DIR: '/tmp/x', TELEGRAM_API_ID: '', TELEGRAM_API_HASH: '' })
    expect(blanked.TELEGRAM_API_ID).toBe(0)
    expect(blanked.TELEGRAM_API_HASH).toBe('')
  })

  it('carries the host operations as optional strings, blank meaning unset', () => {
    const bare = envSchema.parse({ DATA_DIR: '/tmp/x', STENO_RESET: '', STENO_MINT_KEY: '' })
    expect(bare.STENO_RESET).toBeUndefined()
    expect(bare.STENO_MINT_KEY).toBeUndefined()
    expect(envSchema.parse({ DATA_DIR: '/tmp/x' }).STENO_RESET).toBeUndefined()
    const set = envSchema.parse({ DATA_DIR: '/tmp/x', STENO_RESET: 'now', STENO_MINT_KEY: 'laptop' })
    expect(set.STENO_RESET).toBe('now')
    expect(set.STENO_MINT_KEY).toBe('laptop')
  })

  it('accepts an owner-supplied Telegram pair', () => {
    const e = envSchema.parse({ DATA_DIR: '/tmp/x', TELEGRAM_API_ID: '12345', TELEGRAM_API_HASH: 'abc' })
    expect(e.TELEGRAM_API_ID).toBe(12345)
    expect(e.TELEGRAM_API_HASH).toBe('abc')
  })
})

describe('env proxy', () => {
  it('reads process.env lazily and re-reads after a cache reset', () => {
    const prev = process.env.LOG_LEVEL
    try {
      process.env.LOG_LEVEL = 'debug'
      _resetEnvCacheForTests()
      expect(env.LOG_LEVEL).toBe('debug')
      process.env.LOG_LEVEL = 'warn'
      expect(env.LOG_LEVEL).toBe('debug') // cached until reset
      _resetEnvCacheForTests()
      expect(env.LOG_LEVEL).toBe('warn')
      expect('DATA_DIR' in env).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = prev
      _resetEnvCacheForTests()
    }
  })
})
