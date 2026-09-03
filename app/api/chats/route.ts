import { authenticateRequest } from '@/lib/auth'
import { unauthorized } from '@/lib/api'
import { listChats } from '@/lib/services/queries'

export async function GET(request: Request): Promise<Response> {
  if (!(await authenticateRequest(request))) return unauthorized()
  return Response.json({ chats: await listChats() })
}
