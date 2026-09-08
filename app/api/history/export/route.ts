import { requireCookieAuth } from '@/lib/auth'
import { badRequest, withErrorBoundary } from '@/lib/api'
import { historyCsv, parseHistoryFilters } from '@/lib/services/history'
export const GET = withErrorBoundary(async (request: Request) => {
  const denied = await requireCookieAuth(request)
  if (denied) return denied
  let filters
  try { filters = parseHistoryFilters(Object.fromEntries(new URL(request.url).searchParams)) } catch { return badRequest('invalid_history_filters') }
  const rows = historyCsv(filters), encoder = new TextEncoder()
  return new Response(new ReadableStream({ pull(controller) { const next = rows.next(); if (next.done) controller.close(); else controller.enqueue(encoder.encode(next.value)) }, cancel() { rows.return() } }), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="steno-history-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'private, no-store' },
  })
})
