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

// Every verifyAccessKey( call's argument text, found by scanning to the
// matching close paren, so an argument that contains its own parentheses
// (header.slice('Bearer '.length).trim()) is captured whole and a call
// with a computed scope is still seen.
function callArgs(src: string): string[] {
  const out: string[] = []
  const needle = 'verifyAccessKey('
  let from = src.indexOf(needle)
  while (from !== -1) {
    const start = from + needle.length
    let depth = 1
    let i = start
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') depth--
      i++
    }
    out.push(src.slice(start, i - 1))
    from = src.indexOf(needle, i)
  }
  return out
}

// Every door names the scope it is a door for, as a literal at the call
// site. A verifyAccessKey(token) with no scope would not compile; this
// catches the other mistake — a read door that asks for 'push' or a route
// that computes the scope from the request.
describe('every verifyAccessKey call names its scope', () => {
  const sources = [...walk('lib'), ...walk('app'), ...walk('worker'), ...walk('scripts')]
    .filter(f => !f.endsWith(path.join('lib', 'services', 'access-keys.ts')))
  const calls = sources.flatMap(f => callArgs(readFileSync(f, 'utf8')).map(args => ({ file: f, args })))

  it('finds the known doors', () => {
    const files = new Set(calls.map(c => c.file.split(path.sep).join('/')))
    for (const door of ['lib/auth.ts', 'app/api/login/route.ts', 'app/login/actions.ts', 'app/mcp/route.ts']) {
      expect(files, door).toContain(door)
    }
  })

  it('passes a scope literal', () => {
    for (const c of calls) expect(c.args, `${c.file}: verifyAccessKey(${c.args})`).toMatch(/,\s*'(read|push)'\s*$/)
  })

  it('only the two push doors ask for push', () => {
    const pushDoors = calls.filter(c => /'push'/.test(c.args)).map(c => c.file.split(path.sep).join('/'))
    expect(pushDoors.every(f => f === 'app/api/import/route.ts' || f === 'app/mcp/push/route.ts')).toBe(true)
  })

  it('the scanner sees nested parentheses and the check rejects a computed scope', () => {
    const src = "await verifyAccessKey(header.slice('Bearer '.length).trim(), 'read')\nverifyAccessKey(token, scope)"
    expect(callArgs(src)).toEqual(["header.slice('Bearer '.length).trim(), 'read'", 'token, scope'])
    expect('token, scope').not.toMatch(/,\s*'(read|push)'\s*$/)
  })
})
