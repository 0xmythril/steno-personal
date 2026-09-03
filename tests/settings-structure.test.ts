import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

describe('settings keys page', () => {
  it('never puts a raw key in a URL', () => {
    const actions = readFileSync('app/settings/actions.ts', 'utf8')
    // Raw keys travel only through the httpOnly flash cookies.
    expect(actions).not.toMatch(/redirect\([^)]*rawKey/)
    expect(actions).toMatch(/MINTED_KEY_COOKIE/)
    expect(actions).toMatch(/REVEALED_KEY_COOKIE/)
  })
  it('flash cookies are httpOnly and short-lived', () => {
    const actions = readFileSync('app/settings/actions.ts', 'utf8')
    const sets = actions.match(/jar\.set\([\s\S]*?\)\n/g) ?? []
    expect(sets.length).toBe(3)
    for (const s of sets) {
      expect(s).toMatch(/httpOnly:\s*true/)
      expect(s).toMatch(/maxAge:\s*(2|5) \* 60/)
    }
  })
  it('revoking every key clears the flashes before the session ends', () => {
    const actions = readFileSync('app/settings/actions.ts', 'utf8')
    const start = actions.indexOf('export async function revokeAllKeysAction')
    expect(start).toBeGreaterThan(-1)
    const next = actions.indexOf('export async function ', start + 1)
    const body = next === -1 ? actions.slice(start) : actions.slice(start, next)
    expect(body).toMatch(/MINTED_KEY_COOKIE/)
    expect(body).toMatch(/REVEALED_KEY_COOKIE/)
    expect(body).toMatch(/INSTRUCTIONS_KEY_COOKIE/)
    // A raw key must not outlive the logout that revoked it.
    expect(body.indexOf('jar.delete')).toBeLessThan(body.indexOf('endSession()'))
  })
  it('reads the request scheme from lib/auth, not a second copy', () => {
    const actions = readFileSync('app/settings/actions.ts', 'utf8')
    expect(actions).not.toMatch(/x-forwarded-proto/)
    expect(actions).toMatch(/isHttps\(\)/)
  })
})
