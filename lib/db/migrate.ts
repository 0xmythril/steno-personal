import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import path from 'node:path'
import { db, type Db } from './client'

// Applies every drizzle/*.sql not yet recorded in __drizzle_migrations.
// Idempotent; run at every boot (scripts/boot.ts) and in the test setup.
export function runMigrations(database: Db = db): void {
  migrate(database, { migrationsFolder: path.join(process.cwd(), 'drizzle') })
}
