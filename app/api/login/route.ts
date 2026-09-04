import { z } from 'zod'
import { withErrorBoundary } from '@/lib/api'
import { verifyAccessKey } from '@/lib/services/access-keys'
import { startSession } from '@/lib/auth'
import { log } from '@/lib/log'

// The scriptable twin of the /login server action: same credential, same
// session cookie (set by startSession, same attributes either way), no
// build-generated server-action id to scrape. scripts/smoke.sh uses it as
// the release gate, and it is a reasonable way to log a headless browser or
// a test harness in. It is unauthenticated by definition, exactly as /login
// is, and un-rate-limited for the same reason (see docs/threat-model.md):
// 256 bits of key entropy is the control.

const bodySchema = z.object({ key: z.string().min(1).max(200) })

const handlePost = withErrorBoundary(async (req: Request): Promise<Response> => {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'bad_request' }, { status: 400 })

  const verified = await verifyAccessKey(parsed.data.key.trim())
  if (!verified) {
    log.warn('api login rejected') // no key, no prefix, no address: the shape only
    return Response.json({ error: 'invalid_key' }, { status: 401 })
  }

  await startSession({ keyId: verified.id })
  log.info('api login accepted')
  return new Response(null, { status: 204 })
})

// Declared as a named function (rather than `export const POST =
// withErrorBoundary(...)`, as the other mutating routes do) so a script
// reading this file's shape sees an ordinary POST handler; withErrorBoundary
// still wraps the body so an unexpected throw (e.g. a DB error) returns the
// documented JSON error shape instead of Next's default HTML 500.
export async function POST(request: Request): Promise<Response> {
  return handlePost(request)
}
