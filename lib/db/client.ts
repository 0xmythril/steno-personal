import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { env } from '@/lib/env'
import * as schema from './schema'

export const DB_FILE = 'steno.db'

export function openDatabase(file: string) {
  mkdirSync(path.dirname(file), { recursive: true })
  const sqlite = new Database(file)
  sqlite.pragma('journal_mode = WAL')   // web + worker share the file safely
  sqlite.pragma('foreign_keys = ON')     // cascades depend on this
  sqlite.pragma('busy_timeout = 5000')   // wait instead of SQLITE_BUSY under the two-process write pattern
  // Without this, SQLite does NOT fire row triggers for deletes performed by
  // ON DELETE CASCADE. Deleting a connection cascades chats -> messages, and
  // the messages AFTER DELETE trigger is what prunes search_index; skipping it
  // would leave orphan FTS rows that match forever.
  sqlite.pragma('recursive_triggers = ON')
  return drizzle(sqlite, { schema })
}

export type Db = ReturnType<typeof openDatabase>
let cached: Db | null = null

export function dbFile(): string {
  return path.join(env.DATA_DIR, DB_FILE)
}

// Lazy so importing this module at `next build` time opens nothing.
export const db: Db = new Proxy({} as Db, {
  get(_t, prop) {
    cached ??= openDatabase(dbFile())
    const v = (cached as unknown as Record<PropertyKey, unknown>)[prop]
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(cached) : v
  },
})
