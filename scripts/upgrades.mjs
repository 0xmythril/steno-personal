#!/usr/bin/env node
// Host-side installation and lifecycle commands. No credentials are printed.
import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import path from 'node:path'
import { composeEnvironment, composeLiteral } from '../updater/config.mjs'

const directory = path.resolve('.steno-updater')
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const write = (name, value) => writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const action = process.argv[2]

try {
  if (action === 'enable') {
    if (existsSync(directory)) throw new Error('Updater directory already exists; use the managed commands or recover the existing installation first.')
    const endpoint = JSON.parse(docker(['context', 'inspect']))[0].Endpoints.docker.Host
    if (!endpoint.startsWith('unix://') || process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT) {
      throw new Error('Use a local Unix-socket Docker context without DOCKER_HOST or DOCKER_CONTEXT overrides.')
    }
    const config = JSON.parse(docker(['compose', 'config', '--format', 'json']))
    // Desktop resolves bind mounts in its daemon VM, not at the host's
    // client socket path. Native Engine (including rootless) uses its endpoint.
    const daemonSocket = docker(['info', '--format', '{{.OperatingSystem}}']).includes('Docker Desktop')
      ? '/var/run/docker.sock' : endpoint.slice('unix://'.length)
    if (Object.keys(config.services).join(',') !== 'app') throw new Error('Automatic upgrades currently support the single-service app Compose deployment.')
    const id = docker(['compose', 'ps', '-q', 'app'])
    if (!id || id.includes('\n')) throw new Error('Start exactly one app container before enabling upgrades.')
    const container = JSON.parse(docker(['inspect', id]))[0]
    const volume = container.Mounts.find(m => m.Destination === '/data')
    if (volume?.Type !== 'volume') throw new Error('The app must use a named volume at /data.')
    if (container.Mounts.some(m => m.Destination.startsWith('/data/'))) throw new Error('Nested mounts below /data cannot be backed up by this updater.')
    const environment = Object.fromEntries(container.Config.Env.map(item => {
      const at = item.indexOf('='); return [item.slice(0, at), item.slice(at + 1)]
    }))
    if (environment.DATA_DIR !== '/data' || environment.RUN_WEB === 'false' || environment.RUN_WORKER === 'false' || environment.STENO_RESET) {
      throw new Error('Use /data, enable web and worker, and remove STENO_RESET before enabling upgrades.')
    }
    // Require the readiness endpoint before installing a release that might
    // need to roll back to this image.
    docker(['exec', id, 'node', '-e', "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"])
    console.log('Building the companion updater…')
    execFileSync('docker', ['build', '-f', 'updater/Dockerfile', '-t', 'steno-personal-updater:local', '.'], { stdio: 'inherit' })
    const updaterImage = JSON.parse(docker(['image', 'inspect', 'steno-personal-updater:local']))[0].Id
    const project = container.Config.Labels['com.docker.compose.project']
    if (!project) throw new Error('Application is not managed by Docker Compose.')
    mkdirSync(directory, { mode: 0o700 })
    for (const name of ['run', 'backups']) mkdirSync(path.join(directory, name), { mode: 0o700 })
    delete config.services.app.build
    config.services.app.image = container.Image
    config.services.app.environment = composeEnvironment({ ...environment, STENO_UPDATER_SOCKET: '/run/steno-updater/updater.sock' })
    config.services.app.stop_grace_period = '120s'
    config.services.app.volumes.push({ type: 'bind', source: composeLiteral(`${directory}/run`), target: '/run/steno-updater', read_only: true })
    config.services.updater = {
      image: updaterImage, restart: 'unless-stopped',
      volumes: [
        { type: 'bind', source: composeLiteral(daemonSocket), target: '/var/run/docker.sock' },
        { type: 'bind', source: composeLiteral(directory), target: '/state' },
      ],
    }
    write('compose.json', config)
    write('release.json', { services: { app: { image: container.Image } } })
    write('deployment.json', { project, volume: volume.Name, hostStateDir: directory })
    chmodSync(directory, 0o700)
    execFileSync('docker', ['compose', '-p', project, '-f', `${directory}/compose.json`, '-f', `${directory}/release.json`, 'up', '-d', '--no-build', '--pull', 'never'], { stdio: 'inherit' })
    console.log('Enabled. Open Settings → Software updates. Use node scripts/upgrades.mjs compose … for future container operations.')
  } else if (action === 'compose') {
    const { project } = JSON.parse(readFileSync(`${directory}/deployment.json`, 'utf8'))
    execFileSync('docker', ['compose', '-p', project, '-f', `${directory}/compose.json`, '-f', `${directory}/release.json`, ...process.argv.slice(3)], { stdio: 'inherit' })
  } else {
    console.log('Usage: node scripts/upgrades.mjs enable | compose <docker compose arguments>')
    process.exitCode = 1
  }
} catch (error) {
  // Docker errors may include resolved configuration containing secrets.
  console.error(error.status !== undefined ? 'Docker operation failed. Inspect the local deployment; configuration has not been printed because it can contain secrets.' : error.message)
  process.exitCode = 1
}
