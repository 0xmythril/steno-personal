import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BOOT_OPS_FILE, readMarker, resetDataDir, mintRequestedKey } from '@/lib/services/boot-ops'
import type { MintResult } from '@/lib/services/access-keys'

function scratch(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'steno-boot-ops-'))
  writeFileSync(path.join(dir, 'steno.db'), 'db')
  writeFileSync(path.join(dir, 'steno.db-wal'), 'wal')
  writeFileSync(path.join(dir, 'secret.key'), 'k')
  mkdirSync(path.join(dir, 'media'), { recursive: true })
  writeFileSync(path.join(dir, 'media', 'a.jpg'), 'x')
  mkdirSync(path.join(dir, 'whatsapp', 'wa-1'), { recursive: true })
  writeFileSync(path.join(dir, 'whatsapp', 'wa-1', 'creds.json'), '{}')
  return dir
}

const fakeMint = () => {
  const calls: string[] = []
  const mint = async (label: string): Promise<MintResult> => {
    calls.push(label)
    return { ok: true, id: `id-${calls.length}`, rawKey: `sp_fake${calls.length}` }
  }
  return { mint, calls }
}

describe('STENO_RESET', () => {
  it('empties the data directory once per value and records the value', () => {
    const dir = scratch()
    expect(resetDataDir(dir, 'go')).toBe(true)
    expect(readdirSync(dir)).toEqual([BOOT_OPS_FILE])
    expect(readMarker(dir)).toEqual({ reset: 'go', mintKey: null })
    expect(statSync(path.join(dir, BOOT_OPS_FILE)).mode & 0o777).toBe(0o600)

    // the variable is still set on the next boot: nothing happens
    writeFileSync(path.join(dir, 'steno.db'), 'new data')
    expect(resetDataDir(dir, 'go')).toBe(false)
    expect(existsSync(path.join(dir, 'steno.db'))).toBe(true)

    // a new value wipes again
    expect(resetDataDir(dir, 'again')).toBe(true)
    expect(existsSync(path.join(dir, 'steno.db'))).toBe(false)
  })

  it('removes a symlink inside the directory without following it', () => {
    const dir = scratch()
    const outside = mkdtempSync(path.join(os.tmpdir(), 'steno-outside-'))
    writeFileSync(path.join(outside, 'keep.txt'), 'keep')
    symlinkSync(outside, path.join(dir, 'link'))
    resetDataDir(dir, 'x')
    expect(existsSync(path.join(outside, 'keep.txt'))).toBe(true)
    expect(existsSync(path.join(dir, 'link'))).toBe(false)
  })

  it('creates the directory when it does not exist yet', () => {
    const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'steno-empty-')), 'data')
    expect(resetDataDir(dir, 'x')).toBe(true)
    expect(readMarker(dir).reset).toBe('x')
  })

  it('clears the mint marker so the fresh instance can reuse the label', async () => {
    const dir = scratch()
    const { mint } = fakeMint()
    await mintRequestedKey(dir, 'laptop', mint, () => {})
    expect(readMarker(dir).mintKey).toBe('laptop')
    resetDataDir(dir, 'x')
    expect(readMarker(dir)).toEqual({ reset: 'x', mintKey: null })
  })
})

describe('STENO_MINT_KEY', () => {
  it('mints once per value, prints the key once, and keeps the reset marker', async () => {
    const dir = scratch()
    resetDataDir(dir, 'r')
    const { mint, calls } = fakeMint()
    const lines: string[] = []
    expect(await mintRequestedKey(dir, 'laptop', mint, l => lines.push(l))).toBe(true)
    expect(calls).toEqual(['laptop'])
    const out = lines.join('\n')
    expect(out).toContain('sp_fake1')
    expect(out).toContain('access key "laptop"')
    expect(out).toContain('STENO_MINT_KEY')
    expect(readMarker(dir)).toEqual({ reset: 'r', mintKey: 'laptop' })

    lines.length = 0
    expect(await mintRequestedKey(dir, 'laptop', mint, l => lines.push(l))).toBe(false)
    expect(calls).toHaveLength(1)
    expect(lines).toEqual([])

    expect(await mintRequestedKey(dir, 'phone', mint, () => {})).toBe(true)
    expect(calls).toEqual(['laptop', 'phone'])
  })

  it('trims and bounds the label, never passing an empty one', async () => {
    const dir = scratch()
    const { mint, calls } = fakeMint()
    await mintRequestedKey(dir, '  spaced  ', mint, () => {})
    await mintRequestedKey(dir, 'x'.repeat(150), mint, () => {})
    await mintRequestedKey(dir, '   ', mint, () => {})
    expect(calls[0]).toBe('spaced')
    expect(calls[1]).toHaveLength(100)
    expect(calls[2]).toBe('host')
  })

  it('surfaces a mint failure instead of recording the value', async () => {
    const dir = scratch()
    const mint = async (): Promise<MintResult> => ({ ok: false, reason: 'label_empty' })
    await expect(mintRequestedKey(dir, 'a', mint, () => {})).rejects.toThrow(/label_empty/)
    expect(readMarker(dir).mintKey).toBeNull()
  })

  it('a corrupt marker reads as empty', () => {
    const dir = scratch()
    writeFileSync(path.join(dir, BOOT_OPS_FILE), 'not json')
    expect(readMarker(dir)).toEqual({ reset: null, mintKey: null })
    writeFileSync(path.join(dir, BOOT_OPS_FILE), JSON.stringify({ reset: 5 }))
    expect(readMarker(dir)).toEqual({ reset: null, mintKey: null })
    expect(readFileSync(path.join(dir, BOOT_OPS_FILE), 'utf8')).toContain('5')
  })
})
