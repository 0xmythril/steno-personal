import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { sql } from 'drizzle-orm'
import { openDatabase } from '@/lib/db/client'
import { runMigrations } from '@/lib/db/migrate'
import { settings } from '@/lib/db/schema'

// An archive that predates the switch boots with it off and keeps every
// earlier preference; once set, repeat boots keep it.
it('adds the experimental switch off to an existing archive and preserves it afterwards', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'experimental-upgrade-'))
  const folder = path.join(root, 'migrations')
  mkdirSync(path.join(folder, 'meta'), { recursive: true })
  const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'))
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 16)
  writeFileSync(path.join(folder, 'meta/_journal.json'), JSON.stringify(journal))
  for (const entry of journal.entries) copyFileSync(`drizzle/${entry.tag}.sql`, path.join(folder, `${entry.tag}.sql`))
  const old = openDatabase(path.join(root, 'archive.db'))
  try {
    migrate(old, { migrationsFolder: folder })
    old.run(sql`update settings set advanced_mode = 1, telemetry_enabled = 0 where id = 1`)
    runMigrations(old)
    expect(old.select().from(settings).get()).toMatchObject({ advancedMode: true, telemetryEnabled: false, experimentalWechat: false })
    old.update(settings).set({ experimentalWechat: true }).run()
    runMigrations(old)
    expect(old.select().from(settings).get()).toMatchObject({ experimentalWechat: true, advancedMode: true })
  } finally {
    old.$client.close()
    rmSync(root, { recursive: true, force: true })
  }
})
