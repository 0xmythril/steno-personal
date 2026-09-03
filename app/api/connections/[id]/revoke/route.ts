import { withErrorBoundary } from '@/lib/api'
import { requireCookieAuth } from '@/lib/auth'
import { revokeConnection } from '@/lib/services/connections'

// Disconnect: end the session, keep the archive. The worker notices the row
// leaving the active set on its next tick and logs the channel session out.
export const POST = withErrorBoundary(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const denied = await requireCookieAuth(req)
  if (denied) return denied
  const { id } = await params
  const ok = await revokeConnection(id, 'You disconnected this account.')
  if (!ok) return Response.json({ error: 'not_found' }, { status: 404 })
  return Response.json({ ok: true })
})
