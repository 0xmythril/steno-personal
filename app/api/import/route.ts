import { withErrorBoundary } from '@/lib/api'
import { log } from '@/lib/log'
import { verifyAccessKey } from '@/lib/services/access-keys'
import { importBatch, parseBatch, MAX_BODY_BYTES } from '@/lib/services/import'
import { track } from '@/lib/services/telemetry'

// The push door. Bearer push keys only: no cookie, no read key, so a browser
// session and an agent's read key are both refused here, and lib/auth.ts is
// deliberately not imported. Nothing in a batch is ever logged — counts only.

const json = (status: number, body: unknown): Response => Response.json(body, { status })

export const POST = withErrorBoundary(async (req: Request): Promise<Response> => {
  const header = req.headers.get('authorization')
  if (!header?.startsWith('Bearer ')) return json(401, { error: 'unauthorized' })
  const token = header.slice('Bearer '.length).trim()
  const key = await verifyAccessKey(token, 'push')
  if (!key) {
    // A read key presented here is a configuration mistake worth naming;
    // anything else is just not a key.
    const asRead = await verifyAccessKey(token, 'read')
    return asRead ? json(403, { error: 'push_key_required' }) : json(401, { error: 'unauthorized' })
  }

  const declared = Number(req.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY_BYTES) return json(413, { error: 'body_too_large' })
  const text = await req.text()
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return json(413, { error: 'body_too_large' })

  let input: unknown
  try { input = JSON.parse(text) } catch { return json(400, { error: 'bad_json' }) }
  const parsed = parseBatch(input)
  if (!parsed.ok) return json(400, { error: 'invalid_batch', problems: parsed.problems })

  const result = await importBatch(key.id, parsed.batch)
  track('source_pushed', { surface: 'api' })
  log.info({ inserted: result.inserted, duplicates: result.duplicates, edited: result.edited, deleted: result.deleted }, 'import accepted')
  return json(200, result)
})
