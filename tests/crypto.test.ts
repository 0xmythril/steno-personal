import { describe, it, expect, vi } from 'vitest'
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
  it('returns null for a payload made under a different SECRET_KEY', async () => {
    // app/settings/page.tsx ships a user-facing branch for exactly this path
    // ("SECRET_KEY changed since this key was made").
    const payload = encryptSecret('sp_from_the_old_key')
    const original = process.env.SECRET_KEY
    try {
      process.env.SECRET_KEY = 'a-different-secret-key-of-at-least-32-characters'
      vi.resetModules() // drops the derived-key cache in crypto.ts and secret-key.ts
      const { decryptSecret: decryptWithNewKey } = await import('@/lib/services/crypto')
      expect(decryptWithNewKey(payload)).toBeNull()
    } finally {
      process.env.SECRET_KEY = original
      vi.resetModules()
    }
  })
})
