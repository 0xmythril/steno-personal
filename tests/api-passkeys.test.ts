import { describe, it, expect, beforeEach, vi } from 'vitest'

// lib/auth.ts reads and writes cookies through next/headers, which only
// exists inside a request scope. One in-memory jar stands in for it — the
// convention of tests/api-routes.test.ts — so the real cookie session, the
// real challenge cookie, and the real verification all run end to end.
const jar = new Map<string, string>()
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value) },
    delete: (opts: { name: string }) => { jar.delete(opts.name) },
  }),
  headers: async () => new Headers(),
}))
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`) } }))

import { resetDb } from './helpers/db'
import { FakeAuthenticator } from './helpers/fake-authenticator'
import { mintAccessKey } from '@/lib/services/access-keys'
import { listActivePasskeys, savePasskey } from '@/lib/services/passkeys'
import { startSession, SESSION_COOKIE, WEBAUTHN_COOKIE } from '@/lib/auth'
import { POST as registerOptions } from '@/app/api/passkeys/register/options/route'
import { POST as register } from '@/app/api/passkeys/register/route'
import { POST as loginOptions } from '@/app/api/passkeys/login/options/route'
import { POST as login } from '@/app/api/passkeys/login/route'

const ORIGIN = 'https://steno.example'
const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { host: 'steno.example', 'x-forwarded-proto': 'https', 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

async function key(label: string) {
  const k = await mintAccessKey(label)
  if (!k.ok) throw new Error(k.reason)
  return k
}

async function signedIn() {
  const k = await key('laptop')
  await startSession({ keyId: k.id })
  return k
}

async function enrol(auth = new FakeAuthenticator(), label = 'This laptop') {
  const opt = await registerOptions(post('/api/passkeys/register/options'))
  expect(opt.status).toBe(200)
  const options = await opt.json()
  const res = await register(post('/api/passkeys/register', { label, response: auth.create(options, ORIGIN) }))
  return { auth, res }
}

beforeEach(async () => { jar.clear(); await resetDb() })

describe('registration routes', () => {
  it('needs a cookie session, not a bearer key', async () => {
    expect((await registerOptions(post('/api/passkeys/register/options'))).status).toBe(401)
    const k = await key('agent')
    expect((await registerOptions(post('/api/passkeys/register/options', undefined, { authorization: `Bearer ${k.rawKey}` }))).status).toBe(403)
    expect((await register(post('/api/passkeys/register', { label: 'x', response: {} }, { authorization: `Bearer ${k.rawKey}` }))).status).toBe(403)
  })

  it('enrols a passkey bound to the challenge cookie, then clears the cookie', async () => {
    await signedIn()
    const { auth, res } = await enrol()
    expect(res.status).toBe(204)
    expect(jar.has(WEBAUTHN_COOKIE)).toBe(false)
    expect((await listActivePasskeys()).map(p => p.label)).toEqual(['This laptop'])
    // the same authenticator is now in excludeCredentials
    const opt = await registerOptions(post('/api/passkeys/register/options'))
    expect((await opt.json()).excludeCredentials.map((c: { id: string }) => c.id)).toEqual([auth.id])
  })

  it('refuses a bad label, a bad shape, and a challenge already spent', async () => {
    await signedIn()
    const auth = new FakeAuthenticator()
    const options = await (await registerOptions(post('/api/passkeys/register/options'))).json()
    const attestation = auth.create(options, ORIGIN)
    expect((await register(post('/api/passkeys/register', { label: 'x'.repeat(101), response: attestation }))).status).toBe(400)
    // every verify takes the cookie, so a valid body is now stale
    expect((await register(post('/api/passkeys/register', { label: 'ok', response: attestation }))).status).toBe(401)
    const again = await (await registerOptions(post('/api/passkeys/register/options'))).json()
    expect((await register(post('/api/passkeys/register', { label: '', response: auth.create(again, ORIGIN) }))).status).toBe(400)
    await registerOptions(post('/api/passkeys/register/options'))
    expect((await register(post('/api/passkeys/register', { label: 'ok', response: { nope: 1 } }))).status).toBe(400)
    expect(await listActivePasskeys()).toEqual([])
  })
})

describe('login routes', () => {
  it('404s while there is nothing to log in with', async () => {
    expect((await loginOptions(post('/api/passkeys/login/options'))).status).toBe(404)
    await key('k') // no longer fresh, still no passkey
    expect((await loginOptions(post('/api/passkeys/login/options'))).status).toBe(404)
  })

  it('logs in with a real assertion, sets the session cookie, records the use', async () => {
    await signedIn()
    const { auth } = await enrol()
    jar.clear()
    const options = await (await loginOptions(post('/api/passkeys/login/options'))).json()
    expect(options.allowCredentials).toBeUndefined()
    const res = await login(post('/api/passkeys/login', { response: auth.get(options, ORIGIN) }))
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    expect(jar.has(SESSION_COOKIE)).toBe(true)
    expect(jar.has(WEBAUTHN_COOKIE)).toBe(false)
    expect((await listActivePasskeys())[0].lastUsedAt).toBeInstanceOf(Date)
  })

  it('refuses a spent challenge, a replay, an unknown credential, a register challenge, and a bad shape', async () => {
    await signedIn()
    const { auth } = await enrol()
    jar.clear()
    const options = await (await loginOptions(post('/api/passkeys/login/options'))).json()
    expect((await login(post('/api/passkeys/login', { response: auth.get(options, ORIGIN) }))).status).toBe(204)
    jar.delete(SESSION_COOKIE)
    // the same assertion again: the cookie is gone
    expect((await login(post('/api/passkeys/login', { response: auth.get(options, ORIGIN, { advance: false }) }))).status).toBe(401)
    // replayed counter under a fresh challenge
    const again = await (await loginOptions(post('/api/passkeys/login/options'))).json()
    expect((await login(post('/api/passkeys/login', { response: auth.get(again, ORIGIN, { advance: false }) }))).status).toBe(401)
    // an authenticator this instance never saw
    const third = await (await loginOptions(post('/api/passkeys/login/options'))).json()
    expect((await login(post('/api/passkeys/login', { response: new FakeAuthenticator().get(third, ORIGIN) }))).status).toBe(401)
    // a registration challenge presented to login
    await savePasskey({ label: 'seed', credentialId: 'seed', publicKey: 'pk', counter: 0, backedUp: false })
    await startSession({ keyId: (await key('k2')).id })
    const regOptions = await (await registerOptions(post('/api/passkeys/register/options'))).json()
    expect((await login(post('/api/passkeys/login', { response: auth.get({ ...regOptions, rpId: 'steno.example' }, ORIGIN) }))).status).toBe(401)
    expect(jar.has(WEBAUTHN_COOKIE)).toBe(false)
    // shape
    await loginOptions(post('/api/passkeys/login/options'))
    expect((await login(post('/api/passkeys/login', { response: { nope: 1 } }))).status).toBe(400)
    expect(jar.has(WEBAUTHN_COOKIE)).toBe(false)
  })
})
