import { mkdir, chmod, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { composeLiteral } from './config.mjs'
import { writeJson } from './engine.mjs'

// The companion's side of "Enable WeChat": what scripts/enable-wechat.sh does
// on a host shell, done inside the managed deployment so a portal click can
// start it. The Stele revision is fixed here and in that script;
// tests/wechat-setup-structure.test.ts keeps the two equal.
export const STELE_REPOSITORY = 'https://github.com/0xmythril/stele.git'
export const STELE_REF = '3bf1359377f58c19e3a950c718eec189003d1a54'
export const STELE_IMAGE = 'stele-wechat:local'
export const STELE_CLIENT_IMAGE = 'stele-client:local'
export const TOKEN_MOUNT = '/run/steno-wechat'
export const CREDENTIALS = [
  { id: 'steno-reader', scopes: 'read', file: 'reader.token' },
  { id: 'steno-login', scopes: 'read,login', file: 'login.token' },
]
const STELE_CLI = ['node', 'channels/wechat/src/cli.ts']
const STELE_CONFIG = '/data/collector/config.json'
export const ACTIVE = ['building', 'starting', 'credentials']

export const sidecarInstalled = compose => Boolean(compose?.services?.stele)

// The same shape as compose.wechat.yaml, applied to the managed snapshot:
// the sidecar shares the app's network namespace, the app gets the token
// mount and the three variables. Applying it twice changes nothing.
export function composeWithSidecar(compose, hostStateDir) {
  const next = structuredClone(compose)
  const app = next.services.app
  app.environment = { ...(app.environment ?? {}),
    STELE_WECHAT_URL: 'http://127.0.0.1:6175',
    STELE_WECHAT_READ_TOKEN_FILE: `${TOKEN_MOUNT}/reader.token`,
    STELE_WECHAT_LOGIN_TOKEN_FILE: `${TOKEN_MOUNT}/login.token` }
  app.volumes ??= []
  if (!app.volumes.some(v => v?.target === TOKEN_MOUNT)) {
    app.volumes.push({ type: 'bind', source: composeLiteral(`${hostStateDir}/wechat`), target: TOKEN_MOUNT, read_only: true })
  }
  next.services.stele = {
    image: STELE_IMAGE, pull_policy: 'never', init: true, network_mode: 'service:app',
    cap_add: ['SYS_PTRACE'], shm_size: '512m', restart: 'no', stop_grace_period: '60s',
    volumes: [
      { type: 'volume', source: 'stele-collector', target: '/data' },
      { type: 'volume', source: 'stele-client', target: '/home/client' },
    ],
    logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '2' } },
  }
  next.volumes = { ...(next.volumes ?? {}), 'stele-collector': {}, 'stele-client': {} }
  return next
}

export class SidecarInstaller {
  constructor(directory, driver, engine, report = (_phase) => {}) {
    this.directory = directory
    this.driver = driver
    this.engine = engine
    this.report = report
    this.state = { phase: 'idle' }
  }

  async initialize() {
    try { this.state = JSON.parse(await readFile(path.join(this.directory, 'wechat.json'), 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    // A companion restart mid-install leaves nothing dangerous behind: every
    // step is safe to repeat. Say it stopped so the owner can try again.
    if (ACTIVE.includes(this.state.phase)) await this.save({ phase: 'failed', error: 'interrupted' })
  }

  async save(changes) {
    const next = { ...this.state, ...changes, updatedAt: new Date().toISOString() }
    if (changes.error === undefined) delete next.error
    await writeJson(path.join(this.directory, 'wechat.json'), next)
    this.state = next
    this.report(next.phase)
  }

  status() {
    const { phase, updatedAt, error } = this.state
    return { phase, updatedAt, error }
  }

  async start() {
    if (ACTIVE.includes(this.state.phase)) throw new Error('Install in progress')
    const release = this.engine.hold() // refuses during an upgrade; blocks one while we run
    await this.save({ phase: 'building' })
    this.task = this.run().finally(release)
    return this.status()
  }

  async run() {
    let step = 'build'
    try {
      // An image the operator built or copied in by hand is used as is; that
      // is the escape hatch for a host without access to the Stele repository.
      const present = await this.driver.docker(['image', 'inspect', STELE_IMAGE]).then(() => true, () => false)
      if (!present) {
        const context = `${STELE_REPOSITORY}#${STELE_REF}`
        await this.driver.docker(['build', '-f', 'channels/wechat/container/client.Dockerfile', '-t', STELE_CLIENT_IMAGE, context], 45 * 60_000)
        await this.driver.docker(['build', '-f', 'channels/wechat/container/runtime.Dockerfile',
          '--build-arg', `STELE_CLIENT_IMAGE=${STELE_CLIENT_IMAGE}`, '--build-arg', `STELE_RELEASE=${STELE_REF}`,
          '-t', STELE_IMAGE, context], 45 * 60_000)
      }
      step = 'start'
      await this.save({ phase: 'starting' })
      const composeFile = path.join(this.directory, 'compose.json')
      const compose = JSON.parse(await readFile(composeFile, 'utf8'))
      if (!sidecarInstalled(compose)) await writeJson(composeFile, composeWithSidecar(compose, this.driver.deployment.hostStateDir))
      await mkdir(path.join(this.directory, 'wechat'), { recursive: true, mode: 0o700 })
      // Recreates the app with its new mount and variables, starts the sidecar
      // beside it, and leaves this companion alone (its config is unchanged).
      await this.driver.compose(['up', '-d', '--no-build', '--pull', 'never'])
      step = 'stele'
      const stele = await this.waitForStele()
      step = 'credentials'
      await this.save({ phase: 'credentials' })
      // Issued inside Stele's private volume, copied out once, removed there.
      // Stele keeps only hashes. An existing token is kept, so a retry after
      // a failure never rotates a credential the app already uses.
      for (const credential of CREDENTIALS) {
        const file = path.join(this.directory, 'wechat', credential.file)
        if (await stat(file).then(info => info.size > 0, () => false)) continue
        await this.driver.docker(['exec', stele, ...STELE_CLI, 'credential-revoke', STELE_CONFIG, credential.id]).catch(() => {})
        await this.driver.docker(['exec', stele, ...STELE_CLI, 'credential-add', STELE_CONFIG, credential.id, credential.scopes, `/data/collector/${credential.id}.token`])
        await this.driver.docker(['cp', `${stele}:/data/collector/${credential.id}.token`, file])
        await chmod(file, 0o600)
        await this.driver.docker(['exec', stele, 'rm', '-f', `/data/collector/${credential.id}.token`])
      }
      await this.save({ phase: 'installed' })
    } catch {
      // Docker output can carry configuration and stderr can carry paths;
      // record which step failed, never why.
      await this.save({ phase: 'failed', error: step })
    }
  }

  async waitForStele(timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const id = await this.driver.compose(['ps', '-q', 'stele'])
        if (/^[a-f0-9]{12,64}$/.test(id)) {
          await this.driver.docker(['exec', id, ...STELE_CLI, 'status', STELE_CONFIG], 15_000)
          return id
        }
      } catch { /* still starting */ }
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    throw new Error('Stele did not start')
  }
}
