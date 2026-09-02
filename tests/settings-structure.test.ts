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
    expect(sets.length).toBe(2)
    for (const s of sets) {
      expect(s).toMatch(/httpOnly:\s*true/)
      expect(s).toMatch(/maxAge:\s*(2|5) \* 60/)
    }
  })
})
