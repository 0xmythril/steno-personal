import { authenticateRequest } from '@/lib/auth'
import { badRequest, notFound, parseDate, parseLimit, unauthorized } from '@/lib/api'
import { getMessages } from '@/lib/services/queries'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!(await authenticateRequest(request))) return unauthorized()

  const { searchParams } = new URL(request.url)
  const limit = parseLimit(searchParams.get('limit'))
  if (!limit.ok) return badRequest(limit.error)
  const before = parseDate(searchParams.get('before'), 'before')
  if (!before.ok) return badRequest(before.error)
  const after = parseDate(searchParams.get('after'), 'after')
  if (!after.ok) return badRequest(after.error)

  const { id } = await params
  const out = await getMessages(id, {
    cursor: searchParams.get('cursor') ?? undefined,
    limit: limit.value,
    before: before.value,
    after: after.value,
  })
  return out ? Response.json(out) : notFound()
}
