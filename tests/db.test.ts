import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '@/lib/db/client'
import { accessKeys, sessions } from '@/lib/db/schema'
import { resetDb } from './helpers/db'
import { eq } from 'drizzle-orm'

describe('sqlite schema', () => {
  beforeEach(resetDb)

  it('round-trips a key row with defaults', async () => {
    const [row] = await db.insert(accessKeys).values({ label: 'a', keyHash: 'h', keyCiphertext: 'c', prefix: 'p' }).returning()
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(row.createdAt).toBeInstanceOf(Date)
    expect(row.revokedAt).toBeNull()
  })

  it('cascades sessions when a key row is deleted', async () => {
    const [key] = await db.insert(accessKeys).values({ label: 'a', keyHash: 'h', keyCiphertext: 'c', prefix: 'p' }).returning()
    await db.insert(sessions).values({ id: 's1', keyId: key.id, expiresAt: new Date(Date.now() + 1000) })
    await db.delete(accessKeys).where(eq(accessKeys.id, key.id))
    expect(await db.select().from(sessions)).toEqual([])
  })

  it('rejects two keys with the same hash', async () => {
    await db.insert(accessKeys).values({ label: 'a', keyHash: 'same', keyCiphertext: 'c', prefix: 'p' })
    await expect(db.insert(accessKeys).values({ label: 'b', keyHash: 'same', keyCiphertext: 'c', prefix: 'p' })).rejects.toThrow()
  })
})
