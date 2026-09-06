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

// Behaviour case from spec §11: a push key is not a login credential. Runs
// the real handler (no next/headers mock needed — startSession's cookie
// write is not asserted here, only the response) against the real database.
describe('POST /api/login rejects a push key', () => {
  it('401s with invalid_key: this door only ever verifies capability "read"', async () => {
    const { resetDb } = await import('./helpers/db')
    await resetDb()
    const { mintAccessKey } = await import('@/lib/services/access-keys')
    const { POST } = await import('@/app/api/login/route')
    const push = await mintAccessKey('cron', { read: false, push: true })
    if (!push.ok) throw new Error(push.reason)
    const req = new Request('http://localhost:3000/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: push.rawKey }),
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'invalid_key' })
  })
})
