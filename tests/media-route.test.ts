import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { media, messages } from '@/lib/db/schema'
import { resetDb } from './helpers/db'
import { makeAttachment } from './helpers/media-fixtures'
import { mediaDir } from '@/lib/services/media'
import { GET } from '@/app/media/[id]/route'

// The route's own auth is exercised end to end by the structural test and by
// the portal; here it is stubbed so each case is about what gets served.
vi.mock('@/lib/auth', () => ({
  authenticateRequest: vi.fn(async (req: Request) =>
    req.headers.get('authorization') ? { via: 'bearer', keyId: 'k1' } : null),
}))

async function onDisk(opts: { mimeType: string; body?: string; type?: 'image' | 'audio' | 'document' }) {
  const fixture = await makeAttachment({ type: opts.type ?? 'image', mimeType: opts.mimeType, status: 'done' })
  const storagePath = `${fixture.media.id}.bin`
  mkdirSync(mediaDir(), { recursive: true })
  writeFileSync(`${mediaDir()}/${storagePath}`, opts.body ?? 'bytes')
  await db.update(media).set({ storagePath }).where(eq(media.id, fixture.media.id))
  return fixture
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })
const authed = new Request('http://localhost/media/x', { headers: { authorization: 'Bearer sp_test' } })
const anon = new Request('http://localhost/media/x')

describe('GET /media/[id]', () => {
  beforeEach(resetDb)
  afterEach(() => { vi.clearAllMocks() })

  it('refuses an unauthenticated request', async () => {
    const { media: md } = await onDisk({ mimeType: 'image/jpeg' })
    const res = await GET(anon, params(md.id))
    expect(res.status).toBe(401)
  })

  it('serves an image inline with its own content type', async () => {
    const { media: md } = await onDisk({ mimeType: 'image/jpeg', body: 'jpeg-bytes' })
    const res = await GET(authed, params(md.id))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('content-disposition')).toBe('inline')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await res.text()).toBe('jpeg-bytes')
  })

  it('serves audio inline, parameters stripped from the mime', async () => {
    const { media: md } = await onDisk({ type: 'audio', mimeType: 'audio/ogg; codecs=opus' })
    const res = await GET(authed, params(md.id))
    expect(res.headers.get('content-type')).toBe('audio/ogg')
    expect(res.headers.get('content-disposition')).toBe('inline')
  })

  it('forces anything else to download as an opaque stream', async () => {
    // A sender-claimed text/html served inline would be stored XSS on the
    // portal's own origin.
    const { media: md } = await onDisk({ type: 'document', mimeType: 'text/html' })
    const res = await GET(authed, params(md.id))
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/)
  })

  it('404s for an unknown id, a pending row, and a file that is gone', async () => {
    expect((await GET(authed, params('nope'))).status).toBe(404)

    const pending = await makeAttachment({ mimeType: 'image/jpeg' })
    expect((await GET(authed, params(pending.media.id))).status).toBe(404)

    const ghost = await makeAttachment({ mimeType: 'image/jpeg', status: 'done', storagePath: 'missing.jpg' })
    expect((await GET(authed, params(ghost.media.id))).status).toBe(404)
  })

  it('never serves the attachment of a deleted message', async () => {
    const { media: md, message } = await onDisk({ mimeType: 'image/jpeg' })
    await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, message.id))
    expect((await GET(authed, params(md.id))).status).toBe(404)
  })
})
