import { existsSync, readFileSync, statSync } from 'node:fs'
import { withErrorBoundary } from '@/lib/api'
import { authenticateRequest } from '@/lib/auth'
import { MAX_MEDIA_BYTES, extForMime, getServableMedia, mediaFilePath } from '@/lib/services/media'

// The mime is sender-claimed, so it is attacker-controlled: serving e.g.
// text/html inline would be stored XSS on the portal's own origin. Only the
// types the drain actually stores may render inline; everything else is forced
// to download as an opaque octet-stream.
const INLINE_SAFE = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav',
])

// Cookie OR bearer: the portal renders these in a transcript, and an agent
// that read a mediaUrl over MCP fetches it with the same access key.
export const GET = withErrorBoundary(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  if (!(await authenticateRequest(req))) {
    return new Response('unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } })
  }
  const { id } = await params
  const row = await getServableMedia(id)
  if (!row) return new Response('not found', { status: 404 })
  const file = mediaFilePath(row.storagePath)
  if (!existsSync(file)) return new Response('not found', { status: 404 })
  // The drain refuses to store anything over the cap, so this only guards a
  // file tampered with on the volume — never read one into memory unbounded.
  if (statSync(file).size > MAX_MEDIA_BYTES) return new Response('media too large', { status: 413 })

  const bytes = readFileSync(file)
  const mime = (row.mimeType ?? '').split(';')[0].trim().toLowerCase()
  const inline = INLINE_SAFE.has(mime)
  return new Response(bytes, {
    headers: {
      'Content-Type': inline ? mime : 'application/octet-stream',
      'Content-Disposition': inline ? 'inline' : `attachment; filename="${id}.${extForMime(mime)}"`,
      'Content-Length': String(bytes.length),
      'X-Content-Type-Options': 'nosniff',
      // Private, and not stored: once a message is tombstoned this route 404s,
      // and a cached copy in the browser would outlive that by up to the
      // max-age. These are single-user, same-session fetches, so re-fetching
      // costs nothing worth trading invariant 4 for.
      'Cache-Control': 'private, no-store',
    },
  })
})
