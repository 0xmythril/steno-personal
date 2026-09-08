import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { env } from '@/lib/env'
import { db } from '@/lib/db/client'
import { version } from '@/package.json'

export const heartbeatFile = () => path.join(env.DATA_DIR, 'worker-heartbeat.json')

export function recordWorkerProgress() {
  const file = heartbeatFile()
  writeFileSync(`${file}.tmp`, JSON.stringify({ version, at: Date.now() }), { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
}

export function isReady(): boolean {
  try {
    db.$client.prepare('SELECT 1 FROM settings LIMIT 1').get()
    const heartbeat = JSON.parse(readFileSync(heartbeatFile(), 'utf8'))
    const age = Date.now() - heartbeat.at
    return heartbeat.version === version && age >= 0 && age < 60_000
  } catch { return false }
}
