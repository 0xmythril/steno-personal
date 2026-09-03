import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

// A layout protects rendering, not the actions its pages post to. Each
// exported server action must call requireSession() itself (loginAction is
// the one exception: it is how a session comes to exist).
//
// The file list is walked, not enumerated, so an actions.ts added by a later
// milestone is covered the day it lands instead of passing CI unnoticed.
const EXEMPT = new Set(['loginAction'])

function actionFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...actionFiles(full))
    else if (entry.name === 'actions.ts') found.push(full)
  }
  return found.sort()
}

// The body of the function whose `export async function` starts at `from`,
// found by matching braces rather than by slicing to the first column-0 `}`
// (which only held while every inner block stayed indented).
function functionBody(src: string, from: number): string {
  const open = src.indexOf('{', from)
  if (open === -1) return ''
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i)
  }
  return src.slice(open)
}

const files = actionFiles('app')

describe('server actions re-run the guard', () => {
  it('finds every actions file', () => {
    expect(files.length).toBeGreaterThanOrEqual(3) // login, settings, connections
    expect(files).toContain(path.join('app', 'login', 'actions.ts'))
    expect(files).toContain(path.join('app', 'settings', 'actions.ts'))
    expect(files).toContain(path.join('app', 'connections', 'actions.ts'))
  })

  for (const file of files) {
    it(`${file}`, () => {
      const src = readFileSync(file, 'utf8')
      const actions = [...src.matchAll(/export async function (\w+)/g)]
      expect(actions.length).toBeGreaterThan(0)
      const unguarded = actions
        .filter(m => !EXEMPT.has(m[1]) && !functionBody(src, m.index).includes('requireSession()'))
        .map(m => m[1])
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
