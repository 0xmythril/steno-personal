// Exercise the actual shell installer and companion image. The host-side
// installer PATH deliberately contains no Node executable. All data is fake.
import { mkdtemp, writeFile, mkdir, cp, rm, readFile, symlink } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { DockerDriver } from '../updater/docker.mjs'

const source = process.cwd()
const root = await mkdtemp(path.join(os.tmpdir(), 'steno-setup-smoke-'))
const project = `steno-setup-smoke-${process.pid}`
const oldImage = `${project}:old`
const newImage = `${project}:new`
const docker = args => execFileSync('docker', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const envText = 'SECRET_KEY=\'synthetic-$setup-secret\'\nCUSTOM_SETTING=keep-this\n'
let driver
try {
  await cp(path.join(source, 'updater'), path.join(root, 'updater'), { recursive: true })
  await mkdir(path.join(root, 'scripts'))
  await cp(path.join(source, 'scripts/enable-upgrades.sh'), path.join(root, 'scripts/enable-upgrades.sh'))
  await writeFile(path.join(root, '.dockerignore'), '.steno-updater*\n.env*\nbin\n')
  await writeFile(path.join(root, '.env'), envText, { mode: 0o600 })
  await writeFile(path.join(root, 'Dockerfile'), 'FROM node:24-slim\nWORKDIR /app\nCOPY app.mjs package.json ./\nCMD ["node", "app.mjs"]\n')
  await writeFile(path.join(root, 'app.mjs'), `
    import http from 'node:http'; import fs from 'node:fs';
    const {version}=JSON.parse(fs.readFileSync('./package.json','utf8'));
    if(!fs.existsSync('/data/archive'))fs.writeFileSync('/data/archive','synthetic archive');
    http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,version}))}).listen(3000,'0.0.0.0');
  `)
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.2.0' }))
  docker(['build', '-q', '-t', oldImage, '.'])
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.2.1' }))
  docker(['build', '-q', '-t', newImage, '.'])
  await writeFile(path.join(root, 'docker-compose.yml'), JSON.stringify({
    name: project,
    services: { app: { image: oldImage, init: true, environment: { DATA_DIR: '/data', SECRET_KEY: '${SECRET_KEY}' }, volumes: ['data:/data'] } },
    volumes: { data: { name: `${project}_data` } },
  }))
  docker(['compose', 'up', '-d'])
  const appBefore = docker(['compose', 'ps', '-q', 'app'])
  // Wait for the fixture to listen before the installer checks readiness.
  for (let attempt = 0; ; attempt++) {
    try { docker(['exec', appBefore, 'node', '-e', "fetch('http://127.0.0.1:3000/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]); break }
    catch { if (attempt >= 20) throw new Error('Fixture did not start'); await new Promise(resolve => setTimeout(resolve, 500)) }
  }
  const bin = path.join(root, 'bin')
  await mkdir(bin)
  for (const name of ['docker', 'sh', 'dirname', 'mktemp', 'rm', 'git']) {
    const executable = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim()
    await symlink(executable, path.join(bin, name))
  }
  const runSetup = () => execFileSync(path.join(bin, 'sh'), ['scripts/enable-upgrades.sh'], {
    cwd: root, env: { ...process.env, PATH: bin }, stdio: 'inherit',
  })
  runSetup()
  const state = path.join(root, '.steno-updater')
  const deployment = JSON.parse(await readFile(path.join(state, 'deployment.json'), 'utf8'))
  driver = new DockerDriver(state, deployment)
  let app = await driver.container()
  assert.equal(docker(['exec', app.Id, 'cat', '/data/archive']), 'synthetic archive')
  assert.equal(docker(['exec', app.Id, 'node', '-p', 'process.env.SECRET_KEY']), 'synthetic-$setup-secret')
  assert.equal(await readFile(path.join(state, 'env.before-upgrades'), 'utf8'), envText)
  assert.equal(JSON.parse(docker(['compose', 'config', '--format', 'json'])).name, project)

  const selected = JSON.parse(docker(['image', 'inspect', newImage]))[0].Id
  await driver.install(selected)
  await driver.verify('0.2.1')
  // Neither an ordinary restart nor repeating setup may switch to the old
  // source image still named in docker-compose.yml or the initial snapshot.
  docker(['compose', 'up', '-d'])
  runSetup()
  app = await driver.container()
  assert.equal(app.Image, selected)
  assert.equal(docker(['exec', app.Id, 'cat', '/data/archive']), 'synthetic archive')
  assert.equal(docker(['exec', app.Id, 'node', '-p', 'process.env.SECRET_KEY']), 'synthetic-$setup-secret')
  assert.equal(await readFile(path.join(state, 'env.before-upgrades'), 'utf8'), envText)
  assert.equal((await readFile(path.join(root, '.env'), 'utf8')).split('# BEGIN STENO MANAGED UPGRADES').length, 2)
  console.log('Setup smoke passed: no host Node, private socket ready, ordinary Compose routing, repeat setup, preserved archive and secret.')
} finally {
  try { docker(['compose', 'down', '-v']) } catch { /* preserve original test failure */ }
  for (const image of [oldImage, newImage, 'steno-personal-updater:local']) {
    try { docker(['image', 'rm', '-f', image]) } catch { /* preserve original test failure */ }
  }
  await rm(root, { recursive: true, force: true })
}
