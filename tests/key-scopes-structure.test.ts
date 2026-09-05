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

// Every door names the scope it is a door for, as a literal at the call
// site. A verifyAccessKey(token) with no scope would not compile; this
// catches the other mistake — a read door that asks for 'push' or a route
// that computes the scope from the request.
describe('every verifyAccessKey call names its scope', () => {
  const sources = [...walk('lib'), ...walk('app'), ...walk('worker'), ...walk('scripts')]
    .filter(f => !f.endsWith(path.join('lib', 'services', 'access-keys.ts')))
  const calls = sources.flatMap(f => {
    const src = readFileSync(f, 'utf8')
    return [...src.matchAll(/verifyAccessKey\(([\s\S]*?,\s*'(?:read|push)'\s*)\)/g)].map(m => ({ file: f, args: m[1] }))
  })

  it('finds the known doors', () => {
    const files = new Set(calls.map(c => c.file.split(path.sep).join('/')))
    for (const door of ['lib/auth.ts', 'app/api/login/route.ts', 'app/login/actions.ts', 'app/mcp/route.ts']) {
      expect(files, door).toContain(door)
    }
  })

  it('passes a scope literal', () => {
    for (const c of calls) expect(c.args, `${c.file}: verifyAccessKey(${c.args})`).toMatch(/,\s*'(read|push)'\s*$/)
  })

  it('only the import door asks for push', () => {
    const pushDoors = calls.filter(c => /'push'/.test(c.args)).map(c => c.file.split(path.sep).join('/'))
    expect(pushDoors.every(f => f === 'app/api/import/route.ts')).toBe(true)
  })
})
