import { describe, it, expect } from 'vitest'
import { FakeAuthenticator } from './helpers/fake-authenticator'
import {
  relyingParty, registrationOptions, verifyRegistration, authenticationOptions, verifyAuthentication,
} from '@/lib/services/webauthn'

const rp = { rpID: 'steno.example', origin: 'https://steno.example' }

async function registered(auth = new FakeAuthenticator()) {
  const options = await registrationOptions(rp, [])
  const cred = await verifyRegistration(rp, auth.create(options, rp.origin), options.challenge)
  if (!cred) throw new Error('registration did not verify')
  return { auth, stored: { id: 'row', label: 'l', credentialId: cred.credentialId, publicKey: cred.publicKey, counter: cred.counter, transports: cred.transports ?? null } }
}

describe('relyingParty', () => {
  it('derives host and scheme from the first forwarded hop, and strips the port from the rp id', () => {
    expect(relyingParty(new Headers({ host: 'localhost:3000' }))).toEqual({ rpID: 'localhost', origin: 'http://localhost:3000' })
    expect(relyingParty(new Headers({ host: 'inner:3000', 'x-forwarded-host': 'steno.example, inner', 'x-forwarded-proto': 'https, http' })))
      .toEqual({ rpID: 'steno.example', origin: 'https://steno.example' })
  })
})

describe('registration', () => {
  it('asks for a discoverable, user-verified credential and verifies a real attestation', async () => {
    const options = await registrationOptions(rp, [{ id: 'already', transports: ['internal'] }])
    expect(options.rp.id).toBe('steno.example')
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' })
    expect(options.excludeCredentials?.map(c => c.id)).toEqual(['already'])
    const auth = new FakeAuthenticator()
    const cred = await verifyRegistration(rp, auth.create(options, rp.origin), options.challenge)
    expect(cred).toMatchObject({ credentialId: auth.id, counter: 0, transports: ['internal'], backedUp: false })
    expect(cred!.publicKey.length).toBeGreaterThan(20)
  })

  it('refuses the wrong challenge, the wrong origin, and no user verification', async () => {
    const options = await registrationOptions(rp, [])
    const auth = new FakeAuthenticator()
    expect(await verifyRegistration(rp, auth.create(options, rp.origin), 'other')).toBeNull()
    expect(await verifyRegistration(rp, auth.create(options, 'https://evil.example'), options.challenge)).toBeNull()
    auth.uv = false
    expect(await verifyRegistration(rp, auth.create(options, rp.origin), options.challenge)).toBeNull()
  })
})

describe('authentication', () => {
  it('verifies a real assertion and reports the new counter', async () => {
    const { auth, stored } = await registered()
    const options = await authenticationOptions(rp)
    expect(options.allowCredentials).toBeUndefined()
    expect(options.userVerification).toBe('required')
    expect(await verifyAuthentication(rp, auth.get(options, rp.origin), options.challenge, stored)).toEqual({ newCounter: 1 })
  })

  it('refuses a replayed counter, a wrong origin, a wrong challenge, a foreign key, and no UV', async () => {
    const { auth, stored } = await registered()
    const options = await authenticationOptions(rp)
    const first = await verifyAuthentication(rp, auth.get(options, rp.origin), options.challenge, stored)
    const used = { ...stored, counter: first!.newCounter }
    expect(await verifyAuthentication(rp, auth.get(options, rp.origin, { advance: false }), options.challenge, used)).toBeNull()
    expect(await verifyAuthentication(rp, auth.get(options, 'https://evil.example'), options.challenge, used)).toBeNull()
    expect(await verifyAuthentication(rp, auth.get(options, rp.origin), 'other', used)).toBeNull()
    const other = new FakeAuthenticator()
    expect(await verifyAuthentication(rp, other.get(options, rp.origin), options.challenge, used)).toBeNull()
    auth.uv = false
    expect(await verifyAuthentication(rp, auth.get(options, rp.origin), options.challenge, used)).toBeNull()
  })
})
