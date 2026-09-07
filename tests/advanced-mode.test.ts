import { beforeEach, expect, it, vi } from 'vitest'

const jar = new Map<string, string>()
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => jar.has(name) ? { name, value: jar.get(name)! } : undefined,
    set: (name: string, value: string) => { jar.set(name, value) },
    delete: (opts: { name: string }) => { jar.delete(opts.name) },
  }),
  headers: async () => new Headers(),
}))
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`) } }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { resetDb } from './helpers/db'
import { startSession } from '@/lib/auth'
import { mintAccessKey, verifyAccessKey } from '@/lib/services/access-keys'
import { getSettings } from '@/lib/services/settings'
import { setAdvancedModeAction } from '@/app/settings/actions'
import { POST as importRoute } from '@/app/api/import/route'
import { searchMessages } from '@/lib/services/queries'

beforeEach(async () => { jar.clear(); await resetDb() })

it('requires a portal session to change Advanced mode', async () => {
  await mintAccessKey('owner')
  await expect(setAdvancedModeAction(true)).rejects.toThrow('redirect:/login')
  expect((await getSettings()).advancedMode).toBe(false)
})

it('persists the preference without revoking keys or stopping imports', async () => {
  const owner = await mintAccessKey('owner')
  const pusher = await mintAccessKey('pusher', { read: false, push: true })
  if (!owner.ok || !pusher.ok) throw new Error('key creation failed')
  await startSession({ keyId: owner.id })
  await setAdvancedModeAction(true)
  expect((await getSettings()).advancedMode).toBe(true)
  await setAdvancedModeAction(false)
  expect((await getSettings()).advancedMode).toBe(false)
  expect(await verifyAccessKey(pusher.rawKey, 'push')).toMatchObject({ id: pusher.id, canPush: true })
  const response = await importRoute(new Request('http://localhost/api/import', {
    method: 'POST', headers: { authorization: `Bearer ${pusher.rawKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ format: 'steno/1', source: { type: 'slack', id: 'test', label: 'Test' }, messages: [
      { externalChatId: 'chat', externalMessageId: 'one', chatKind: 'dm', text: 'searchable conversation', sentAt: '2026-09-07T12:00:00Z' },
    ] }),
  }))
  expect(response.status).toBe(200)
  expect((await searchMessages('searchable')).hits).toHaveLength(1)
  expect(await verifyAccessKey(pusher.rawKey, 'read')).toBeNull()
  expect(await verifyAccessKey(owner.rawKey, 'read')).toMatchObject({ id: owner.id, canRead: true })
})

it('rejects malformed action arguments without enabling Advanced mode', async () => {
  const owner = await mintAccessKey('owner')
  if (!owner.ok) throw new Error('key creation failed')
  await startSession({ keyId: owner.id })
  await expect(setAdvancedModeAction('false' as unknown as boolean)).rejects.toThrow('Invalid advanced mode setting')
  expect((await getSettings()).advancedMode).toBe(false)
})
