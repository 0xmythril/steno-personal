import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveSecretKey, SECRET_KEY_FILE } from '@/lib/services/secret-key'

describe('secret key', () => {
  it('uses the env value when set', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sk-'))
    expect(resolveSecretKey({ envValue: 'x'.repeat(40), dataDir: dir })).toBe('x'.repeat(40))
  })
  it('generates a 0600 file once and reuses it', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sk-'))
    const first = resolveSecretKey({ envValue: undefined, dataDir: dir })
    const second = resolveSecretKey({ envValue: undefined, dataDir: dir })
    expect(first).toBe(second)
    expect(first.length).toBeGreaterThanOrEqual(43) // 32 bytes base64url
    const file = path.join(dir, SECRET_KEY_FILE)
    expect(readFileSync(file, 'utf8').trim()).toBe(first)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})
