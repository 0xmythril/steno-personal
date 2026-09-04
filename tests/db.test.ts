import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import path from 'node:path'
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

// Migrations run against a database that already holds rows, and 0005 is the
// first one whose new column changes how an existing row behaves: every person
// that predates it was named by hand, so it has to land as an alias rather than
// as a channel name a later contact sync may overwrite.
describe('migration 0005 on a database that already has people', () => {
  const statements = (file: string): string[] =>
    readFileSync(path.join('drizzle', file), 'utf8')
      .split('--> statement-breakpoint')
      .map(s => s.trim())
      .filter(Boolean)

  it('marks people created before it as owner-named', () => {
    const sqlite = new Database(':memory:')
    try {
      // Everything up to, but not including, the migration under test.
      for (const file of ['0000_init.sql', '0001_channels.sql', '0002_media.sql', '0003_recovery.sql', '0004_people.sql']) {
        for (const s of statements(file)) sqlite.exec(s)
      }
      const now = Date.now()
      sqlite.prepare('INSERT INTO people (id, name, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('p1', 'Ada Lovelace', null, now, now)

      for (const s of statements('0005_people_auto.sql')) sqlite.exec(s)

      const row = sqlite.prepare('SELECT name, name_source, archived_at FROM people WHERE id = ?').get('p1') as
        { name: string; name_source: string; archived_at: number | null }
      expect(row).toEqual({ name: 'Ada Lovelace', name_source: 'owner', archived_at: null })

      // …and the column default still applies to everyone created after it, who
      // may well be a copy of a contact list entry.
      sqlite.prepare('INSERT INTO people (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run('p2', 'Grace', now, now)
      expect((sqlite.prepare('SELECT name_source FROM people WHERE id = ?').get('p2') as { name_source: string }).name_source)
        .toBe('channel')
    } finally {
      sqlite.close()
    }
  })
})
