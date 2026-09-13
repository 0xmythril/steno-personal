import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { UpgradeEngine, writeJson } from '../updater/engine.mjs'
import { SidecarInstaller, composeWithSidecar, STELE_IMAGE, STELE_REPOSITORY, STELE_REF } from '../updater/wechat.mjs'

// The companion's "Enable WeChat". Real state files in a temp directory, a
// fake Docker that records every call; nothing is built or started.
const base = () => ({
  services: {
    app: { image: 'app@sha256:x', environment: { DATA_DIR: '/data' }, volumes: [{ type: 'volume', source: 'data', target: '/data' }] },
    updater: { image: 'updater@sha256:y' },
  },
  volumes: { data: { name: 'p_data' } },
})

describe('composeWithSidecar', () => {
  it('adds the sidecar in the app namespace and gives the app its mount and variables, once', () => {
    const once = composeWithSidecar(base(), '/host/.steno-updater')
    const twice = composeWithSidecar(once, '/host/.steno-updater')
    expect(twice).toEqual(once)
    expect(once.services.stele.network_mode).toBe('service:app')
    expect(once.services.stele.cap_add).toEqual(['SYS_PTRACE'])
    expect(once.services.stele.restart).toBe('no')
    expect(once.services.stele.ports).toBeUndefined()
    expect(once.services.app.environment).toMatchObject({ DATA_DIR: '/data', STELE_WECHAT_URL: 'http://127.0.0.1:6175', STELE_WECHAT_READ_TOKEN_FILE: '/run/steno-wechat/reader.token' })
    expect(once.services.app.volumes).toEqual([
      { type: 'volume', source: 'data', target: '/data' },
      { type: 'bind', source: '/host/.steno-updater/wechat', target: '/run/steno-wechat', read_only: true },
    ])
    expect(Object.keys(once.volumes).sort()).toEqual(['data', 'stele-client', 'stele-collector'])
    expect(once.services.updater).toEqual(base().services.updater)
  })

  it('escapes dollars in the host path like every other snapshot value', () => {
    expect(composeWithSidecar(base(), '/srv/$x').services.app.volumes[1].source).toBe('/srv/$$x/wechat')
  })
})

async function fixture({ imagePresent = true, tokens = [] as string[], failOn = '' } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'steno-wechat-'))
  await writeJson(path.join(directory, 'compose.json'), base())
  for (const name of tokens) {
    await mkdir(path.join(directory, 'wechat'), { recursive: true })
    await writeFile(path.join(directory, 'wechat', name), 'existing-synthetic-token-value-32-chars')
  }
  const calls: string[][] = []
  const docker = async (args: string[]) => {
    calls.push(args)
    if (args[0] === 'image' && !imagePresent) throw new Error('No such image: secret-path')
    if (args.includes(failOn)) throw new Error('docker stderr with /host/paths and SECRET=values')
    if (args[0] === 'cp') await writeFile(args[2], 'synthetic-token-value-with-32-characters')
    return ''
  }
  const compose = async (args: string[]) => { calls.push(['compose', ...args]); return args[0] === 'ps' ? 'c'.repeat(64) : '' }
  const driver = { deployment: { project: 'p', volume: 'p_data', hostStateDir: '/host/.steno-updater' }, docker, compose }
  const engine = new UpgradeEngine(directory, driver as never)
  await engine.initialize()
  const installer = new SidecarInstaller(directory, driver, engine)
  await installer.initialize()
  return { directory, calls, driver, engine, installer }
}
const has = (calls: string[][], ...words: string[]) => calls.filter(c => words.every(w => c.includes(w))).length

describe('installing the sidecar from the companion', () => {
  it('uses an existing image, rewrites the snapshot, starts everything, and issues both credentials', async () => {
    const { directory, calls, installer } = await fixture()
    expect((await installer.start()).phase).toBe('building')
    await installer.task
    expect(installer.status().phase).toBe('installed')
    expect(has(calls, 'build')).toBe(0)
    expect(has(calls, 'compose', 'up', '-d', '--pull', 'never')).toBe(1)
    expect(has(calls, 'credential-add', 'steno-reader', 'read')).toBe(1)
    expect(has(calls, 'credential-add', 'steno-login', 'read,login')).toBe(1)
    expect(has(calls, 'cp')).toBe(2)
    expect(has(calls, 'rm', '-f', '/data/collector/steno-reader.token')).toBe(1)
    const compose = JSON.parse(await readFile(path.join(directory, 'compose.json'), 'utf8'))
    expect(compose.services.stele.image).toBe(STELE_IMAGE)
    expect(compose.services.app.environment.STELE_WECHAT_URL).toBe('http://127.0.0.1:6175')
    for (const file of ['reader.token', 'login.token']) {
      expect(((await stat(path.join(directory, 'wechat', file))).mode & 0o777)).toBe(0o600)
    }
  })

  it('builds from the pinned Stele revision when the image is missing', async () => {
    const { calls, installer } = await fixture({ imagePresent: false })
    await installer.start(); await installer.task
    expect(installer.status().phase).toBe('installed')
    const builds = calls.filter(c => c[0] === 'build')
    expect(builds).toHaveLength(2)
    for (const build of builds) expect(build.at(-1)).toBe(`${STELE_REPOSITORY}#${STELE_REF}`)
    expect(builds[1]).toContain(`STELE_RELEASE=${STELE_REF}`)
  })

  it('keeps a credential the app already has and issues only the missing one', async () => {
    const { calls, directory, installer } = await fixture({ tokens: ['reader.token'] })
    await installer.start(); await installer.task
    expect(has(calls, 'credential-add', 'steno-reader')).toBe(0)
    expect(has(calls, 'credential-add', 'steno-login')).toBe(1)
    expect(await readFile(path.join(directory, 'wechat', 'reader.token'), 'utf8')).toBe('existing-synthetic-token-value-32-chars')
  })

  it('never overlaps an upgrade in either direction', async () => {
    const busy = await fixture()
    busy.engine.busy = true
    await expect(busy.installer.start()).rejects.toThrow('Upgrade unavailable')
    expect(busy.installer.status().phase).toBe('idle')

    const { installer, engine, driver } = await fixture()
    let finish = () => {}
    const gate = new Promise<void>(resolve => { finish = resolve })
    const compose = driver.compose
    driver.compose = async (args: string[]) => { if (args[0] === 'up') await gate; return compose(args) }
    await installer.start()
    await expect(installer.start()).rejects.toThrow('in progress')
    await expect(engine.start('0.2.0')).rejects.toThrow('unavailable')
    finish(); await installer.task
    expect(installer.status().phase).toBe('installed')
    expect(engine.busy).toBe(false)
  })

  it('records which step failed and nothing Docker said', async () => {
    const { directory, installer } = await fixture({ failOn: 'credential-add' })
    await installer.start(); await installer.task
    expect(installer.status()).toMatchObject({ phase: 'failed', error: 'credentials' })
    const journal = await readFile(path.join(directory, 'wechat.json'), 'utf8')
    expect(journal).not.toContain('SECRET')
    expect(journal).not.toContain('/host/paths')
    // A retry is allowed and starts clean.
    await installer.start()
    expect(installer.status().error).toBeUndefined()
    await installer.task
  })

  it('reports an install the companion restarted through as failed, ready to retry', async () => {
    const { directory, driver, engine } = await fixture()
    await writeJson(path.join(directory, 'wechat.json'), { phase: 'starting' })
    const restarted = new SidecarInstaller(directory, driver, engine)
    await restarted.initialize()
    expect(restarted.status()).toMatchObject({ phase: 'failed', error: 'interrupted' })
  })
})
