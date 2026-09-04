import { withErrorBoundary } from '@/lib/api'
import { requireCookieAuth, setChallengeCookie } from '@/lib/auth'
import { listActiveCredentials } from '@/lib/services/passkeys'
import { registrationOptions, relyingParty } from '@/lib/services/webauthn'

// Step one of enrolling a passkey. Cookie session only: a bearer key is
// what an agent holds, and a leaked agent key must not be able to mint
// itself a portal login (lib/auth.ts#requireCookieAuth). The options carry
// the challenge because the browser has to sign it; the httpOnly cookie is
// what binds that challenge to this browser.
const handlePost = withErrorBoundary(async (req: Request): Promise<Response> => {
  const denied = await requireCookieAuth(req)
  if (denied) return denied
  const options = await registrationOptions(relyingParty(req.headers), await listActiveCredentials())
  await setChallengeCookie(options.challenge, 'register')
  return Response.json(options)
})

export async function POST(request: Request): Promise<Response> {
  return handlePost(request)
}
