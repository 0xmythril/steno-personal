import { z } from 'zod'
import { authenticateRequest } from '@/lib/auth'
import { createConnection } from '@/lib/services/connections'

const bodySchema = z.object({ channel: z.enum(['telegram', 'whatsapp']) })

export async function POST(req: Request) {
  if (!(await authenticateRequest(req))) return Response.json({ error: 'unauthorized' }, { status: 401 })
  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'invalid_body' }, { status: 400 })
  const res = await createConnection(parsed.data.channel)
  if (!res.ok) return Response.json({ error: res.reason }, { status: 409 })
  return Response.json({ id: res.id }, { status: 201 })
}
