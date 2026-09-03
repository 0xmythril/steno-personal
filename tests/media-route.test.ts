import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { media, messages } from '@/lib/db/schema'
import { resetDb } from './helpers/db'
import { makeAttachment } from './helpers/media-fixtures'
import { mediaDir } from '@/lib/services/media'

// lib/auth.ts reads and writes cookies through next/headers, which only
// exists inside a request scope. One in-memory jar stands in for it — the
// same convention as tests/api-routes.test.ts — so the real
// authenticateRequest runs end to end (bearer AND cookie branches) rather
// than being stubbed out with a fake @/lib/auth module.
const jar = new Map<string, string>()
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value) },
    delete: (opts: { name: string }) => { jar.delete(opts.name) },
  }),
  headers: async () => new Headers(),
}))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => { throw new Error(`redirect:${url}`) },
}))

import { mintAccessKey } from '@/lib/services/access-keys'
import { startSession } from '@/lib/auth'
import { GET } from '@/app/media/[id]/route'

async function key(label = 'agent') {
  const r = await mintAccessKey(label)
  if (!r.ok) throw new Error(r.reason)
  return r
}

async function onDisk(opts: { mimeType: string; body?: string; type?: 'image' | 'audio' | 'document' }) {
  const fixture = await makeAttachment({ type: opts.type ?? 'image', mimeType: opts.mimeType, status: 'done' })
  const storagePath = `${fixture.media.id}.bin`
  mkdirSync(mediaDir(), { recursive: true })
  writeFileSync(`${mediaDir()}/${storagePath}`, opts.body ?? 'bytes')
  await db.update(media).set({ storagePath }).where(eq(media.id, fixture.media.id))
  return fixture
}

// A fresh real bearer key, wired into a real Authorization header — the
// credential this route actually authenticates, not a mocked stand-in.
async function bearerReq(): Promise<Request> {
  const k = await key()
  return new Request('http://localhost/media/x', { headers: { authorization: `Bearer ${k.rawKey}` } })
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })
const anon = () => new Request('http://localhost/media/x')

describe('GET /media/[id]', () => {
  beforeEach(async () => {
    jar.clear()
    await resetDb()
  })

  describe('authentication', () => {
    it('serves a request carrying a real bearer access key', async () => {
      const { media: md } = await onDisk({ mimeType: 'image/jpeg' })
      const res = await GET(await bearerReq(), params(md.id))
      expect(res.status).toBe(200)
    })

    it('serves a request carrying a real portal cookie session', async () => {
      const { media: md } = await onDisk({ mimeType: 'image/jpeg' })
      const k = await key()
      await startSession(k.id) // writes sp_session into the mocked cookie jar
      const res = await GET(new Request('http://localhost/media/x'), params(md.id))
      expect(res.status).toBe(200)
    })

    it('refuses a request with neither a cookie session nor a bearer key', async () => {
      const { media: md } = await onDisk({ mimeType: 'image/jpeg' })
      const res = await GET(anon(), params(md.id))
      expect(res.status).toBe(401)
    })
  })

  it('serves an image inline with its own content type', async () => {
    const { media: md } = await onDisk({ mimeType: 'image/jpeg', body: 'jpeg-bytes' })
    const res = await GET(await bearerReq(), params(md.id))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('content-disposition')).toBe('inline')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await res.text()).toBe('jpeg-bytes')
  })

  it('serves audio inline, parameters stripped from the mime', async () => {
    const { media: md } = await onDisk({ type: 'audio', mimeType: 'audio/ogg; codecs=opus' })
    const res = await GET(await bearerReq(), params(md.id))
    expect(res.headers.get('content-type')).toBe('audio/ogg')
    expect(res.headers.get('content-disposition')).toBe('inline')
  })

  it('forces anything else to download as an opaque stream', async () => {
    // A sender-claimed text/html served inline would be stored XSS on the
    // portal's own origin.
    const { media: md } = await onDisk({ type: 'document', mimeType: 'text/html' })
    const res = await GET(await bearerReq(), params(md.id))
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/)
  })

  it('forces a PDF to download as an opaque stream rather than rendering inline', async () => {
    // A PDF opened inline still executes as the portal's own origin (embedded
    // JS, forms that phone home); it is never in the inline allowlist.
    const { media: md } = await onDisk({ type: 'document', mimeType: 'application/pdf' })
    const res = await GET(await bearerReq(), params(md.id))
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/)
  })

  it('404s for an unknown id, a pending row, and a file that is gone', async () => {
    expect((await GET(await bearerReq(), params('nope'))).status).toBe(404)

    const pending = await makeAttachment({ mimeType: 'image/jpeg' })
    expect((await GET(await bearerReq(), params(pending.media.id))).status).toBe(404)

    const ghost = await makeAttachment({ mimeType: 'image/jpeg', status: 'done', storagePath: 'missing.jpg' })
    expect((await GET(await bearerReq(), params(ghost.media.id))).status).toBe(404)
  })

  it('never serves the attachment of a deleted message', async () => {
    const { media: md, message } = await onDisk({ mimeType: 'image/jpeg' })
    await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, message.id))
    expect((await GET(await bearerReq(), params(md.id))).status).toBe(404)
  })
})
