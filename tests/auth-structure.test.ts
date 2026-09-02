import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'

// A layout protects rendering, not the actions its pages post to. Each
// exported server action must call requireSession() itself (loginAction is
// the one exception: it is how a session comes to exist).
const ACTION_FILES = ['app/login/actions.ts', 'app/settings/actions.ts']
const EXEMPT = new Set(['loginAction'])

describe('server actions re-run the guard', () => {
  for (const file of ACTION_FILES) {
    it(`${file}`, () => {
      if (!existsSync(file)) return // settings arrives in Task 9
      const src = readFileSync(file, 'utf8')
      const blocks = src.split(/export async function /).slice(1)
      expect(blocks.length).toBeGreaterThan(0)
      const unguarded = blocks
        .map(b => ({ name: b.slice(0, b.indexOf('(')), body: b.slice(0, b.indexOf('\n}')) }))
        .filter(b => !EXEMPT.has(b.name) && !b.body.includes('requireSession()'))
        .map(b => b.name)
      expect(unguarded).toEqual([])
    })
  }
})

describe('no password anywhere', () => {
  it('the login page asks for a key, not a password', () => {
    const src = readFileSync('app/login/page.tsx', 'utf8')
    expect(src).not.toMatch(/type=["']password["']/)
    expect(src).toMatch(/name=["']key["']/)
  })
})
