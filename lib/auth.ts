// No `import 'server-only'` here: that package throws when imported under
// vitest, and later milestones unit-test route handlers that import this file.
// The file lives under lib/ and is only ever imported from server code.
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { createSession, deleteSession, resolveSession, type ResolvedSession, type SessionCredential } from '@/lib/services/sessions'
import { hasAnyAccessKey, verifyAccessKey } from '@/lib/services/access-keys'
import { FIRST_KEY_COOKIE } from '@/lib/services/keys-flash'

export const SESSION_COOKIE = 'sp_session'
// The authoritative expiry is the server-side 30-day idle window in
// lib/services/sessions.ts, which slides forward on use. The cookie only
// has to outlive it, so it gets 400 days — the cap browsers clamp
// Max-Age to. A cookie shorter than the idle window would log an active
// user out while their session row was still valid.
export const COOKIE_MAX_AGE_S = 400 * 86_400

// via says which credential opened the session; the other id is null.
export type PortalSession = ResolvedSession

export async function currentSession(): Promise<PortalSession | null> {
  const jar = await cookies()
  const id = jar.get(SESSION_COOKIE)?.value
  if (!id) return null
  return resolveSession(id)
}

// A fresh instance — no key has ever existed — has nothing to log in with, so
// the session-less visitor is sent to /setup to pair a channel and receive the
// first key. Once any key row exists (even revoked) /setup is closed and the
// visitor goes to /login, which offers recovery.
export async function isFreshInstance(): Promise<boolean> {
  return !(await hasAnyAccessKey())
}

export async function requireSession(): Promise<PortalSession> {
  const s = await currentSession()
  if (!s) redirect((await isFreshInstance()) ? '/setup' : '/login')
  return s
}

// The guard for the setup pages and their server actions, in place of
// requireSession(): they are meant to be reached without a session, but only
// while the instance is fresh. tests/auth-structure.test.ts accepts exactly
// this guard in exactly app/setup/actions.ts.
export async function requireFreshInstance(): Promise<void> {
  if (!(await isFreshInstance())) redirect('/login')
}

// Cookie `secure` follows the request: Railway terminates TLS and forwards
// x-forwarded-proto=https; a laptop on http://localhost must still log in.
// Behind chained proxies the header arrives as a comma list ('https,http'),
// so only the first hop — the one that spoke to the client — counts.
export async function isHttps(): Promise<boolean> {
  const h = await headers()
  return h.get('x-forwarded-proto')?.split(',')[0].trim() === 'https'
}

export async function startSession(credential: SessionCredential): Promise<void> {
  const id = await createSession(credential)
  const jar = await cookies()
  jar.set(SESSION_COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: await isHttps(), maxAge: COOKIE_MAX_AGE_S, path: '/' })
}

export async function endSession(): Promise<void> {
  const jar = await cookies()
  const id = jar.get(SESSION_COOKIE)?.value
  if (id) await deleteSession(id)
  jar.delete({ name: SESSION_COOKIE, path: '/' })
}

// READ routes accept either the portal's session cookie or an access key as a
// bearer token, so the same routes serve the browser and (from M3) an agent.
// Mutating routes are cookie-only — see requireCookieAuth below. A bearer
// header that is present but bad is a REJECTION, never a fall-through to the
// cookie: an agent sending a stale key must be told so, not silently answered
// with whatever the browser happens to be logged in as. A cookie session
// opened with a passkey has no key, so keyId is null there; no caller reads
// it for a cookie session.
export async function authenticateRequest(req: Request): Promise<{ via: 'cookie' | 'bearer'; keyId: string | null } | null> {
  const header = req.headers.get('authorization')
  if (header?.startsWith('Bearer ')) {
    const key = await verifyAccessKey(header.slice('Bearer '.length).trim())
    return key ? { via: 'bearer', keyId: key.id } : null
  }
  const session = await currentSession()
  return session ? { via: 'cookie', keyId: session.keyId } : null
}

// The guard for routes that CHANGE a connection (create, disconnect, delete
// everything, submit a 2FA password): the browser's own session cookie, never
// a bearer access key. An access key is what the owner pastes into agents, and
// those agents read archived chat text — the primary threat in
// docs/threat-model.md — so the mutating routes are kept off the bearer path
// an agent's HTTP tool would use.
//
// This is defence in depth, not a security boundary: there is one credential
// type, and the same key logs in at /api/login and mints a full session. A
// key holder who knows that can reach every cookie-only route in two
// requests, which is why the threat model treats a leaked key as a full
// compromise until it is revoked. Reads stay cookie-or-bearer.
//
// Returns the response to send, or null when the caller may proceed.
export async function requireCookieAuth(req: Request): Promise<Response | null> {
  const auth = await authenticateRequest(req)
  if (!auth) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (auth.via !== 'cookie') return Response.json({ error: 'cookie_session_required' }, { status: 403 })
  return null
}

// ---- Recovery (app/login/recover) ----
//
// A recovery attempt is bound to the browser that started it by an httpOnly
// cookie carrying the attempt id — never a URL, so the id reaches no log and
// no Referer. The status route and every recovery action resolve the attempt
// from this cookie alone.
export const RECOVERY_COOKIE = 'sp_recovery'
// A login window is 15 minutes (session-manager LOGIN_TIMEOUT_MS); the cookie
// outlives it so a finished attempt can still be read and claimed.
export const RECOVERY_COOKIE_MAX_AGE_S = 20 * 60

