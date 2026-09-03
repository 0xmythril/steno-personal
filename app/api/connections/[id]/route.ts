import { withErrorBoundary } from '@/lib/api'
import { requireCookieAuth } from '@/lib/auth'
import { getConnection, deleteConnection } from '@/lib/services/connections'

// The portal's connect panel polls this every two seconds while a login is in
// flight. It returns the QR token — that IS the thing the owner scans — and
// never a ciphertext column; lib/services/connections.ts is what guarantees it.
//
// Cookie-only, like every other /api/connections route, even though this one
// only reads. The QR is not archive data: it is the credential that pairs a
// device to the owner's Telegram or WhatsApp account. A read key handed to an
// agent that polled this during a login window could pair its own device —
// read AND write, outside Steno, outliving any revocation of the key. That is
// strictly larger than the blast radius a leaked access key is documented to
// have (spec §6), so the key never sees this route.
export const GET = withErrorBoundary(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const denied = await requireCookieAuth(req)
  if (denied) return denied
  const { id } = await params
  const status = await getConnection(id)
  if (!status) return Response.json({ error: 'not_found' }, { status: 404 })
  return Response.json(status)
})

// Delete everything: the connection row and, by cascade, every chat and
// message it archived.
export const DELETE = withErrorBoundary(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const denied = await requireCookieAuth(req)
  if (denied) return denied
  const { id } = await params
  const ok = await deleteConnection(id)
  if (!ok) return Response.json({ error: 'not_found' }, { status: 404 })
  return Response.json({ ok: true })
})
