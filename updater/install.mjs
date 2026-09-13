import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, mkdir, mkdtemp, lstat, stat, chown, open, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { composeEnvironment, composeLiteral } from './config.mjs'
import { managedEnvironment } from './setup-config.mjs'
import { writeJson, terminal } from './engine.mjs'

export class SetupError extends Error {}
const exec = promisify(execFile)
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const maybeStat = async file => {
  try { return await lstat(file) } catch (error) { if (error.code !== 'ENOENT') throw error; return null }
}

export async function waitForSetup(docker, compose, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const id = await docker([...compose, 'ps', '-q', 'app'])
      if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('Not running')
      await docker(['exec', id, 'node', '-e',
        "const http=require('http');const timer=setTimeout(()=>process.exit(1),10000);fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/ready',{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)process.exit(1);const q=http.request({socketPath:process.env.STENO_UPDATER_SOCKET,path:'/status'},res=>{res.resume();res.on('end',()=>{clearTimeout(timer);process.exit(res.statusCode===200?0:1)})});q.on('error',()=>process.exit(1));q.end()}).catch(()=>process.exit(1))"])
      return
    } catch { /* Startup is asynchronous; retry without logging configuration. */ }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new SetupError('Setup files are saved, but Steno or the updater is not ready yet. Check docker compose logs --tail 100, then rerun setup.')
}

async function privateText(file, text, owner) {
  const temp = `${file}.${randomUUID()}.tmp`
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.chown(owner.uid, owner.gid)
    await handle.writeFile(text)
    await handle.sync()
  } finally { await handle.close() }
  await rename(temp, file)
  const dir = await open(path.dirname(file), 'r')
  try { await dir.sync() } finally { await dir.close() }
}

