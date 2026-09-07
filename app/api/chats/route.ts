import { authenticateRequest } from '@/lib/auth'
import { badRequest, unauthorized, withErrorBoundary } from '@/lib/api'
import { listChats } from '@/lib/services/queries'
import { isSourceType } from '@/lib/services/sources'

export const GET = withErrorBoundary(async (request: Request): Promise<Response> => {
  if (!(await authenticateRequest(request))) return unauthorized()
  const { searchParams } = new URL(request.url)
  const raw = searchParams.get('channel')
  if (raw !== null && !isSourceType(raw)) return badRequest('bad_channel')
  // source scopes to one connection — a live channel or a pushed source —
  // the same connectionId every chat already carries; channel scopes to a
  // whole source *type* instead. The two are independent and both optional.
  const sourceId = searchParams.get('source') ?? undefined
  return Response.json({ chats: await listChats({ channel: raw ?? undefined, sourceId }) })
})
