import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, writeFile, stat, symlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { managedEnvironment, SETUP_START, SETUP_END } from '../updater/setup-config.mjs'
import { installUpgrades } from '../updater/install.mjs'

const appImage = `sha256:${'a'.repeat(64)}`
const updaterImage = `sha256:${'b'.repeat(64)}`

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'steno-setup-'))
  const originalEnv = '# My settings\nSECRET_KEY="synthetic-$cash"\nPORT=3000\n'
  await writeFile(path.join(root, '.env'), originalEnv, { mode: 0o600 })
  const calls: string[][] = []
  const container = {
    State: { Running: true }, Image: appImage,
    Config: { Labels: { 'com.docker.compose.project': 'existing-steno' }, Env: ['DATA_DIR=/data', 'SECRET_KEY=synthetic-$cash', 'PORT=3000'] },
    Mounts: [{ Destination: '/data', Type: 'volume', Name: 'existing-steno_data' }],
  }
  const docker = async (args: string[]) => {
    calls.push(args)
    if (args[0] === 'inspect') return JSON.stringify([container])
    if (args[0] === 'compose' && args.includes('ps')) return 'c'.repeat(64)
    return ''
  }
  const options = {
    root, containerId: 'c'.repeat(64), updaterImage, daemonSocket: '/var/run/docker.sock',
    config: { services: { app: { build: '.', env_file: ['./.env'], image: 'old-source-build', volumes: [{ type: 'volume', source: 'data', target: '/data' }] } }, volumes: { data: { name: 'existing-steno_data' } } },
  }
  return { root, originalEnv, calls, container, docker, options }
}

describe('ordinary Compose routing', () => {
  it('preserves existing values and makes the installed release the default', () => {
    const original = '# custom\nSECRET_KEY="literal-$secret"\nCOMPOSE_FILE=custom.yml'
    const env = managedEnvironment(original, 'my-steno')
    expect(env.startsWith(original + '\n')).toBe(true)
    expect(env).toContain('COMPOSE_FILE=.steno-updater/compose.json:.steno-updater/release.json')
    expect(env).toContain('COMPOSE_PROJECT_NAME=my-steno')
    expect(managedEnvironment(env, 'my-steno')).toBe(env)
  })
  it('retains later custom settings while keeping one authoritative routing block', () => {
    const env = managedEnvironment(managedEnvironment('CUSTOM=one\n', 'my-steno') + 'OTHER=two\n', 'my-steno')
    expect(env).toContain('CUSTOM=one\nOTHER=two\n')
    expect(env.split(SETUP_START)).toHaveLength(2)
    expect(env.endsWith(SETUP_END + '\n')).toBe(true)
  })
  it('refuses malformed markers and project names before writing anything', () => {
    expect(() => managedEnvironment(SETUP_START, 'steno')).toThrow('incomplete')
    expect(() => managedEnvironment(SETUP_END + '\n' + SETUP_START, 'steno')).toThrow()
    expect(() => managedEnvironment('', 'steno\nINJECTED=yes')).toThrow('Invalid')
  })
})

describe('Docker-only setup', () => {
  it('retains the running image, volume, environment, and original .env', async () => {
    const { root, originalEnv, docker, options, calls } = await fixture()
    expect(await installUpgrades(options, docker)).toEqual({ project: 'existing-steno', resumed: false })
    const state = path.join(root, '.steno-updater')
    const snapshot = JSON.parse(await readFile(path.join(state, 'compose.json'), 'utf8'))
    expect(snapshot.services.app.image).toBe(appImage)
    expect(snapshot.services.app.environment.SECRET_KEY).toBe('synthetic-$$cash')
    expect(snapshot.services.app.build).toBeUndefined()
    expect(snapshot.services.app.env_file).toBeUndefined()
    expect(snapshot.services.app.environment.STENO_UPDATER_SOCKET).toBe('/run/steno-updater/updater.sock')
    expect(snapshot.services.app.volumes).not.toContainEqual(expect.objectContaining({ target: '/var/run/docker.sock' }))
    expect(snapshot.volumes.data.name).toBe('existing-steno_data')
    expect(await readFile(path.join(state, 'env.before-upgrades'), 'utf8')).toBe(originalEnv)
    expect((await stat(state)).mode & 0o777).toBe(0o700)
    expect((await stat(path.join(root, '.env'))).mode & 0o777).toBe(0o600)
    expect(calls).toContainEqual(expect.arrayContaining(['up', '-d', '--no-build', '--pull', 'never']))
    expect(calls.at(-1)?.[0]).toBe('exec') // setup succeeds only after checking both services
  })
  it('can resume a failed service restart without replacing the selected release or backup', async () => {
    const { root, docker, options, originalEnv } = await fixture()
    const failing = async (args: string[]) => { if (args[0] === 'compose') throw new Error('daemon unavailable'); return docker(args) }
    await expect(installUpgrades(options, failing)).rejects.toThrow('daemon unavailable')
    const release = path.join(root, '.steno-updater/release.json')
    const selected = { services: { app: { image: `sha256:${'d'.repeat(64)}` } } }
    await writeFile(release, JSON.stringify(selected))
    expect(await installUpgrades(options, docker)).toHaveProperty('resumed', true)
    expect(JSON.parse(await readFile(release, 'utf8'))).toEqual(selected)
    expect(await readFile(path.join(root, '.steno-updater/env.before-upgrades'), 'utf8')).toBe(originalEnv)
    expect((await readFile(path.join(root, '.env'), 'utf8')).split(SETUP_START)).toHaveLength(2)
  })
  it('refuses setup during an unfinished upgrade or recovery', async () => {
    const { root, docker, options, calls } = await fixture()
    await installUpgrades(options, docker)
    const original = await readFile(path.join(root, '.env'), 'utf8')
    calls.length = 0
    for (const phase of ['preparing', 'installing', 'recovery-required']) {
      await writeFile(path.join(root, '.steno-updater/journal.json'), JSON.stringify({ phase }))
      await expect(installUpgrades(options, docker)).rejects.toThrow('unfinished')
    }
    expect(calls).toEqual([])
    expect(await readFile(path.join(root, '.env'), 'utf8')).toBe(original)
  })
  it('does not change files if the running app cannot support upgrades yet', async () => {
    const { root, options, docker, originalEnv } = await fixture()
    const notReady = async (args: string[]) => { if (args[0] === 'exec') throw new Error('404'); return docker(args) }
    await expect(installUpgrades(options, notReady)).rejects.toThrow('not ready')
    expect(await readFile(path.join(root, '.env'), 'utf8')).toBe(originalEnv)
    await expect(stat(path.join(root, '.steno-updater'))).rejects.toHaveProperty('code', 'ENOENT')
  })
  it('preserves external environment files by refusing symlinked .env files', async () => {
    const { root, options, docker } = await fixture()
    await symlink(path.join(root, '.env'), path.join(root, 'external-link'))
    options.root = await mkdtemp(path.join(os.tmpdir(), 'steno-link-'))
    await symlink(path.join(root, '.env'), path.join(options.root, '.env'))
    await expect(installUpgrades(options, docker)).rejects.toThrow('regular .env')
  })
})
