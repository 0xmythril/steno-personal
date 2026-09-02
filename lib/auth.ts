// No `import 'server-only'` here: that package throws when imported under
// vitest, and later milestones unit-test route handlers that import this file.
// The file lives under lib/ and is only ever imported from server code.
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { createSession, deleteSession, resolveSession } from '@/lib/services/sessions'

export const SESSION_COOKIE = 'sp_session'
const COOKIE_MAX_AGE_S = 30 * 86_400

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

// `secure` follows the request: Railway terminates TLS and forwards
// x-forwarded-proto=https; a laptop on http://localhost must still log in.
async function isHttps(): Promise<boolean> {
  const h = await headers()
  return h.get('x-forwarded-proto') === 'https'
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
