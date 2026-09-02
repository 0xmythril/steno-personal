import { authenticateRequest } from '@/lib/auth'
import { revokeConnection } from '@/lib/services/connections'

// Disconnect: end the session, keep the archive. The worker notices the row
// leaving the active set on its next tick and logs the channel session out.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await authenticateRequest(req))) return Response.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params
  const ok = await revokeConnection(id, 'You disconnected this account.')
  if (!ok) return Response.json({ error: 'not_found' }, { status: 404 })
  return Response.json({ ok: true })
}
