import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from './helpers/db'
import { ensureBootstrapKey } from '@/lib/services/bootstrap'
import { verifyAccessKey, listActiveAccessKeys, revokeAllAccessKeys } from '@/lib/services/access-keys'

describe('bootstrap key', () => {
  beforeEach(resetDb)

  it('mints and prints exactly once when no key exists', async () => {
    const lines: string[] = []
    expect(await ensureBootstrapKey(l => lines.push(l))).toBe('minted')
    const printed = lines.join('\n').match(/sp_[A-Za-z0-9_-]+/)?.[0]
    expect(printed).toBeDefined()
    expect(await verifyAccessKey(printed!)).toMatchObject({ label: 'bootstrap' })
    expect(await ensureBootstrapKey(l => lines.push(l))).toBe('exists')
    expect((await listActiveAccessKeys()).length).toBe(1)
  })

  it('mints again if every key was revoked', async () => {
    await ensureBootstrapKey(() => {})
    await revokeAllAccessKeys()
    expect(await ensureBootstrapKey(() => {})).toBe('minted')
  })
})
