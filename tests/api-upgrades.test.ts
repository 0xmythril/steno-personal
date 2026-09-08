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
import { GET } from '@/app/api/upgrades/route'
import { checkUpdateAction, startUpgradeAction } from '@/app/settings/updates/actions'

let server: http.Server | undefined
let operations: string[]

beforeEach(async () => {
  jar.clear(); operations = []
  await resetDb()
  delete process.env.STENO_UPDATER_SOCKET
  _resetEnvCacheForTests()
})
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()))
  server = undefined
  delete process.env.STENO_UPDATER_SOCKET
  _resetEnvCacheForTests()
})

async function owner() {
  const key = await mintAccessKey('upgrade-test')
  if (!key.ok) throw new Error(key.reason)
  await startSession({ keyId: key.id })
  return key.rawKey
}

async function companion() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'steno-ipc-'))
  process.env.STENO_UPDATER_SOCKET = path.join(dir, 'updater.sock')
  _resetEnvCacheForTests()
  server = http.createServer(async (req, res) => {
    operations.push(`${req.method} ${req.url}`)
    let body = ''
    for await (const chunk of req) body += chunk
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/check') res.end(JSON.stringify({ version: '0.2.0', url: 'https://github.com/0xmythril/steno-personal/releases/tag/v0.2.0' }))
    else if (req.url === '/upgrade') res.end(JSON.stringify({ phase: 'preparing', version: JSON.parse(body).version }))
    else res.end(JSON.stringify({ phase: 'idle' }))
  })
  await new Promise<void>(resolve => server!.listen(process.env.STENO_UPDATER_SOCKET, resolve))
}

describe('portal upgrade authority', () => {
  it('rejects unauthenticated requests and actions before contacting the companion', async () => {
    await companion()
    expect((await GET(new Request('http://localhost/api/upgrades'))).status).toBe(401)
    await expect(checkUpdateAction()).rejects.toThrow('redirect:')
    await expect(startUpgradeAction('0.2.0')).rejects.toThrow('redirect:')
    expect(operations).toEqual([])
  })

  it('does not accept agent bearer keys as portal upgrade credentials', async () => {
    const raw = await owner()
    jar.clear()
    await companion()
    expect((await GET(new Request('http://localhost/api/upgrades', { headers: { Authorization: `Bearer ${raw}` } }))).status).toBe(403)
    await expect(startUpgradeAction('0.2.0')).rejects.toThrow('redirect:')
    expect(operations).toEqual([])
  })

  it('reports unconfigured on a normal deployment without any external call', async () => {
    await owner()
    expect(await (await GET(new Request('http://localhost/api/upgrades'))).json()).toEqual({ phase: 'unconfigured' })
    expect(await checkUpdateAction()).toHaveProperty('error')
  })

  it('passes only explicit owner requests through the private socket', async () => {
    await owner(); await companion()
    expect((await GET(new Request('http://localhost/api/upgrades'))).status).toBe(200)
    expect(operations).toEqual(['GET /status'])
    expect(await checkUpdateAction()).toHaveProperty('release.version', '0.2.0')
    expect(await startUpgradeAction('evil/image:tag')).toHaveProperty('error')
    expect(await startUpgradeAction('0.2.0')).toHaveProperty('status.phase', 'preparing')
    expect(operations).toEqual(['GET /status', 'POST /check', 'POST /upgrade'])
  })
})
