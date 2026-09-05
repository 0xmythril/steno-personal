import { authenticateRequest } from '@/lib/auth'
import { badRequest, unauthorized, withErrorBoundary } from '@/lib/api'
import { listChats } from '@/lib/services/queries'
import { isSourceType } from '@/lib/services/sources'

export const GET = withErrorBoundary(async (request: Request): Promise<Response> => {
  if (!(await authenticateRequest(request))) return unauthorized()
  const raw = new URL(request.url).searchParams.get('channel')
  if (raw !== null && !isSourceType(raw)) return badRequest('bad_channel')
  return Response.json({ chats: await listChats({ channel: raw ?? undefined }) })
})
