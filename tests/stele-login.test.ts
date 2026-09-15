import { beforeEach, afterEach, it, expect, vi } from 'vitest'
const jar = new Map<string, string>()
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => jar.has(name) ? { value: jar.get(name) } : undefined, set: (name: string, value: string) => jar.set(name, value) }),
  headers: async () => new Headers(),
}))
import { db } from '@/lib/db/client'
import { connections } from '@/lib/db/schema'
import { _resetEnvCacheForTests } from '@/lib/env'
import { startSession } from '@/lib/auth'
import { mintAccessKey, revokeAccessKey } from '@/lib/services/access-keys'
import { steleState, commitSteleChanges } from '@/lib/services/stele'
import { knownAccountChannels, startRecovery } from '@/lib/services/recovery'
import { SteleClient } from '@/lib/channels/stele-client'
import { POST } from '@/app/api/stele/wechat/login/route'
import { GET } from '@/app/api/stele/wechat/status/route'
import { resetDb } from './helpers/db'
const original = { ...process.env }
beforeEach(async () => {
  await resetDb(); jar.clear()
  process.env.STELE_WECHAT_URL = 'https://private.example'; process.env.STELE_WECHAT_READ_TOKEN_FILE = '/private/read'; process.env.STELE_WECHAT_LOGIN_TOKEN_FILE = '/private/login'; _resetEnvCacheForTests()
})
afterEach(() => { vi.restoreAllMocks(); process.env = { ...original }; _resetEnvCacheForTests() })
async function signedIn() { const k = await mintAccessKey('owner'); if (!k.ok) throw new Error(k.reason); await startSession({ keyId: k.id }); return k }
const req = (headers: Record<string, string> = { origin: 'http://localhost:3000' }) => new Request('http://localhost:3000/api/stele/wechat/login', { method: 'POST', headers })
const success = { type: 'login_success', sourceId: 'private-source', account: { externalAccountId: 'private-account', displayName: 'Owner' } }
it('requires an owner cookie and same-origin POST before opening the upstream', async () => {
  const stream = vi.spyOn(SteleClient.prototype, 'stream')
  expect((await POST(req())).status).toBe(401)
  const k = await signedIn()
  expect((await POST(req({ authorization: `Bearer ${k.rawKey}` }))).status).toBe(403)
  expect((await POST(req({ origin: 'https://other.example' }))).status).toBe(403)
  expect((await POST(req({}))).status).toBe(403)
  expect(stream).not.toHaveBeenCalled()
  expect((await GET(req({ authorization: `Bearer ${k.rawKey}` }))).status).toBe(403)
})
it('streams ephemeral QR, strips raw payloads and account identifiers, and preserves reconnect cursor', async () => {
  await signedIn()
  vi.spyOn(SteleClient.prototype, 'stream').mockImplementation(async function* () {
    yield { type: 'qr', qrDataUrl: 'data:image/png;base64,YWJj', qrData: 'raw-private-qr', expiresAt: new Date(Date.now() + 60_000).toISOString() }
    yield success
  })
  const response = await POST(req())
  expect(response.status, await response.clone().text()).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const text = await response.text()
  expect(text).toContain('data:image/png;base64,YWJj')
  for (const secret of ['raw-private-qr', 'private-source', 'private-account', 'private.example']) expect(text).not.toContain(secret)
  const row = db.select().from(connections).get()!
  expect(JSON.stringify(row)).not.toContain('YWJj')
  expect(row.status).toBe('active')
  commitSteleChanges(row.id, steleState(row.id), [], 'saved')
  await (await POST(req())).text()
  expect(steleState(row.id).cursor).toBe('saved')
  expect(await knownAccountChannels()).toEqual([])
  expect(await startRecovery('wechat')).toEqual({ ok: false, reason: 'no_known_account' })
})
it('does not complete login after owner access is revoked mid-stream', async () => {
  const k = await signedIn()
  vi.spyOn(SteleClient.prototype, 'stream').mockImplementation(async function* () {
    await revokeAccessKey(k.id)
    yield success
  })
  const text = await (await POST(req())).text()
  expect(text).not.toContain('login_success')
  expect(db.select().from(connections).get()?.status).toBe('pending')
})
