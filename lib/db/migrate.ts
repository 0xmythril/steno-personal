import { historyState } from './schema'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import path from 'node:path'
import { db, type Db } from './client'

// Applies every drizzle/*.sql not yet recorded in __drizzle_migrations.
// Idempotent; run at every boot (scripts/boot.ts) and in the test setup.
export function runMigrations(database: Db = db): void {
  const options = { migrationsFolder: path.join(process.cwd(), 'drizzle') }
  const sqlite = database.$client
  const journalExists = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'").get()
  if (journalExists) {
    const supported = new Map(readMigrationFiles(options).map(m => [m.folderMillis, m.hash]))
    const applied = sqlite.prepare('SELECT hash, created_at FROM __drizzle_migrations').all() as { hash: string; created_at: number }[]
    if (applied.some(m => supported.get(m.created_at) !== m.hash)) {
      throw new Error('This database contains migrations not supported by this build. Use the matching release or restore its matching backup.')
    }
  }
  migrate(database, options)
  database.insert(historyState).values({ id: 1 }).onConflictDoNothing().run()
}
