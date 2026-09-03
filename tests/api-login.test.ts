import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// A structural test, like the rest of the auth guards: the route's shape is
// what matters (it must verify before it starts a session, and it must never
// echo the key back), and exercising a Next route handler's cookie jar in
// vitest would test next/headers, not us. scripts/smoke.sh proves it end to end
// against a real container.
describe('POST /api/login', () => {
  const src = readFileSync('app/api/login/route.ts', 'utf8')

  it('verifies the key before starting a session', () => {
    expect(src).toContain('verifyAccessKey')
    expect(src).toContain('startSession')
    expect(src.indexOf('verifyAccessKey')).toBeLessThan(src.indexOf('startSession'))
  })

  it('never returns the key or the session id in the body', () => {
    expect(src).not.toMatch(/json\([^)]*\bkey\b[^)]*\)/)
    expect(src).toContain('status: 204')
  })

  it('is POST only', () => {
    expect(src).toMatch(/export async function POST/)
    expect(src).not.toMatch(/export async function GET/)
  })
})
