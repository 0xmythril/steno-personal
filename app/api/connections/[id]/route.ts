import { authenticateRequest, requireCookieAuth } from '@/lib/auth'
import { getConnection, deleteConnection } from '@/lib/services/connections'

// The portal's connect panel polls this every two seconds while a login is in
// flight. It returns the QR token — that IS the thing the owner scans — and
// never a ciphertext column; lib/services/connections.ts is what guarantees it.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await authenticateRequest(req))) return Response.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params
  const status = await getConnection(id)
  if (!status) return Response.json({ error: 'not_found' }, { status: 404 })
  return Response.json(status)
}

// Delete everything: the connection row and, by cascade, every chat and
// message it archived.
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireCookieAuth(req)
  if (denied) return denied
  const { id } = await params
  const ok = await deleteConnection(id)
  if (!ok) return Response.json({ error: 'not_found' }, { status: 404 })
  return Response.json({ ok: true })
}
