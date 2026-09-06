import { describe, it, expect, beforeEach, vi } from 'vitest'
import { db } from '@/lib/db/client'
import { messages } from '@/lib/db/schema'
import { resetDb } from './helpers/db'
import { mintAccessKey, type KeyCapabilities } from '@/lib/services/access-keys'
import { FORMAT, MAX_BODY_BYTES } from '@/lib/services/import'
import { POST } from '@/app/api/import/route'
import { GET as chatsGET } from '@/app/api/chats/route'

async function key(caps: KeyCapabilities): Promise<string> {
  const r = await mintAccessKey('cron', caps)
  if (!r.ok) throw new Error(r.reason)
  return r.rawKey
}

const batch = {
  format: FORMAT,
  source: { type: 'slack', id: 'acme', label: 'Slack (Acme)' },
  messages: [{
    externalChatId: 'C01', chatKind: 'group', chatTitle: '#eng', externalMessageId: '1',
    senderExternalId: 'U01', senderName: 'Ada', fromOwner: false, sentAt: '2026-09-05T10:00:00Z', type: 'text', text: 'hello',
  }],
}

function post(body: string, rawKey?: string, extraHeaders?: Record<string, string>): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...extraHeaders }
  if (rawKey !== undefined) headers.authorization = `Bearer ${rawKey}`
  return new Request('http://localhost:3000/api/import', { method: 'POST', headers, body })
}

describe('POST /api/import', () => {
  beforeEach(resetDb)

  it('401s without a bearer token or with an unknown one', async () => {
    expect((await POST(post(JSON.stringify(batch)))).status).toBe(401)
    expect((await POST(post(JSON.stringify(batch), 'sp_nope'))).status).toBe(401)
  })

  it('401s a cookie-only request: this door takes a bearer push key, never a portal session', async () => {
    const res = await POST(post(JSON.stringify(batch), undefined, { cookie: 'sp_session=anything' }))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it('403s a read key: this door is for push keys', async () => {
    const res = await POST(post(JSON.stringify(batch), await key({ read: true, push: false })))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'push_key_required' })
  })

  it('imports a batch under a push key and reports counts', async () => {
    const raw = await key({ read: false, push: true })
    const res = await POST(post(JSON.stringify(batch), raw))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ inserted: 1, duplicates: 0, edited: 0, deleted: 0 })
    expect(typeof body.source.id).toBe('string')
    expect(await db.select().from(messages)).toHaveLength(1)
    const again = await POST(post(JSON.stringify(batch), raw))
    expect(await again.json()).toMatchObject({ inserted: 0, duplicates: 1 })
  })

  it('400s bad JSON and an invalid batch with the problem list', async () => {
    const raw = await key({ read: false, push: true })
    const bad = await POST(post('{not json', raw))
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'bad_json' })
    const invalid = await POST(post(JSON.stringify({ ...batch, format: 'steno/9' }), raw))
    expect(invalid.status).toBe(400)
    const body = await invalid.json()
    expect(body.error).toBe('invalid_batch')
    expect(body.problems[0]).toMatchObject({ path: 'format' })
    expect(await db.select().from(messages)).toHaveLength(0)
  })

  it('413s a body over the limit before parsing it', async () => {
    const raw = await key({ read: false, push: true })
    const res = await POST(post('x'.repeat(MAX_BODY_BYTES + 1), raw))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'body_too_large' })
  })

  it('records one usage event, with no content', async () => {
    const telemetry = await import('@/lib/services/telemetry')
    const spy = vi.spyOn(telemetry, 'track')
    await POST(post(JSON.stringify(batch), await key({ read: false, push: true })))
    expect(spy).toHaveBeenCalledWith('source_pushed', { surface: 'api' })
    spy.mockRestore()
  })

  it('a key with both capabilities imports and reads with the same key', async () => {
    const raw = await key({ read: true, push: true })
    const imported = await POST(post(JSON.stringify(batch), raw))
    expect(imported.status).toBe(200)
    const req = new Request('http://localhost:3000/api/chats', { headers: { authorization: `Bearer ${raw}` } })
    const read = await chatsGET(req)
    expect(read.status).toBe(200)
  })
})
