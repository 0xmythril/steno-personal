import { authenticateRequest } from '@/lib/auth'
import { unauthorized, withErrorBoundary } from '@/lib/api'
import { publicPeople } from '@/lib/services/people'

// The REST twin of the `list_people` MCP tool, and deliberately the same
// mapping: publicPeople() drops the phone number and the channel identifier,
// so an access key cannot learn through this route what the tool refuses to
// tell it. Cookie or bearer, like the other read routes.
export const GET = withErrorBoundary(async (request: Request): Promise<Response> => {
  if (!(await authenticateRequest(request))) return unauthorized()
  const sp = new URL(request.url).searchParams
  const limitRaw = sp.get('limit')
  const limit = limitRaw !== null && /^\d+$/.test(limitRaw) ? Number(limitRaw) : undefined
  return Response.json(await publicPeople({
    q: sp.get('q') ?? undefined,
    limit,
    cursor: sp.get('cursor') ?? undefined,
    includeChats: sp.get('include_chats') === '1' || sp.get('include_chats') === 'true',
  }))
})
