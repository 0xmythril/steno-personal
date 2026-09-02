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
  it('rejects a short SECRET_KEY', () => {
    expect(() => envSchema.parse({ DATA_DIR: '/tmp/x', SECRET_KEY: 'short' })).toThrow()
  })
  it('defaults DATA_DIR to ./data', () => {
    expect(envSchema.parse({}).DATA_DIR).toBe('./data')
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
