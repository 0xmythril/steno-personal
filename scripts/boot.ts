import { mkdirSync } from 'node:fs'
import { errorShape } from '@/lib/log'
import { env } from '@/lib/env'
import { getSecretKey } from '@/lib/services/secret-key'
import { runMigrations } from '@/lib/db/migrate'
import { purgeExpiredSessions } from '@/lib/services/sessions'
import { hasAnyAccessKey, mintAccessKey } from '@/lib/services/access-keys'
import { mintRequestedKey, resetDataDir } from '@/lib/services/boot-ops'

// Runs before web and worker start (scripts/start.mjs). Order matters: a
// requested reset runs before anything opens the database or reads the secret
// file; the data dir must exist before either; a requested key is minted only
// after migrations. No key is printed unless the operator asked for one — a
// fresh instance hands its first key out on /setup, after a channel is paired.
async function main() {
  mkdirSync(env.DATA_DIR, { recursive: true })
  if (env.STENO_RESET && resetDataDir(env.DATA_DIR, env.STENO_RESET)) {
    console.log('[boot] STENO_RESET handled: data directory emptied; the variable can be removed')
  }
  getSecretKey()
  runMigrations()
  await purgeExpiredSessions()
  let minted = false
  if (env.STENO_MINT_KEY) {
    minted = await mintRequestedKey(env.DATA_DIR, env.STENO_MINT_KEY, mintAccessKey, line => console.log(line))
  }
  const fresh = !(await hasAnyAccessKey())
  console.log(`[boot] data dir ${env.DATA_DIR}; migrations applied${minted ? '; key minted' : ''}${fresh ? '; no key yet — open the portal to set up' : ''}`)
}

main().catch(err => { console.error('[boot] failed:', errorShape(err)); process.exit(1) })
