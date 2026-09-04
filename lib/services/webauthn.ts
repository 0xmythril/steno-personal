import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type AuthenticatorTransport,
  type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { isoBase64URL } from '@simplewebauthn/server/helpers'
import { errorShape, log } from '@/lib/log'
import type { NewPasskey, StoredPasskey } from './passkeys'

// The one importer of @simplewebauthn/server (tests/passkeys-structure.test.ts),
// the way lib/channels/telegram.ts is the one importer of mtcute. The routes
// take the two response types from here rather than from the library.
//
// A passkey here is the whole login, so user verification — Touch ID,
// Windows Hello, a phone unlock, a security key WITH a PIN — is required in
// both ceremonies. Nothing in this file talks to the network: WebAuthn is a
// conversation between the browser and its authenticator.
export type { AuthenticationResponseJSON, RegistrationResponseJSON }

export const RP_NAME = 'Steno Personal'
// One user. The handle is a constant: not a secret, never shown.
const USER_ID = new TextEncoder().encode('steno-personal-owner')

export type RelyingParty = { rpID: string; origin: string }

// Derived per request from the same forwarded headers the session cookie's
// `secure` flag already trusts (lib/auth.ts#isHttps). Behind chained
// proxies only the first hop — the one that spoke to the browser — counts.
export function relyingParty(headers: Headers): RelyingParty {
  const first = (v: string | null) => v?.split(',')[0].trim() || undefined
  const host = first(headers.get('x-forwarded-host')) ?? first(headers.get('host')) ?? 'localhost'
  const proto = first(headers.get('x-forwarded-proto')) === 'https' ? 'https' : 'http'
  return { rpID: new URL(`http://${host}`).hostname, origin: `${proto}://${host}` }
}

export async function registrationOptions(
  rp: RelyingParty, exclude: { id: string; transports?: string[] }[],
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: RP_NAME, rpID: rp.rpID, userName: 'owner', userID: USER_ID,
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: exclude.map(c => ({ id: c.id, transports: c.transports as AuthenticatorTransport[] | undefined })),
  })
}

export async function verifyRegistration(
  rp: RelyingParty, response: RegistrationResponseJSON, expectedChallenge: string,
): Promise<Omit<NewPasskey, 'label'> | null> {
  try {
    const v = await verifyRegistrationResponse({
      response, expectedChallenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true,
    })
    if (!v.verified) return null
    const { credential, credentialBackedUp } = v.registrationInfo
    return {
      credentialId: credential.id, publicKey: isoBase64URL.fromBuffer(credential.publicKey),
      counter: credential.counter, transports: credential.transports, backedUp: credentialBackedUp,
    }
  } catch (err) {
    log.warn({ err: errorShape(err) }, 'passkey registration did not verify')
    return null
  }
}

export async function authenticationOptions(rp: RelyingParty): Promise<PublicKeyCredentialRequestOptionsJSON> {
  // No allowCredentials: the browser offers whatever discoverable credential
  // it holds for this rpID — one button, no username.
  return generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'required' })
}

export async function verifyAuthentication(
  rp: RelyingParty, response: AuthenticationResponseJSON, expectedChallenge: string, stored: StoredPasskey,
): Promise<{ newCounter: number } | null> {
  try {
    const v = await verifyAuthenticationResponse({
      response, expectedChallenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID,
      credential: {
        id: stored.credentialId, publicKey: isoBase64URL.toBuffer(stored.publicKey),
        counter: stored.counter, transports: stored.transports ?? undefined,
      },
      requireUserVerification: true,
    })
    return v.verified ? { newCounter: v.authenticationInfo.newCounter } : null
  } catch (err) {
    log.warn({ err: errorShape(err) }, 'passkey assertion did not verify')
    return null
  }
}
