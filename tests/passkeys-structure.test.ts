import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = path.join(dir, entry)
    if (entry === 'node_modules' || entry.startsWith('.')) return []
    if (statSync(full).isDirectory()) return walk(full)
    return /\.tsx?$/.test(entry) ? [full] : []
  })
}

// The promises around passkeys: one importer of the library, enrolment only
// from a cookie session, a login route shaped like /api/login, a challenge
// that never rides a URL, and a login page that still asks for a key.
describe('passkeys', () => {
  it('only lib/services/webauthn.ts imports the WebAuthn server library', () => {
    const importers = ['lib', 'app', 'worker', 'scripts'].flatMap(walk)
      .filter(f => /@simplewebauthn\/server/.test(readFileSync(f, 'utf8')))
    expect(importers).toEqual(['lib/services/webauthn.ts'])
  })

  it('registration routes need the cookie session; a bearer key must never enrol a passkey', () => {
    for (const f of ['app/api/passkeys/register/options/route.ts', 'app/api/passkeys/register/route.ts']) {
      expect(readFileSync(f, 'utf8')).toContain('requireCookieAuth(')
    }
  })

  it('the login route verifies before it starts a session, answers 204, and is POST only', () => {
    const src = readFileSync('app/api/passkeys/login/route.ts', 'utf8')
    expect(src.indexOf('verifyAuthentication(')).toBeLessThan(src.indexOf('startSession('))
    expect(src).toContain('status: 204')
    expect(src).not.toMatch(/export async function GET/)
  })

  it('the challenge cookie is httpOnly, path-scoped to the routes, and minutes long', () => {
    const auth = readFileSync('lib/auth.ts', 'utf8')
    const set = auth.slice(auth.indexOf('export async function setChallengeCookie'), auth.indexOf('export async function takeChallengeCookie'))
    expect(set).toMatch(/httpOnly:\s*true/)
    expect(set).toMatch(/path:\s*'\/api\/passkeys'/)
    expect(set).toMatch(/maxAge:\s*WEBAUTHN_COOKIE_MAX_AGE_S/)
    expect(auth).toMatch(/WEBAUTHN_COOKIE_MAX_AGE_S = 5 \* 60/)
  })

  it('the login page offers the passkey before the key form, and still asks for a key', () => {
    const page = readFileSync('app/login/page.tsx', 'utf8')
    expect(page).toContain('<PasskeyLogin')
    expect(page.indexOf('<PasskeyLogin')).toBeLessThan(page.indexOf('name="key"'))
  })
})
