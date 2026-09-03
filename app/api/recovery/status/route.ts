import { withErrorBoundary } from '@/lib/api'
import { currentRecoveryAttempt } from '@/lib/auth'
import { getRecoveryAttempt } from '@/lib/services/recovery'

export const dynamic = 'force-dynamic'

// The recovery page's poll. Scoped by the httpOnly recovery cookie, never by
// an id in the URL: only the browser that started the attempt can read its
// QR, and nobody else learns it exists. Serves the same login block the
// connections status does, plus the verdict; never a ciphertext.
export const GET = withErrorBoundary(async (): Promise<Response> => {
  const id = await currentRecoveryAttempt()
  const attempt = id ? await getRecoveryAttempt(id) : null
  if (!attempt) return Response.json({ error: 'not_found' }, { status: 404 })
  return Response.json(attempt)
})
