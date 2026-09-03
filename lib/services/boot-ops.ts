import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { MAX_LABEL_LENGTH, type MintResult } from './access-keys'

// Host-operator operations, requested through environment variables and
// performed by scripts/boot.ts exactly once per value. Whoever can set the
// variables already controls the volume, so nothing here widens who may wipe
// or mint; it only spares them a shell. A marker file under DATA_DIR records
// the last value handled, so a variable left set does nothing on the next
// restart — and a reset writes its marker into the freshly emptied directory.
//
// Pure over its arguments (no env, no db import) so it is unit-testable and
// so the reset can run BEFORE the database is opened.

export const BOOT_OPS_FILE = 'boot-ops.json'

export type BootOpsMarker = { reset: string | null; mintKey: string | null }

const EMPTY: BootOpsMarker = { reset: null, mintKey: null }

export function readMarker(dataDir: string): BootOpsMarker {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dataDir, BOOT_OPS_FILE), 'utf8')) as Partial<BootOpsMarker>
    return {
      reset: typeof parsed.reset === 'string' ? parsed.reset : null,
      mintKey: typeof parsed.mintKey === 'string' ? parsed.mintKey : null,
    }
  } catch {
    return { ...EMPTY }
  }
}

function writeMarker(dataDir: string, marker: BootOpsMarker): void {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(path.join(dataDir, BOOT_OPS_FILE), JSON.stringify(marker) + '\n', { mode: 0o600 })
}

// STENO_RESET: empty the data directory — database, WAL, media, WhatsApp auth
// state, the generated secret key — so the next visit lands on /setup. Only
// entries INSIDE the directory are removed, one level down, and rmSync never
// follows a symlink, so a link left in DATA_DIR takes only itself with it.
// Returns true when it wiped, false when this value was already handled.
export function resetDataDir(dataDir: string, value: string): boolean {
  if (readMarker(dataDir).reset === value) return false
  mkdirSync(dataDir, { recursive: true })
  for (const entry of readdirSync(dataDir)) {
    rmSync(path.join(dataDir, entry), { recursive: true, force: true })
  }
  // mintKey is cleared too: the fresh instance may legitimately be handed the
  // same STENO_MINT_KEY label again.
  writeMarker(dataDir, { reset: value, mintKey: null })
  return true
}

// The one sanctioned place a raw key reaches stdout: the operator asked for it
// by setting the variable, and the log is theirs.
export function printKeyBanner(print: (line: string) => void, rawKey: string, label: string): void {
  print('')
  print('==========================================================')
  print(`  steno-personal: access key "${label}"`)
  print(`  ${rawKey}`)
  print('  Paste it at /login. Remove STENO_MINT_KEY now; this banner')
  print('  will not print again for this value.')
  print('==========================================================')
  print('')
}

// STENO_MINT_KEY: mint a key labelled with the value and print it once.
// Returns true when it minted, false when this value was already handled.
export async function mintRequestedKey(
  dataDir: string,
  value: string,
  mint: (label: string) => Promise<MintResult>,
  print: (line: string) => void,
): Promise<boolean> {
  const marker = readMarker(dataDir)
  if (marker.mintKey === value) return false
  const label = value.trim().slice(0, MAX_LABEL_LENGTH) || 'host'
  const r = await mint(label)
  if (!r.ok) throw new Error(`STENO_MINT_KEY: ${r.reason}`)
  printKeyBanner(print, r.rawKey, label)
  writeMarker(dataDir, { ...marker, mintKey: value })
  return true
}
