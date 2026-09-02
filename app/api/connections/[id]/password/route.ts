import { z } from 'zod'
import { authenticateRequest } from '@/lib/auth'
import { submitLoginPassword } from '@/lib/services/connections'

const bodySchema = z.object({ password: z.string().min(1).max(512) })

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await authenticateRequest(req))) return Response.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params
  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'invalid_body' }, { status: 400 })
  // The password is encrypted at rest for the worker to consume exactly once.
  // It is never echoed back, never logged, and never put in a URL.
  const ok = await submitLoginPassword(id, parsed.data.password)
  if (!ok) return Response.json({ error: 'not_pending' }, { status: 409 })
  return Response.json({ ok: true })
}
