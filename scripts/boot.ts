import { mkdirSync } from 'node:fs'
import { env } from '@/lib/env'
import { getSecretKey } from '@/lib/services/secret-key'
import { runMigrations } from '@/lib/db/migrate'
import { ensureBootstrapKey } from '@/lib/services/bootstrap'
import { purgeExpiredSessions } from '@/lib/services/sessions'

// Runs before web and worker start (scripts/start.mjs). Order matters:
// the data dir must exist before the secret file or the database.
async function main() {
  mkdirSync(env.DATA_DIR, { recursive: true })
  getSecretKey()
  runMigrations()
  await purgeExpiredSessions()
  const outcome = await ensureBootstrapKey(line => console.log(line))
  console.log(`[boot] data dir ${env.DATA_DIR}; migrations applied; bootstrap key ${outcome}`)
}

main().catch(err => { console.error('[boot] failed:', err); process.exit(1) })
