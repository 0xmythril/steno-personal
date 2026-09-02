import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Called from tests/setup.ts BEFORE any app module is imported, so lib/env
// and lib/db/client see the temp dir on their first (lazy) access.
export function useTempDataDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'steno-personal-'))
  process.env.DATA_DIR = dir
  process.env.SECRET_KEY = 'test-secret-key-that-is-at-least-32-characters-long'
  return dir
}

export async function resetDb(): Promise<void> {
  const { db } = await import('@/lib/db/client')
  const { sessions, accessKeys, messages, chats, connections } = await import('@/lib/db/schema')
  // Children first. The FK cascades would reach them anyway, but deleting
  // messages directly is what makes the AFTER DELETE trigger prune
  // search_index without depending on the recursive_triggers pragma.
  await db.delete(messages)
  await db.delete(chats)
  await db.delete(connections)
  await db.delete(sessions)
  await db.delete(accessKeys)
}
