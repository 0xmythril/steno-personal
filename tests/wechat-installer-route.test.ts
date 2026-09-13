import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const jar = new Map<string, string>()
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => jar.has(name) ? { name, value: jar.get(name)! } : undefined,
    set: (name: string, value: string) => { jar.set(name, value) },
    delete: (options: { name: string }) => { jar.delete(options.name) },
  }),
  headers: async () => new Headers(),
}))
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`) } }))

import { resetDb } from './helpers/db'
import { mintAccessKey } from '@/lib/services/access-keys'
import { startSession } from '@/lib/auth'
import { _resetEnvCacheForTests } from '@/lib/env'
import { GET } from '@/app/api/stele/wechat/status/route'
import { enableWechatAction } from '@/app/connections/actions'

// The WeChat card with no Stele configured: whether it can offer a button
// depends on the companion, and only a portal session may press it.
let server: http.Server | undefined
let operations: string[]
const original = { ...process.env }

beforeEach(async () => {
  jar.clear(); operations = []
  await resetDb()
  for (const key of ['STENO_UPDATER_SOCKET', 'STELE_WECHAT_URL', 'STELE_WECHAT_READ_TOKEN_FILE', 'STELE_WECHAT_LOGIN_TOKEN_FILE']) delete process.env[key]
  _resetEnvCacheForTests()
})
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()))
  server = undefined
  process.env = { ...original }
  _resetEnvCacheForTests()
})

async function owner() {
  const key = await mintAccessKey('wechat-test')
  if (!key.ok) throw new Error(key.reason)
  await startSession({ keyId: key.id })
}

async function companion(phase = 'idle') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'steno-ipc-'))
  process.env.STENO_UPDATER_SOCKET = path.join(dir, 'updater.sock')
  _resetEnvCacheForTests()
  server = http.createServer(async (req, res) => {
    operations.push(`${req.method} ${req.url}`)
    for await (const _chunk of req) { /* drain */ }
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/wechat/enable') res.end(JSON.stringify({ phase: 'building' }))
    else res.end(JSON.stringify({ phase, error: phase === 'failed' ? 'build' : undefined }))
  })
  await new Promise<void>(resolve => server!.listen(process.env.STENO_UPDATER_SOCKET, resolve))
}

const status = () => GET(new Request('http://localhost:3000/api/stele/wechat/status'))

describe('the WeChat card before Stele is configured', () => {
  it('says the companion can install when there is one, and what state it is in', async () => {
    await companion('failed'); await owner()
    expect(await (await status()).json()).toEqual({ configured: false, installer: { available: true, phase: 'failed', error: 'build' } })
    expect(operations).toEqual(['GET /wechat'])
  })

  it('offers no button without a companion, or when the companion does not answer', async () => {
    await owner()
    expect(await (await status()).json()).toEqual({ configured: false, installer: { available: false } })
    process.env.STENO_UPDATER_SOCKET = '/nonexistent/updater.sock'; _resetEnvCacheForTests()
    expect(await (await status()).json()).toEqual({ configured: false, installer: { available: false, unreachable: true } })
  })

  it('needs a portal session before the companion hears anything', async () => {
    await companion()
    expect((await status()).status).toBe(401)
    await expect(enableWechatAction()).rejects.toThrow()
    expect(operations).toEqual([])
    await owner()
    expect(await enableWechatAction()).toEqual({ status: { phase: 'building' } })
    expect(operations).toEqual(['POST /wechat/enable'])
  })
})
