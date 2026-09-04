import { z } from 'zod'
import { badRequest, withErrorBoundary } from '@/lib/api'
import { requireCookieAuth, takeChallengeCookie } from '@/lib/auth'
import { MAX_LABEL_LENGTH } from '@/lib/services/access-keys'
import { savePasskey } from '@/lib/services/passkeys'
import { relyingParty, verifyRegistration, type RegistrationResponseJSON } from '@/lib/services/webauthn'

// Step two: the attestation the browser produced for the challenge this
// browser was handed. Shape is checked here; everything cryptographic is
// checked in lib/services/webauthn.ts. The challenge cookie is spent on
// every attempt, so a rejected body cannot be retried against it.
const bodySchema = z.object({
  label: z.string().max(MAX_LABEL_LENGTH),
  response: z.looseObject({
    id: z.string().min(1),
    rawId: z.string().min(1),
    type: z.literal('public-key'),
    response: z.looseObject({
      clientDataJSON: z.string().min(1),
      attestationObject: z.string().min(1),
      transports: z.array(z.string()).optional(),
    }),
    clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
    authenticatorAttachment: z.string().optional(),
  }),
})

const handlePost = withErrorBoundary(async (req: Request): Promise<Response> => {
  const denied = await requireCookieAuth(req)
  if (denied) return denied
  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  const challenge = await takeChallengeCookie('register')
  if (!parsed.success) return badRequest('bad_request')
  if (!challenge) return Response.json({ error: 'verification_failed' }, { status: 401 })
  const credential = await verifyRegistration(
    relyingParty(req.headers), parsed.data.response as unknown as RegistrationResponseJSON, challenge,
  )
  if (!credential) return Response.json({ error: 'verification_failed' }, { status: 401 })
  const saved = await savePasskey({ ...credential, label: parsed.data.label })
  if (!saved.ok) return badRequest(saved.reason)
  return new Response(null, { status: 204 })
})

export async function POST(request: Request): Promise<Response> {
  return handlePost(request)
}
