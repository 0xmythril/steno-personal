import { afterEach, it, expect } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import { z } from 'zod'
import { SteleClient } from '@/lib/channels/stele-client'
import { readSteleToken } from '@/lib/channels/stele-config'
import { _resetEnvCacheForTests, envSchema } from '@/lib/env'
const original = { ...process.env }
const directories: string[] = []
const servers: Server[] = []
const websockets: WebSocketServer[] = []
afterEach(async () => {
  for (const ws of websockets.splice(0)) { for (const c of ws.clients) c.terminate(); ws.close() }
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
  process.env = { ...original }; _resetEnvCacheForTests()
})
function credentials() {
  const dir = mkdtempSync(join(tmpdir(), 'stele-client-')); directories.push(dir)
  const read = join(dir, 'read'), login = join(dir, 'login')
  writeFileSync(read, 'r'.repeat(48), { mode: 0o600 }); writeFileSync(login, 'l'.repeat(48), { mode: 0o600 })
  return { dir, read, login }
}
it('refuses public or linked credential files without disclosing their contents', () => {
  const { dir, read } = credentials()
  expect(readSteleToken(read)).toBe('r'.repeat(48))
  const link = join(dir, 'link'); symlinkSync(read, link)
  expect(() => readSteleToken(link)).toThrow('not private')
  chmodSync(read, 0o644)
  expect(() => readSteleToken(read)).toThrow('not private')
  expect(() => readSteleToken('relative')).toThrow('not private')
})
it('validates paired configuration and permits an independently configured worker', () => {
  const base = { ...original, STELE_WECHAT_URL: 'https://private.example', STELE_WECHAT_READ_TOKEN_FILE: '/run/read', STELE_WECHAT_LOGIN_TOKEN_FILE: '' }
  expect(envSchema.safeParse(base).success).toBe(true)
  expect(envSchema.safeParse({ ...base, STELE_WECHAT_READ_TOKEN_FILE: '' }).success).toBe(false)
  expect(envSchema.safeParse({ ...base, STELE_WECHAT_URL: 'http://remote.example' }).success).toBe(false)
})
it('uses distinct bearer headers for HTTP reads and QR WebSockets and stops on abort', async () => {
  const { read, login } = credentials()
  const headers: (string | undefined)[] = []
  const server = createServer((req, res) => { headers.push(req.headers.authorization); res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}') })
  servers.push(server)
  const ws = new WebSocketServer({ server }); websockets.push(ws)
  ws.on('connection', (socket, req) => { headers.push(req.headers.authorization); socket.send('{"type":"status","message":"waiting"}') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address')
  process.env.STELE_WECHAT_URL = `http://127.0.0.1:${address.port}`
  process.env.STELE_WECHAT_READ_TOKEN_FILE = read; process.env.STELE_WECHAT_LOGIN_TOKEN_FILE = login; _resetEnvCacheForTests()
  const client = new SteleClient()
  expect(await client.get('/v1/check', z.object({ ok: z.boolean() }))).toEqual({ ok: true })
  const stream = client.stream('/v1/login?mode=qr', true)
  expect((await stream.next()).value).toEqual({ type: 'status', message: 'waiting' })
  const waiting = stream.next(); client.close()
  await expect(waiting).rejects.toThrow('temporarily unavailable')
  expect(headers).toEqual([`Bearer ${'r'.repeat(48)}`, `Bearer ${'l'.repeat(48)}`])
})
