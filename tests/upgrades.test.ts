import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { UpgradeEngine, writeJson } from '../updater/engine.mjs'
import { newerVersion, latestRelease } from '../updater/releases.mjs'
import { composeEnvironment, dependentServices } from '../updater/config.mjs'

// Each stage fsyncs a real journal. Slow/contended disks must not turn a
// durability test into a timing assertion about the development machine.
vi.setConfig({ testTimeout: 30_000 })

async function fixture(fail?: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'steno-upgrade-'))
  const calls: string[] = []
  let failed = false
  const step = async (name: string) => {
    calls.push(name)
    if (name === fail && !failed) { failed = true; throw new Error('Docker failed') }
  }
  const driver = {
    current: async () => ({ version: '0.1.0', image: 'old-digest' }),
    release: async () => ({ version: '0.2.0' }),
    prepare: async () => { await step('prepare'); return 'new-digest' },
    stop: () => step('stop'),
    backup: () => step('backup'),
    install: (image: string) => step(`install:${image}`),
    verify: (version: string) => step(`verify:${version}`),
    restore: () => step('restore'),
    cancelHelper: () => step('cancel-helper'),
  }
  const engine = new UpgradeEngine(directory, driver)
  await engine.initialize()
  return { engine, driver, directory, calls }
}

describe('upgrade transaction', () => {
  it('backs up before replacing the image and persists success', async () => {
    const { engine, calls, directory } = await fixture()
    await engine.start('0.2.0')
    await expect(engine.start('0.2.0')).rejects.toThrow('unavailable')
    await engine.task
    expect(calls).toEqual(['prepare', 'stop', 'backup', 'install:new-digest', 'verify:0.2.0'])
    expect(JSON.parse(await readFile(path.join(directory, 'journal.json'), 'utf8')).phase).toBe('succeeded')
  })

  it('does not stop or restore the app when preparation fails', async () => {
    const { engine, calls } = await fixture('prepare')
    await engine.start('0.2.0'); await engine.task
    expect(calls).toEqual(['prepare', 'cancel-helper'])
    expect(engine.status().phase).toBe('failed')
  })

  it('restarts the previous app without restoring an incomplete backup', async () => {
    const { engine, calls } = await fixture('backup')
    await engine.start('0.2.0'); await engine.task
    expect(calls).not.toContain('restore')
    expect(calls).not.toContain('install:new-digest')
    expect(calls.slice(-2)).toEqual(['install:old-digest', 'verify:0.1.0'])
    expect(engine.status().phase).toBe('rolled-back')
  })

  it.each(['install:new-digest', 'verify:0.2.0'])('restores data and image after %s fails', async fail => {
    const { engine, calls } = await fixture(fail)
    await engine.start('0.2.0'); await engine.task
    expect(calls.slice(-5)).toEqual(['cancel-helper', 'stop', 'restore', 'install:old-digest', 'verify:0.1.0'])
    expect(engine.status().phase).toBe('rolled-back')
  })

  it.each(['stopping', 'backing-up', 'installing', 'verifying', 'rolling-back'])('recovers after a process restart during %s', async phase => {
    const { directory, driver, calls } = await fixture()
    const complete = !['stopping', 'backing-up'].includes(phase)
    await writeJson(path.join(directory, 'journal.json'), {
      phase, id: 'test-backup', previous: { image: 'old-digest', version: '0.1.0' }, backupComplete: complete,
    })
    const restarted = new UpgradeEngine(directory, driver)
    await restarted.initialize()
    expect(calls.includes('restore')).toBe(complete)
    expect(calls.indexOf('cancel-helper')).toBeLessThan(calls.indexOf('stop'))
    expect(restarted.status().phase).toBe('rolled-back')
  })

  it('blocks further upgrades if recovery fails', async () => {
    const { engine, driver } = await fixture('verify:0.2.0')
    driver.restore = async () => { throw new Error('Restore failed') }
    await engine.start('0.2.0'); await engine.task
    expect(engine.status().phase).toBe('recovery-required')
    await expect(engine.start('0.2.0')).rejects.toThrow('unavailable')
  })

  it('refuses an incomplete journal before touching the application', async () => {
    const { directory, driver, calls } = await fixture()
    await writeJson(path.join(directory, 'journal.json'), { phase: 'installing' })
    await expect(new UpgradeEngine(directory, driver).initialize()).rejects.toThrow('Incomplete upgrade journal')
    expect(calls).toEqual([])
  })

  it.each(['0.1.0', '0.0.1', '1.0.0', '0.2.0-rc.1', 'evil/image:tag', '0.2.0;id'])('rejects an unapproved target %s before mutation', async version => {
    const { engine, calls } = await fixture()
    await expect(engine.start(version)).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it('does not allow automatic major upgrades even when latest', async () => {
    const { engine, driver } = await fixture()
    driver.release = async () => ({ version: '1.0.0' })
    await expect(engine.start('1.0.0')).rejects.toThrow()
  })
})

describe('release information', () => {
  it('preserves literal secret values when a snapshot is interpreted by Compose', () => {
    expect(composeEnvironment({ SECRET_KEY: 'literal-$VALUE-${OTHER}-$$-end', PORT: '3000' })).toEqual({
      SECRET_KEY: 'literal-$$VALUE-$${OTHER}-$$$$-end', PORT: '3000',
    })
  })
  it('compares numeric versions and refuses prereleases', () => {
    expect(newerVersion('0.10.0', '0.9.0')).toBe(true)
    expect(newerVersion('0.1.0', '0.1.0')).toBe(false)
    expect(newerVersion('0.2.0-rc.1', '0.1.0')).toBe(false)
  })
  it('checks only the fixed repository and returns a canonical link', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ tag_name: 'v0.2.0', html_url: 'https://untrusted.invalid' }))
    try {
      expect(await latestRelease()).toEqual({ version: '0.2.0', url: 'https://github.com/0xmythril/steno-personal/releases/tag/v0.2.0' })
      expect(fetcher.mock.calls[0][0]).toBe('https://api.github.com/repos/0xmythril/steno-personal/releases/latest')
    } finally { fetcher.mockRestore() }
  })
})

describe('sidecars in the app namespace', () => {
  it('names only services that share network with app, so install can recreate them', () => {
    const compose = { services: {
      app: { image: 'a' },
      updater: { image: 'u' },
      stele: { image: 's', network_mode: 'service:app' },
      other: { image: 'o', network_mode: 'host' },
    } }
    expect(dependentServices(compose)).toEqual(['stele'])
    expect(dependentServices({})).toEqual([])
    expect(dependentServices({ services: { app: { network_mode: 'service:app' } } })).toEqual([])
  })
})
