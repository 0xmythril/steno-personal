import { describe, it, expect } from 'vitest'
import { encryptSecret, decryptSecret } from '@/lib/services/crypto'

describe('crypto', () => {
  it('round-trips and randomises the IV', () => {
    const a = encryptSecret('sp_hello')
    const b = encryptSecret('sp_hello')
    expect(a).not.toBe(b)
    expect(decryptSecret(a)).toBe('sp_hello')
    expect(decryptSecret(b)).toBe('sp_hello')
  })
  it('returns null for tampered or malformed payloads', () => {
    const c = encryptSecret('x')
    const [iv, tag, ct] = c.split('.')
    expect(decryptSecret([iv, tag, ct.slice(0, -2) + 'AA'].join('.'))).toBeNull()
    expect(decryptSecret('not.a.payload.at.all')).toBeNull()
    expect(decryptSecret('')).toBeNull()
  })
})
