import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { openDatabase } from '@/lib/db/client'
import { runMigrations } from '@/lib/db/migrate'
import journal from '@/drizzle/meta/_journal.json'

describe('upgrading an existing archive schema', () => {
  it('can skip intervening migrations while preserving access keys and browser sessions', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'steno-old-schema-'))
    const migrations = path.join(directory, 'old-migrations')
    mkdirSync(path.join(migrations, 'meta'), { recursive: true })
    copyFileSync('drizzle/0000_init.sql', path.join(migrations, '0000_init.sql'))
    writeFileSync(path.join(migrations, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }))
    const database = openDatabase(path.join(directory, 'archive.db'))
    try {
      migrate(database, { migrationsFolder: migrations })
      database.$client.prepare('INSERT INTO access_keys (id,label,key_hash,key_ciphertext,prefix,created_at) VALUES (?,?,?,?,?,?)')
        .run('upgrade-key', 'synthetic owner', 'synthetic-hash', 'synthetic-encrypted-key', 'synthetic', 1000)
      database.$client.prepare('INSERT INTO sessions (id,key_id,created_at,expires_at) VALUES (?,?,?,?)')
        .run('upgrade-session', 'upgrade-key', 1000, 9000)
      runMigrations(database)
      runMigrations(database)
      expect(database.$client.prepare('SELECT key_ciphertext FROM access_keys WHERE id = ?').get('upgrade-key'))
        .toEqual({ key_ciphertext: 'synthetic-encrypted-key' })
      expect(database.$client.prepare('SELECT key_id FROM sessions WHERE id = ?').get('upgrade-session'))
        .toEqual({ key_id: 'upgrade-key' })
      expect(database.$client.pragma('foreign_key_check')).toEqual([])
      expect(database.$client.pragma('quick_check', { simple: true })).toBe('ok')
      expect(database.$client.prepare('SELECT count(*) AS count FROM __drizzle_migrations').get())
        .toEqual({ count: journal.entries.length })
      database.$client.prepare('INSERT INTO __drizzle_migrations (hash,created_at) VALUES (?,?)').run('future-release-migration', Date.now() + 86_400_000)
      expect(() => runMigrations(database)).toThrow('not supported by this build')
      expect(database.$client.prepare('SELECT key_id FROM sessions WHERE id = ?').get('upgrade-session'))
        .toEqual({ key_id: 'upgrade-key' })
    } finally { database.$client.close() }
  })
})
