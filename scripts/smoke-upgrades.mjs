// Real Docker/Compose, real tar backup/restore, synthetic archive only. The
// release registry is replaced with local fixtures; no accounts are paired.
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { UpgradeEngine, writeJson } from '../updater/engine.mjs'
import { DockerDriver } from '../updater/docker.mjs'
import { composeEnvironment } from '../updater/config.mjs'

const directory = await mkdtemp(path.join(os.tmpdir(), 'steno-upgrade-smoke-'))
const project = `steno-upgrade-smoke-${process.pid}`
const volume = `${project}_data`
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const images = []
let driver

try {
  for (const [name, version, broken] of [['old', '0.1.0', false], ['new', '0.2.0', false], ['broken', '0.2.0', true]]) {
    const context = path.join(directory, name)
    await mkdir(context)
    await writeFile(path.join(context, 'Dockerfile'), 'FROM node:24-slim\nWORKDIR /app\nCOPY . .\nCMD ["node", "app.mjs"]\n')
    await writeFile(path.join(context, 'package.json'), JSON.stringify({ version }))
    await writeFile(path.join(context, 'app.mjs'), `
      import http from 'node:http'; import fs from 'node:fs';
      if (!fs.existsSync('/data/archive')) fs.writeFileSync('/data/archive','original archive');
      if (!fs.existsSync('/data/.secret')) fs.writeFileSync('/data/.secret','synthetic secret');
      if (${name !== 'old'}) { fs.writeFileSync('/data/migration','new schema'); }
      if (${broken}) { fs.writeFileSync('/data/archive','failed migration'); }
      http.createServer((req,res)=>{res.writeHead(${broken ? 503 : 200},{'Content-Type':'application/json'});res.end(JSON.stringify({ok:${!broken},version:'${version}'}))}).listen(3000,'0.0.0.0');
    `)
    const tag = `${project}:${name}`
    docker(['build', '-q', '-t', tag, context]); images.push(tag)
  }
  await mkdir(path.join(directory, 'backups'))
  const deployment = { project, volume, hostStateDir: directory }
  await writeJson(path.join(directory, 'compose.json'), {
    services: { app: { image: images[0], environment: composeEnvironment({ DATA_DIR: '/data', SECRET_KEY: 'synthetic-$key-not-used-by-fixture' }), volumes: ['data:/data'] } },
    volumes: { data: { name: volume } },
  })
  await writeJson(path.join(directory, 'release.json'), { services: { app: { image: images[0] } } })
  class FixtureDriver extends DockerDriver {
    candidate = images[1]
    release() { return Promise.resolve({ version: '0.2.0' }) }
    prepare() { return Promise.resolve(this.candidate) }
    verify(version) { return super.verify(version, 25_000) }
  }
  driver = new FixtureDriver(directory, deployment)
  await driver.install(images[0]); await driver.verify('0.1.0')
  const engine = new UpgradeEngine(directory, driver)
  await engine.initialize()
  await engine.start('0.2.0'); await engine.task
  assert.equal(engine.status().phase, 'succeeded')
  let app = await driver.container()
  assert.equal(docker(['exec', app.Id, 'cat', '/data/archive']), 'original archive')
  assert.equal(docker(['exec', app.Id, 'cat', '/data/migration']), 'new schema')
  const backup = engine.state
  const manifest = JSON.parse(await readFile(path.join(directory, 'backups', backup.id, 'manifest.json'), 'utf8'))
  assert.equal(manifest.compose.services.app.environment.SECRET_KEY, 'synthetic-$$key-not-used-by-fixture')
  assert.equal(docker(['exec', app.Id, 'node', '-p', 'process.env.SECRET_KEY']), 'synthetic-$key-not-used-by-fixture')

  // Recreate an interrupted installation, with mutated archive contents.
  await driver.stop(); await driver.restore(backup); await driver.install(images[2])
  await new Promise(resolve => setTimeout(resolve, 1500))
  await writeJson(path.join(directory, 'journal.json'), { ...backup, phase: 'installing' })
  const restarted = new UpgradeEngine(directory, driver)
  await restarted.initialize()
  assert.equal(restarted.status().phase, 'rolled-back')
  app = await driver.container()
  assert.equal(docker(['exec', app.Id, 'cat', '/data/archive']), 'original archive')
  assert.equal(docker(['exec', app.Id, 'cat', '/data/.secret']), 'synthetic secret')
  docker(['exec', app.Id, 'test', '!', '-e', '/data/migration'])

  driver.candidate = images[2]
  await restarted.start('0.2.0'); await restarted.task
  assert.equal(restarted.status().phase, 'rolled-back')
  app = await driver.container()
  assert.equal(docker(['exec', app.Id, 'cat', '/data/archive']), 'original archive')
  console.log('Upgrade smoke passed: replacement, full backup, failed readiness, and restart recovery.')
} finally {
  if (driver) {
    await driver.cancelHelper().catch(() => {})
    await driver.compose(['down', '-v']).catch(() => {})
  }
  for (const image of images) { try { docker(['image', 'rm', '-f', image]) } catch { /* retain test failure */ } }
  await rm(directory, { recursive: true, force: true })
}
