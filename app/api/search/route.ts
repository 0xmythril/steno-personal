import { authenticateRequest } from '@/lib/auth'
import { badRequest, parseLimit, unauthorized } from '@/lib/api'
import { searchMessages } from '@/lib/services/queries'

export async function GET(request: Request): Promise<Response> {
  if (!(await authenticateRequest(request))) return unauthorized()

  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q')?.trim()
  if (!q) return badRequest('missing_query')
  const limit = parseLimit(searchParams.get('limit'))
  if (!limit.ok) return badRequest(limit.error)

  return Response.json({
    results: await searchMessages(q, searchParams.get('chat_id') ?? undefined, limit.value),
  })
}
