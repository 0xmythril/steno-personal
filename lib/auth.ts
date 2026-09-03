// No `import 'server-only'` here: that package throws when imported under
// vitest, and later milestones unit-test route handlers that import this file.
// The file lives under lib/ and is only ever imported from server code.
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { createSession, deleteSession, resolveSession } from '@/lib/services/sessions'
import { verifyAccessKey } from '@/lib/services/access-keys'

export const SESSION_COOKIE = 'sp_session'
// The authoritative expiry is the server-side 30-day idle window in
// lib/services/sessions.ts, which slides forward on use. The cookie only
// has to outlive it, so it gets 400 days — the cap browsers clamp
// Max-Age to. A cookie shorter than the idle window would log an active
// user out while their session row was still valid.
export const COOKIE_MAX_AGE_S = 400 * 86_400

export type PortalSession = { sessionId: string; keyId: string; label: string }

export async function currentSession(): Promise<PortalSession | null> {
  const jar = await cookies()
  const id = jar.get(SESSION_COOKIE)?.value
  if (!id) return null
  return resolveSession(id)
}

export async function requireSession(): Promise<PortalSession> {
  const s = await currentSession()
  if (!s) redirect('/login')
  return s
}

// Cookie `secure` follows the request: Railway terminates TLS and forwards
// x-forwarded-proto=https; a laptop on http://localhost must still log in.
// Behind chained proxies the header arrives as a comma list ('https,http'),
// so only the first hop — the one that spoke to the client — counts.
export async function isHttps(): Promise<boolean> {
  const h = await headers()
  return h.get('x-forwarded-proto')?.split(',')[0].trim() === 'https'
}

export async function startSession(keyId: string): Promise<void> {
  const id = await createSession(keyId)
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
// with whatever the browser happens to be logged in as.
export async function authenticateRequest(req: Request): Promise<{ via: 'cookie' | 'bearer'; keyId: string } | null> {
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
// a bearer access key. From M3 an access key is what the owner pastes into
// agents, and those agents read archived chat text — the spec's named primary
// threat (§3.8). A key that could also delete the whole archive would give a
// prompt-injected agent a strictly larger blast radius than the read access it
// was handed. Reads stay cookie-or-bearer.
//
// Returns the response to send, or null when the caller may proceed.
export async function requireCookieAuth(req: Request): Promise<Response | null> {
  const auth = await authenticateRequest(req)
  if (!auth) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (auth.via !== 'cookie') return Response.json({ error: 'cookie_session_required' }, { status: 403 })
  return null
}
