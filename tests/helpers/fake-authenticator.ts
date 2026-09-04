import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto'
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers'
import type {
  AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON,
} from '@simplewebauthn/server'

// A WebAuthn authenticator in software: a P-256 key pair, a credential id,
// a signature counter, and the two ceremonies. It produces exactly the bytes
// a browser would hand back, so lib/services/webauthn.ts is verified for
// real — nothing in the library is mocked.
type Bytes = Uint8Array<ArrayBuffer>
// new Uint8Array(view) copies into a fresh ArrayBuffer, which is what the
// library's Uint8Array_ type asks for; Node's Buffer is typed looser.
const bytes = (b: Uint8Array | Buffer): Bytes => new Uint8Array(b) as Bytes
const sha256 = (b: Uint8Array | string): Bytes => bytes(createHash('sha256').update(b).digest())
const cbor = (m: Map<string | number, unknown>) => isoCBOR.encode(m as Parameters<typeof isoCBOR.encode>[0])
const concat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)) as Bytes
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
const u32 = (n: number): Bytes => { const b = new Uint8Array(4) as Bytes; new DataView(b.buffer).setUint32(0, n); return b }
const u16 = (n: number): Bytes => { const b = new Uint8Array(2) as Bytes; new DataView(b.buffer).setUint16(0, n); return b }

export class FakeAuthenticator {
  private readonly keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  readonly credentialId: Bytes = bytes(randomBytes(16))
  counter = 0
  // User verification: Touch ID, PIN. Set false to test a refused ceremony.
  uv = true

  get id(): string { return isoBase64URL.fromBuffer(this.credentialId) }

  private cosePublicKey(): Bytes {
    const jwk = this.keys.publicKey.export({ format: 'jwk' })
    const x = bytes(Buffer.from(jwk.x!, 'base64url'))
    const y = bytes(Buffer.from(jwk.y!, 'base64url'))
    // COSE EC2 key: kty=2, alg=ES256(-7), crv=P-256(1), x, y
    return cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, x], [-3, y]]))
  }

  private authData(rpID: string, attested: boolean): Bytes {
    const flags = 0x01 | (this.uv ? 0x04 : 0) | (attested ? 0x40 : 0) // UP, UV, AT
    const parts: Bytes[] = [sha256(rpID), new Uint8Array([flags]) as Bytes, u32(this.counter)]
    if (attested) parts.push(new Uint8Array(16) as Bytes, u16(this.credentialId.length), this.credentialId, this.cosePublicKey())
    return concat(...parts)
  }

  private clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin: string): Bytes {
    return bytes(new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false })))
  }

  create(options: PublicKeyCredentialCreationOptionsJSON, origin: string): RegistrationResponseJSON {
    const clientDataJSON = this.clientData('webauthn.create', options.challenge, origin)
    const attestationObject = cbor(new Map<string, unknown>([
      ['fmt', 'none'], ['attStmt', new Map()], ['authData', this.authData(options.rp.id!, true)],
    ]))
    return {
      id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {},
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
        attestationObject: isoBase64URL.fromBuffer(attestationObject),
        transports: ['internal'],
      },
    }
  }

  // advance:false replays the previous counter, which a verifier must refuse.
  get(options: PublicKeyCredentialRequestOptionsJSON, origin: string, opts: { advance?: boolean } = {}): AuthenticationResponseJSON {
    if (opts.advance !== false) this.counter += 1
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, origin)
    const authenticatorData = this.authData(options.rpId!, false)
    const signature = bytes(createSign('sha256')
      .update(concat(authenticatorData, sha256(clientDataJSON)))
      .sign(this.keys.privateKey))
    return {
      id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {},
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
        authenticatorData: isoBase64URL.fromBuffer(authenticatorData),
        signature: isoBase64URL.fromBuffer(signature),
      },
    }
  }
}
