import { authenticateRequest } from '@/lib/auth'
import { badRequest, unauthorized, withErrorBoundary } from '@/lib/api'
import { listChats, CHAT_CHANNELS, type ChatChannel } from '@/lib/services/queries'

export const GET = withErrorBoundary(async (request: Request): Promise<Response> => {
  if (!(await authenticateRequest(request))) return unauthorized()
  const raw = new URL(request.url).searchParams.get('channel')
  if (raw !== null && !(CHAT_CHANNELS as readonly string[]).includes(raw)) return badRequest('bad_channel')
  return Response.json({ chats: await listChats({ channel: (raw as ChatChannel | null) ?? undefined }) })
})
