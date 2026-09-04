import { z } from 'zod'
import { badRequest, withErrorBoundary } from '@/lib/api'
import { startSession, takeChallengeCookie } from '@/lib/auth'
import { findActivePasskeyByCredentialId, recordPasskeyUse } from '@/lib/services/passkeys'
import { relyingParty, verifyAuthentication, type AuthenticationResponseJSON } from '@/lib/services/webauthn'
import { log } from '@/lib/log'

// The passkey twin of POST /api/login: same session cookie, same 204, no
// body. Every failure is the same 401 — a stranger learns nothing about
// which credentials exist — and the log line is the shape only. Like /login
// it is unauthenticated and un-rate-limited: there is no secret to guess,
// only a signature over a challenge this browser was handed.
const bodySchema = z.object({
  response: z.looseObject({
    id: z.string().min(1),
    rawId: z.string().min(1),
    type: z.literal('public-key'),
    response: z.looseObject({
      clientDataJSON: z.string().min(1),
      authenticatorData: z.string().min(1),
      signature: z.string().min(1),
      userHandle: z.string().optional(),
    }),
    clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
    authenticatorAttachment: z.string().optional(),
  }),
})

const rejected = () => {
  log.warn('passkey login rejected')
  return Response.json({ error: 'invalid_passkey' }, { status: 401 })
}

const handlePost = withErrorBoundary(async (req: Request): Promise<Response> => {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  const challenge = await takeChallengeCookie('login')
  if (!parsed.success) return badRequest('bad_request')
  if (!challenge) return rejected()
  const stored = await findActivePasskeyByCredentialId(parsed.data.response.id)
  if (!stored) return rejected()
  const verified = await verifyAuthentication(
    relyingParty(req.headers), parsed.data.response as unknown as AuthenticationResponseJSON, challenge, stored,
  )
  if (!verified) return rejected()
  await recordPasskeyUse(stored.id, verified.newCounter)
  await startSession({ passkeyId: stored.id })
  log.info('passkey login accepted')
  return new Response(null, { status: 204 })
})

export async function POST(request: Request): Promise<Response> {
  return handlePost(request)
}
