import { withErrorBoundary } from '@/lib/api'
import { isFreshInstance, setChallengeCookie } from '@/lib/auth'
import { countActivePasskeys } from '@/lib/services/passkeys'
import { authenticationOptions, relyingParty } from '@/lib/services/webauthn'

// Unauthenticated by definition, like /login. Closed while there is nothing
// to log in with: a fresh instance has /setup, and an instance with no
// passkey has only keys. The 404 tells a stranger nothing they could not
// learn from the login page, which shows the button on the same condition.
const handlePost = withErrorBoundary(async (req: Request): Promise<Response> => {
  if ((await isFreshInstance()) || (await countActivePasskeys()) === 0) {
    return Response.json({ error: 'no_passkeys' }, { status: 404 })
  }
  const options = await authenticationOptions(relyingParty(req.headers))
  await setChallengeCookie(options.challenge, 'login')
  return Response.json(options)
})

export async function POST(request: Request): Promise<Response> {
  return handlePost(request)
}
