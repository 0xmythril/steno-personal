import { authenticateRequest } from '@/lib/auth'
import { badRequest, parseLimit, unauthorized, withErrorBoundary } from '@/lib/api'
import { SEARCH_ORDERS, searchMessages, type SearchOrder } from '@/lib/services/queries'
import { track } from '@/lib/services/telemetry'

export const GET = withErrorBoundary(async (request: Request): Promise<Response> => {
  if (!(await authenticateRequest(request))) return unauthorized()

  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q')?.trim()
  if (!q) return badRequest('missing_query')
  const limit = parseLimit(searchParams.get('limit'))
  if (!limit.ok) return badRequest(limit.error)

  const orderRaw = searchParams.get('order')
  if (orderRaw !== null && !(SEARCH_ORDERS as readonly string[]).includes(orderRaw)) return badRequest('invalid_order')

  // The fact of a search, never the query.
  track('search', { surface: 'portal' })
  const { hits, nextCursor } = await searchMessages(q, {
    chatId: searchParams.get('chat_id') ?? undefined,
    limit: limit.value,
    order: (orderRaw as SearchOrder | null) ?? undefined,
    cursor: searchParams.get('cursor') ?? undefined,
  })
  return Response.json({ results: hits, nextCursor })
})
