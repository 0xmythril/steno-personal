import { z } from 'zod'
import { requireCookieAuth } from '@/lib/auth'
import { createConnection } from '@/lib/services/connections'

const bodySchema = z.object({ channel: z.enum(['telegram', 'whatsapp']) })

export async function POST(req: Request) {
  const denied = await requireCookieAuth(req)
  if (denied) return denied
  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'invalid_body' }, { status: 400 })
  const res = await createConnection(parsed.data.channel)
  if (!res.ok) return Response.json({ error: res.reason }, { status: 409 })
  return Response.json({ id: res.id }, { status: 201 })
}
