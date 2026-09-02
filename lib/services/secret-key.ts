import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { env } from '@/lib/env'

export const SECRET_KEY_FILE = 'secret.key'

// Pure resolver, testable without touching process.env: the env value wins;
// otherwise the key lives in DATA_DIR/secret.key, generated once (spec
// decision 11). Losing this file makes every ciphertext unreadable — revealed
// keys and the Telegram session — but never the archive itself.
export function resolveSecretKey(opts: { envValue: string | undefined; dataDir: string }): string {
  if (opts.envValue) return opts.envValue
  const file = path.join(opts.dataDir, SECRET_KEY_FILE)
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  mkdirSync(opts.dataDir, { recursive: true })
  const key = randomBytes(32).toString('base64url')
  writeFileSync(file, key + '\n', { mode: 0o600 })
  return key
}

let cached: string | null = null
export function getSecretKey(): string {
  cached ??= resolveSecretKey({ envValue: env.SECRET_KEY, dataDir: env.DATA_DIR })
  return cached
}
