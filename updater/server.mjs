import http from 'node:http'
import { readFile, mkdir, unlink, chmod } from 'node:fs/promises'
import { UpgradeEngine } from './engine.mjs'
import { DockerDriver } from './docker.mjs'
import { SidecarInstaller } from './wechat.mjs'

const directory = '/state'
const deployment = JSON.parse(await readFile(`${directory}/deployment.json`, 'utf8'))
const engine = new UpgradeEngine(directory, new DockerDriver(directory, deployment), phase => console.log(`[updater] ${phase}`))
await engine.initialize()
const installer = new SidecarInstaller(directory, engine.driver, engine, phase => console.log(`[updater] wechat ${phase}`))
await installer.initialize()
await mkdir(`${directory}/run`, { recursive: true, mode: 0o700 })
const socket = `${directory}/run/updater.sock`
try { await unlink(socket) } catch (error) { if (error.code !== 'ENOENT') throw error }

const server = http.createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  try {
    if (req.method === 'GET' && req.url === '/status') return send(200, engine.status())
    if (req.method === 'POST' && req.url === '/check') return send(200, await engine.driver.release())
    if (req.method === 'GET' && req.url === '/wechat') return send(200, installer.status())
    if (req.method === 'POST' && req.url === '/wechat/enable') return send(202, await installer.start())
    if (req.method === 'POST' && req.url === '/upgrade') {
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 1024) return send(413, { error: 'Request too large' })
      }
      const { version } = JSON.parse(body)
      await engine.start(version)
      return send(202, engine.status())
    }
    send(404, { error: 'Not found' })
  } catch { send(409, { error: 'Upgrade service could not complete the request. Check its status or try again later.' }) }
})
server.requestTimeout = 30_000
server.listen(socket, async () => { await chmod(socket, 0o600) })