export async function currentRecoveryAttempt(): Promise<string | null> {
  const jar = await cookies()
  return jar.get(RECOVERY_COOKIE)?.value ?? null
}

export async function setRecoveryCookie(id: string): Promise<void> {
  const jar = await cookies()
  jar.set(RECOVERY_COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: await isHttps(), maxAge: RECOVERY_COOKIE_MAX_AGE_S, path: '/' })
}

export async function clearRecoveryCookie(): Promise<void> {
  const jar = await cookies()
  jar.delete({ name: RECOVERY_COOKIE, path: '/' })
}

// Recovery is for a locked-out owner of a non-fresh instance: a fresh one has
// /setup, and a browser that is already logged in has nothing to recover.
export async function requireRecoveryOpen(): Promise<void> {
  if (await isFreshInstance()) redirect('/setup')
  if (await currentSession()) redirect('/')
}

// The guard for every recovery action past Start: the attempt this browser
// owns, or back to the beginning. tests/auth-structure.test.ts accepts this
// guard (and requireRecoveryOpen, for Start) in exactly
// app/login/recover/actions.ts.
export async function requireRecoveryAttempt(): Promise<string> {
  await requireRecoveryOpen()
  const id = await currentRecoveryAttempt()
  if (!id) redirect('/login/recover')
  return id
}

// ---- Setup (app/setup) ----
//
// Pairing binds the instance to the browser that started it, the same way a
// recovery attempt is bound: an httpOnly cookie carrying the connection id.
// This closes the window between "paired" and "first key minted". The worker
// activates the connection and starts archiving the owner's real account
// before any key exists, and during that window the instance is still fresh
// — so without the cookie whoever reached /setup next could mint the first
// key against the owner's account. With it, only the browser that scanned
// the QR sees the pairing, the poll, and the finish step.
export const SETUP_COOKIE = 'sp_setup'
// Pairing takes minutes; the owner may take longer to come back to the tab.
export const SETUP_COOKIE_MAX_AGE_S = 24 * 60 * 60

export async function currentSetupAttempt(): Promise<string | null> {
  const jar = await cookies()
  return jar.get(SETUP_COOKIE)?.value ?? null
}

export async function setSetupCookie(id: string): Promise<void> {
  const jar = await cookies()
  jar.set(SETUP_COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: await isHttps(), maxAge: SETUP_COOKIE_MAX_AGE_S, path: '/' })
}

export async function clearSetupCookie(): Promise<void> {
  const jar = await cookies()
  jar.delete({ name: SETUP_COOKIE, path: '/' })
}

// The guard for every setup action past Connect: the instance must still be
// fresh AND this browser must hold a pairing. tests/auth-structure.test.ts
// accepts this guard (and requireFreshInstance, for Connect) in exactly
// app/setup/actions.ts.
export async function requireSetupAttempt(): Promise<string> {
  await requireFreshInstance()
  const id = await currentSetupAttempt()
  if (!id) redirect('/setup')
  return id
}

// The first key — from setup or from recovery — is shown exactly once, on
// /welcome, out of this flash. Same shape as the Settings flashes: httpOnly,
// path-scoped, minutes long.
export async function setFirstKeyFlash(id: string, rawKey: string): Promise<void> {
  const jar = await cookies()
  jar.set(FIRST_KEY_COOKIE, JSON.stringify({ id, rawKey }), {
    httpOnly: true, sameSite: 'lax', secure: await isHttps(), maxAge: 5 * 60, path: '/welcome',
  })
}

// ---- Passkeys (app/api/passkeys) ----
//
// A WebAuthn ceremony is two requests: options (which carry a challenge the
// authenticator must sign) and verify. The challenge rides between them in
// an httpOnly cookie, never a URL, so only the browser that asked for the
// options can answer them. The purpose is stored with it so a registration
// challenge can never satisfy a login, or the reverse. The cookie is taken —
// read and deleted — on every verify, success or failure.
export const WEBAUTHN_COOKIE = 'sp_webauthn'
export const WEBAUTHN_COOKIE_MAX_AGE_S = 5 * 60
export type ChallengePurpose = 'register' | 'login'

export async function setChallengeCookie(challenge: string, purpose: ChallengePurpose): Promise<void> {
  const jar = await cookies()
  jar.set(WEBAUTHN_COOKIE, JSON.stringify({ challenge, purpose }), {
    httpOnly: true, sameSite: 'lax', secure: await isHttps(), maxAge: WEBAUTHN_COOKIE_MAX_AGE_S, path: '/api/passkeys',
  })
}

export async function takeChallengeCookie(purpose: ChallengePurpose): Promise<string | null> {
  const jar = await cookies()
  const raw = jar.get(WEBAUTHN_COOKIE)?.value
  jar.delete({ name: WEBAUTHN_COOKIE, path: '/api/passkeys' })
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { challenge?: unknown; purpose?: unknown }
    return parsed.purpose === purpose && typeof parsed.challenge === 'string' ? parsed.challenge : null
  } catch {
    return null
  }
}
