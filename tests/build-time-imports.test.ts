import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// `next build` evaluates every route, page, layout and server-action module
// in parallel workers to collect page data. A fresh clone has no ./data yet,
// so if any of those modules (or anything they import) touches the database
// at import time, several workers create data/steno.db and switch it to WAL
// at once and the build dies with SQLITE_BUSY "database is locked". The
// promise this guards: importing the app opens nothing; only the first query
// does. Behavioural, not a grep — a module-level `db.select(...)` three
// imports deep is exactly the case a grep misses.

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = path.join(dir, entry)
    if (entry === 'node_modules' || entry.startsWith('.')) return []
    if (statSync(full).isDirectory()) return walk(full)
    return /\.tsx?$/.test(entry) ? [full] : []
  })
}

const NEXT_ENTRY = /(^|\/)(route\.ts|page\.tsx|layout\.tsx|actions\.ts)$/
const entryModules = () => [
  ...walk('lib'),
  ...walk('app').filter(f => NEXT_ENTRY.test(f)),
]

describe('nothing opens the database at import time', () => {
  it('importing every lib module and every Next entry module creates no data/steno.db', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'steno-personal-build-'))
    // tests/setup.ts already ran migrations against another temp dir, so the
    // cached db handle and parsed env must go before the imports re-evaluate.
    process.env.DATA_DIR = dir
    vi.resetModules()

    const files = entryModules()
    expect(files.length).toBeGreaterThan(10)
    for (const f of files) await import(path.resolve(f))

    expect(readdirSync(dir)).toEqual([])
    expect(existsSync(path.join(dir, 'steno.db'))).toBe(false)
  })
})
