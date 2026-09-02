import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { getSecretKey } from './secret-key'

// AES-256-GCM for small secrets that must be readable again (revealable
// access keys, the OpenRouter key, the Telegram session string). The key is
// derived from SECRET_KEY via HKDF-SHA256 with a domain-separating info
// string, so this module never holds the master secret directly.
const HKDF_INFO = 'steno-personal:secrets:v1'
const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const KEY_LENGTH = 32
const TAG_LENGTH = 16

let cachedKey: Buffer | null = null
function deriveKey(): Buffer {
  cachedKey ??= Buffer.from(hkdfSync('sha256', getSecretKey(), '', HKDF_INFO, KEY_LENGTH))
  return cachedKey
}

// Returns `iv.tag.ciphertext`, each base64. Fresh IV per call.
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, deriveKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.')
}

// Never throws: null for tampered, foreign-key, or malformed input.
export function decryptSecret(payload: string): string | null {
  try {
    const parts = payload.split('.')
    if (parts.length !== 3) return null
    const [iv, tag, ciphertext] = parts.map(p => Buffer.from(p, 'base64'))
    if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) return null
    const decipher = createDecipheriv(ALGORITHM, deriveKey(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
