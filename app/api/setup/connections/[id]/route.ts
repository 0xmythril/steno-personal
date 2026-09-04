import { withErrorBoundary } from '@/lib/api'
import { currentSetupAttempt, isFreshInstance } from '@/lib/auth'
import { getConnection } from '@/lib/services/connections'

export const dynamic = 'force-dynamic'

// The setup page's poll. Same payload as /api/connections/[id] — the QR is
// the thing the first visitor scans — but gated on the instance being fresh
// and on the setup cookie (the pairing this browser started) rather than on
// a session nobody can have yet. Once any key exists this answers 404 to
// everyone, and the pairing QR is back behind the session.
export const GET = withErrorBoundary(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  if (!(await isFreshInstance())) return Response.json({ error: 'not_found' }, { status: 404 })
  const { id } = await params
  if ((await currentSetupAttempt()) !== id) return Response.json({ error: 'not_found' }, { status: 404 })
  const status = await getConnection(id)
  if (!status || status.purpose !== 'archive') return Response.json({ error: 'not_found' }, { status: 404 })
  return Response.json(status)
})
