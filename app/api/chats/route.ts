import { authenticateRequest } from '@/lib/auth'
import { unauthorized, withErrorBoundary } from '@/lib/api'
import { listChats } from '@/lib/services/queries'

export const GET = withErrorBoundary(async (request: Request): Promise<Response> => {
  if (!(await authenticateRequest(request))) return unauthorized()
  return Response.json({ chats: await listChats() })
})
