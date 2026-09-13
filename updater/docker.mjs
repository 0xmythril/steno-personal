import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { IMAGE, latestRelease } from './releases.mjs'
import { writeJson } from './engine.mjs'
import { dependentServices } from './config.mjs'

const exec = promisify(execFile)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

export class DockerDriver {
  constructor(directory, deployment) {
    this.directory = directory
    this.deployment = deployment
    this.helperName = `${deployment.project}-steno-upgrade-helper`
  }

  async docker(args, timeout = 120_000) {
    const { stdout } = await exec('docker', args, { timeout, maxBuffer: 1024 * 1024 })
    return stdout.trim()
  }

  compose(args) {
    return this.docker(['compose', '--project-name', this.deployment.project,
      '-f', path.join(this.directory, 'compose.json'), '-f', path.join(this.directory, 'release.json'), ...args], 300_000)
  }

  async container() {
    const id = await this.compose(['ps', '-a', '-q', 'app'])
    if (!id || id.includes('\n')) throw new Error('Expected one application container')
    return JSON.parse(await this.docker(['inspect', id]))[0]
  }

  async current() {
    const container = await this.container()
    if (!container.State.Running) throw new Error('Application must be running')
    const version = await this.docker(['exec', container.Id, 'node', '-p', "require('./package.json').version"])
    const mount = container.Mounts.find(m => m.Destination === '/data')
    if (mount?.Type !== 'volume' || mount.Name !== this.deployment.volume) throw new Error('Unexpected data volume')
    if (container.Mounts.some(m => m.Destination.startsWith('/data/'))) throw new Error('Nested archive mounts are not supported')
    return { version, image: container.Image }
  }

  release() { return latestRelease() }

  async helper(image, args, writable = false, timeout = 300_000) {
    return this.docker(['run', '--rm', '--name', this.helperName, '--network', 'none',
      '--label', `steno.updater.project=${this.deployment.project}`,
      '--mount', `type=volume,src=${this.deployment.volume},dst=/data${writable ? '' : ',readonly'}`,
      '--mount', `type=bind,src=${this.deployment.hostStateDir}/backups,dst=/backup`,
      '--entrypoint', args[0], image, ...args.slice(1)], timeout)
  }

  async prepare(version) {
    // The caller cannot select a registry, repository, arbitrary command or
    // volume. Pull once, then record the immutable digest for all later starts.
    const tag = `${IMAGE}:v${version}`
    await this.docker(['pull', tag], 20 * 60_000)
    const info = JSON.parse(await this.docker(['image', 'inspect', tag]))[0]
    const image = info.RepoDigests.find(d => d.startsWith(`${IMAGE}@sha256:`))
    if (!image) throw new Error('Missing release digest')
    const packagedVersion = await this.docker(['run', '--rm', '--network', 'none', '--entrypoint', 'node', image,
      '-p', "require('./package.json').version"])
    if (packagedVersion !== version) throw new Error('Release version mismatch')
    await mkdir(path.join(this.directory, 'backups'), { recursive: true, mode: 0o700 })
    const current = await this.current()
    const space = JSON.parse(await this.helper(current.image, ['node', '-e',
      "const fs=require('fs'),cp=require('child_process');const size=Number(cp.execFileSync('du',['-sk','/data'],{encoding:'utf8'}).split(/\\s/)[0])*1024;const s=fs.statfsSync('/backup');console.log(JSON.stringify({size,free:s.bavail*s.bsize}))"]))
    if (space.free < space.size * 2 + 128 * 1024 * 1024) throw new Error('Insufficient backup space')
    return image
  }

  async stop() {
    await this.compose(['stop', '-t', '120', 'app'])
    const running = await this.docker(['ps', '-q', '--filter', `volume=${this.deployment.volume}`])
    if (running) throw new Error('Another container is writing to the archive')
  }

  async cancelHelper() {
    // A killed CLI may leave its daemon-side container running. Clean up only
    // the helper with our installation label before retrying backup/restore.
    const id = await this.docker(['ps', '-a', '-q', '--filter', `name=^/${this.helperName}$`,
      '--filter', `label=steno.updater.project=${this.deployment.project}`])
    if (id) await this.docker(['rm', '-f', id])
  }

  async backup(state) {
    const directory = path.join(this.directory, 'backups', state.id)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeJson(path.join(directory, 'manifest.json'), {
      previous: state.previous, target: state.version,
      deployment: this.deployment,
      compose: JSON.parse(await readFile(path.join(this.directory, 'compose.json'), 'utf8')),
    })
    await this.helper(state.previous.image, ['sh', '-ec',
      'tar czf "$1/archive.tar.gz" -C /data .; tar tzf "$1/archive.tar.gz" >/dev/null; sync -f "$1/archive.tar.gz"',
      'backup', `/backup/${state.id}`], false, 60 * 60_000)
  }

  async restore(state) {
    await this.helper(state.previous.image, ['sh', '-ec',
      // Validate the archive before deleting anything, including hidden files.
      'tar tzf "$1/archive.tar.gz" >/dev/null; find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar xzf "$1/archive.tar.gz" -C /data',
      'restore', `/backup/${state.id}`], true, 60 * 60_000)
  }

  async install(image) {
    await writeJson(path.join(this.directory, 'release.json'), { services: { app: { image } } })
    await this.compose(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app'])
    // A sidecar in the app's namespace lost its network with the old
    // container. Bring it back; if it cannot start, that is the sidecar's
    // problem and not a reason to roll the archive back.
    const dependents = dependentServices(JSON.parse(await readFile(path.join(this.directory, 'compose.json'), 'utf8')))
    if (dependents.length) await this.compose(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate', ...dependents]).catch(() => {})
  }

  async verify(version, timeoutMs = 5 * 60_000) {
    const deadline = Date.now() + timeoutMs
    let successes = 0
    while (Date.now() < deadline) {
      try {
        const container = await this.container()
        if (!container.State.Running) throw new Error('Not running')
        const body = await this.docker(['exec', container.Id, 'node', '-e',
          "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/ready',{signal:AbortSignal.timeout(4000)}).then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())}).catch(()=>process.exit(1))"], 10_000)
        const ready = JSON.parse(body)
        if (!ready.ok || ready.version !== version) throw new Error('Not ready')
        // Avoid declaring victory on the first response before a crash loop.
        if (++successes >= 3) return
      } catch { successes = 0 }
      await pause(5000)
    }
    throw new Error('Readiness timed out')
  }
}