export async function installUpgrades({ root, config, containerId, updaterImage, daemonSocket }, docker, report = (_message) => {}) {
  const directory = path.join(root, '.steno-updater')
  const envFile = path.join(root, '.env')
  const owner = await stat(root)
  const envStat = await maybeStat(envFile)
  const stateStat = await maybeStat(directory)
  if (envStat?.isSymbolicLink() || stateStat?.isSymbolicLink()) throw new SetupError('Setup needs regular .env and .steno-updater paths; use the manual guide for symlinked configurations.')
  const originalEnv = envStat ? await readFile(envFile, 'utf8') : ''
  let project
  let resumed = false

  if (stateStat) {
    // Never reconstruct or replace an existing installation from today's
    // source compose file: its recorded image may be newer than this checkout.
    const deployment = await json(path.join(directory, 'deployment.json'))
    project = deployment.project
    if (deployment.hostStateDir !== directory) throw new SetupError('This installation belongs to another directory. Use the recovery guide before moving it.')
    await json(path.join(directory, 'compose.json'))
    await json(path.join(directory, 'release.json'))
    const journalFile = path.join(directory, 'journal.json')
    if (await maybeStat(journalFile)) {
      const journal = await json(journalFile)
      if (!terminal(journal.phase) || journal.phase === 'recovery-required') throw new SetupError('An upgrade or recovery is unfinished. Let it finish or follow the recovery guide before running setup.')
    }
    resumed = true
    report('Keeping the existing release, volume, and backups.')
  } else {
    if (!config?.services?.app) throw new SetupError('Setup supports the Steno Compose deployment with an app service. See the manual guide for custom deployments.')
    // Other services are fine as long as none of them can write the archive:
    // the WeChat sidecar has its own volumes. A second writer would make the
    // pre-upgrade backup a lie.
    const archive = (config.services.app.volumes ?? []).find(v => (typeof v === 'string' ? v.split(':')[1] : v?.target) === '/data')
    const archiveSource = typeof archive === 'string' ? archive.split(':')[0] : archive?.source
    for (const [name, service] of Object.entries(config.services)) {
      if (name === 'app') continue
      const mounts = (service?.volumes ?? []).map(v => typeof v === 'string' ? v.split(':')[0] : v?.source)
      if (archiveSource && mounts.includes(archiveSource)) throw new SetupError(`Service ${name} mounts the archive volume. Only app may; see the manual guide.`)
    }
    if (!/^[a-f0-9]{12,64}$/.test(containerId ?? '') || !/^sha256:[a-f0-9]{64}$/.test(updaterImage ?? '')) throw new SetupError('Start the app with docker compose up -d before enabling upgrades.')
    const container = JSON.parse(await docker(['inspect', containerId]))[0]
    project = container.Config.Labels?.['com.docker.compose.project']
    const volume = container.Mounts.find(m => m.Destination === '/data')
    if (!container.State.Running || volume?.Type !== 'volume' || container.Mounts.some(m => m.Destination.startsWith('/data/'))) throw new SetupError('Start one app with a named volume at /data and no nested mounts before enabling upgrades.')
    const environment = Object.fromEntries(container.Config.Env.map(item => {
      const at = item.indexOf('='); return [item.slice(0, at), item.slice(at + 1)]
    }))
    const off = value => value?.trim().toLowerCase() === 'false'
    if (environment.DATA_DIR !== '/data' || off(environment.RUN_WEB) || off(environment.RUN_WORKER) || environment.STENO_RESET) throw new SetupError('Use /data, enable both web and worker, and remove STENO_RESET before enabling upgrades.')
    try {
      await docker(['exec', containerId, 'node', '-e', "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/ready',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"])
    } catch { throw new SetupError('Steno is not ready for setup. Wait for startup, then retry. Older versions must first be updated to a release with Software updates in Settings.') }
    // Validate routing before creating any persistent installation files.
    managedEnvironment(originalEnv, project)
    const snapshot = structuredClone(config)
    delete snapshot.services.app.build
    delete snapshot.services.app.env_file // literal values come from the running container
    snapshot.services.app.image = container.Image
    snapshot.services.app.environment = composeEnvironment({ ...environment, STENO_UPDATER_SOCKET: '/run/steno-updater/updater.sock' })
    snapshot.services.app.stop_grace_period = '120s'
    snapshot.services.app.volumes ??= []
    snapshot.services.app.volumes.push({ type: 'bind', source: composeLiteral(`${directory}/run`), target: '/run/steno-updater', read_only: true })
    snapshot.services.updater = {
      image: updaterImage, init: true, restart: 'unless-stopped',
      volumes: [
        { type: 'bind', source: composeLiteral(daemonSocket), target: '/var/run/docker.sock' },
        { type: 'bind', source: composeLiteral(directory), target: '/state' },
      ],
    }
    const temporary = await mkdtemp(path.join(root, '.steno-updater-pending-'))
    try {
      await chown(temporary, owner.uid, owner.gid)
      for (const name of ['run', 'backups']) {
        const child = path.join(temporary, name)
        await mkdir(child, { mode: 0o700 }); await chown(child, owner.uid, owner.gid)
      }
      await writeJson(path.join(temporary, 'compose.json'), snapshot)
      await writeJson(path.join(temporary, 'release.json'), { services: { app: { image: container.Image } } })
      await writeJson(path.join(temporary, 'deployment.json'), { project, volume: volume.Name, hostStateDir: directory })
      await rename(temporary, directory)
    } finally { await rm(temporary, { recursive: true, force: true }) }
  }

  const nextEnv = managedEnvironment(originalEnv, project)
  const backup = path.join(directory, 'env.before-upgrades')
  if (!(await maybeStat(backup))) await privateText(backup, originalEnv, owner)
  await privateText(envFile, nextEnv, envStat ?? owner)
  report('Starting Steno and the updater. Your data volume and encryption key stay in place.')
  const compose = ['compose', '-p', project, '-f', path.join(directory, 'compose.json'), '-f', path.join(directory, 'release.json')]
  await docker([...compose, 'up', '-d', '--no-build', '--pull', 'never'])
  await waitForSetup(docker, compose)
  report('Enabled. Refresh Settings and choose Check for updates. Ordinary docker compose commands now keep the installed release.')
  return { project, resumed }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const docker = async args => (await exec('docker', args, { timeout: 300_000, maxBuffer: 1024 * 1024 })).stdout.trim()
  try {
    const input = process.env.STENO_SETUP_INPUT
    await installUpgrades({
      root: process.cwd(), config: await json(`${input}/config.json`),
      containerId: (await readFile(`${input}/container-id`, 'utf8')).trim(),
      updaterImage: process.env.STENO_SETUP_IMAGE, daemonSocket: process.env.STENO_SETUP_SOCKET,
    }, docker, message => console.log(message))
  } catch (error) {
    // Never print Docker stderr or parsed configuration: both can contain keys.
    console.error(error instanceof SetupError ? error.message : 'Setup could not finish. Your files have been retained. Check Docker and rerun setup; use the upgrade guide if recovery is required.')
    process.exitCode = 1
  }
}
