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

const SOURCE_ROOTS = ['lib', 'app', 'worker', 'scripts']
const sources = () => SOURCE_ROOTS.flatMap(walk)

describe('the single revoke authority', () => {
  it('only lib/services/connections.ts writes status revoked', () => {
    // A route or a service that hand-rolled a revoke could leave revoked_at and
    // status disagreeing, and the partial unique index depends on them moving
    // together. Repo-wide, so the guarantee cannot rot as files are added.
    const writers = sources().filter(f => /status:\s*'revoked'/.test(readFileSync(f, 'utf8')))
    expect(writers).toEqual(['lib/services/connections.ts'])
  })
})

describe('secrets stay in the process', () => {
  it('nothing under app/ reads a ciphertext column', () => {
    // Pages, actions, and routes go through the services, which never return
    // one. A component reaching for the column directly is how a secret ends
    // up in an HTML payload.
    const offenders = walk('app').filter(f => /sessionCiphertext|loginSecretCiphertext|keyCiphertext/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('the channel and service layers log through lib/log, never console', () => {
    // console.log has no level and no redaction discipline; lib/log is where
    // the "counts and kinds, never identifiers" rule is stated and reviewed.
    const offenders = [...walk('lib/channels'), ...walk('lib/services')]
      .filter(f => /\bconsole\.(log|info|warn|error|debug)\(/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})

describe('read paths never expose a tombstone', () => {
  it('no view type in lib/services/queries.ts carries deletedAt', () => {
    const src = readFileSync('lib/services/queries.ts', 'utf8')
    const types = src.slice(src.indexOf('export type ChatSummary'), src.indexOf('const DEFAULT_LIMIT'))
    expect(types).not.toMatch(/deletedAt/)
    // …and all three read paths below the types filter it out: the chat
    // list's message count, the transcript page, and search.
    const readPaths = src.slice(src.indexOf('const liveMessageCount'))
    expect(readPaths.match(/deletedAt/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })
})
