import { describe, it, expect } from 'vitest'
import { Writable } from 'node:stream'
import pino from 'pino'
import { errorShape } from '@/lib/log'

// Shaped like drizzle-orm's DrizzleQueryError: the bound parameters are part
// of the message, so anything that logs the raw error leaks them.
function fakeQueryError() {
  const e = new Error('Failed query: insert into "sessions" ("id") values (?)\nparams: ["secret"]')
  e.name = 'DrizzleQueryError'
  ;(e as Error & { code?: string }).code = 'SQLITE_BUSY'
  return e
}

describe('errorShape', () => {
  it('keeps the name, code and query but drops the bound parameters', () => {
    const s = errorShape(fakeQueryError())
    expect(s.name).toBe('DrizzleQueryError')
    expect(s.code).toBe('SQLITE_BUSY')
    expect(s.message).toContain('Failed query')
    expect(s.message).not.toContain('params:')
    expect(s.message).not.toContain('secret')
  })

  it('a logged error carries no bound value', () => {
    const written: string[] = []
    const sink = new Writable({ write(chunk, _enc, cb) { written.push(String(chunk)); cb() } })
    const testLog = pino({ level: 'error' }, sink)
    testLog.error({ err: errorShape(fakeQueryError()) }, 'tick failed')
    const out = written.join('')
    expect(out).toContain('tick failed')
    expect(out).not.toContain('secret')
    expect(out).not.toContain('params:')
  })

  it('survives non-Error values', () => {
    expect(errorShape('boom')).toEqual({ name: 'Error', code: null, message: 'boom' })
    expect(errorShape(null)).toEqual({ name: 'Error', code: null, message: '' })
  })
})
