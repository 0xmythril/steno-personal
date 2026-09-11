import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, utimes, readdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { listBackups, selectBackupsToPrune, pruneBackups } from '../updater/backups.mjs'
import { writeJson } from '../updater/engine.mjs'

// Real directories, real deletes. Backups are dated by their manifest's
// mtime, set explicitly here so the order does not depend on how fast the
// fixture was written.
async function fixture(ids: string[], journal?: Record<string, unknown>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'steno-backups-'))
  const base = Date.now() - ids.length * 60_000
  for (const [index, id] of ids.entries()) {
    const dir = path.join(directory, 'backups', id)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'manifest.json'), '{}')
    await writeFile(path.join(dir, 'archive.tar.gz'), 'synthetic')
    const at = new Date(base + index * 60_000) // later index = newer
    await utimes(path.join(dir, 'manifest.json'), at, at)
  }
  if (journal) await writeJson(path.join(directory, 'journal.json'), journal)
  const remaining = async () => (await readdir(path.join(directory, 'backups'))).sort()
  return { directory, remaining }
}

describe('listing backups', () => {
  it('orders newest first and ignores directories that are not backups', async () => {
    const { directory } = await fixture(['first', 'second', 'third'])
    await mkdir(path.join(directory, 'backups', 'stray'))
    await writeFile(path.join(directory, 'backups', 'note.txt'), 'not a backup')
    expect((await listBackups(directory)).map(b => b.id)).toEqual(['third', 'second', 'first'])
  })

  it('is empty when upgrades have never made a backup', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'steno-backups-'))
    expect(await listBackups(directory)).toEqual([])
  })
})

describe('choosing what to prune', () => {
  const backups = [{ id: 'c', path: 'c', at: 3 }, { id: 'a', path: 'a', at: 1 }, { id: 'b', path: 'b', at: 2 }]

  it('keeps the newest N whatever order it was given', () => {
    expect(selectBackupsToPrune(backups, { keep: 1 }).map(b => b.id)).toEqual(['b', 'a'])
    expect(selectBackupsToPrune(backups, { keep: 3 })).toEqual([])
  })

  it('keeps a protected backup even outside the window', () => {
    expect(selectBackupsToPrune(backups, { keep: 1, protect: new Set(['a']) }).map(b => b.id)).toEqual(['b'])
  })

  it('refuses to keep nothing', () => {
    expect(() => selectBackupsToPrune(backups, { keep: 0 })).toThrow('at least 1')
    expect(() => selectBackupsToPrune(backups, { keep: 1.5 })).toThrow('at least 1')
  })
})

describe('pruning', () => {
  it('removes only the backups outside the window and reports both sides', async () => {
    const { directory, remaining } = await fixture(['a', 'b', 'c']) // c is newest
    const result = await pruneBackups(directory, { keep: 1 })
    expect(result.removed).toEqual(['b', 'a'])
    expect(result.kept).toEqual(['c'])
    expect(await remaining()).toEqual(['c'])
  })

  it('never removes the backup the journal names, however old', async () => {
    const { directory, remaining } = await fixture(['rollback-point', 'mid', 'latest'], { phase: 'succeeded', id: 'rollback-point', version: '0.3.1' })
    const result = await pruneBackups(directory, { keep: 1 })
    expect(result.removed).toEqual(['mid'])
    expect(await remaining()).toEqual(['latest', 'rollback-point'])
  })

  it('refuses while an upgrade is active or recovery is required', async () => {
    const active = await fixture(['a', 'b'], { phase: 'installing', id: 'b' })
    await expect(pruneBackups(active.directory, { keep: 1 })).rejects.toThrow('in progress')
    expect(await active.remaining()).toEqual(['a', 'b'])
    const stuck = await fixture(['a', 'b'], { phase: 'recovery-required', id: 'b' })
    await expect(pruneBackups(stuck.directory, { keep: 1 })).rejects.toThrow('Recovery is required')
    expect(await stuck.remaining()).toEqual(['a', 'b'])
  })

  it('a dry run says what it would remove and removes nothing', async () => {
    const { directory, remaining } = await fixture(['a', 'b', 'c'])
    const result = await pruneBackups(directory, { keep: 1, dryRun: true })
    expect(result).toEqual({ kept: ['c'], removed: ['b', 'a'], dryRun: true })
    expect(await remaining()).toEqual(['a', 'b', 'c'])
  })

  it('does nothing when there is nothing to prune', async () => {
    const { directory } = await fixture([], { phase: 'idle' })
    expect(await pruneBackups(directory, { keep: 2 })).toEqual({ kept: [], removed: [], dryRun: false })
  })
})
