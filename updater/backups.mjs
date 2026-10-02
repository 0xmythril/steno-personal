import { readdir, readFile, stat, rm } from 'node:fs/promises'
import path from 'node:path'
import { terminal } from './engine.mjs'

// A backup is backups/<upgrade-id>/ holding manifest.json and archive.tar.gz,
// written by DockerDriver.backup(). The manifest's mtime dates the upgrade:
// it is written before the archive, and a directory without one was not made
// by this code and is left alone.
export async function listBackups(directory) {
  const root = path.join(directory, 'backups')
  let entries = []
  try { entries = await readdir(root, { withFileTypes: true }) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const backups = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const manifest = await stat(path.join(root, entry.name, 'manifest.json'))
      backups.push({ id: entry.name, path: path.join(root, entry.name), at: manifest.mtimeMs })
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return backups.sort((a, b) => b.at - a.at)
}

// Newest `keep` stay, anything in `protect` stays, the rest go.
export function selectBackupsToPrune(backups, { keep, protect = new Set() }) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('keep must be a whole number of at least 1')
  return [...backups].sort((a, b) => b.at - a.at).filter((backup, index) => index >= keep && !protect.has(backup.id))
}

// Never runs during an upgrade, never touches the backup the journal names:
// that one is the rollback point for the release running now, so it stays
// whatever `keep` says. Only removes whole backup directories it listed.
export async function pruneBackups(directory, { keep, dryRun = false }) {
  let journal = null
  try { journal = JSON.parse(await readFile(path.join(directory, 'journal.json'), 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (journal && !terminal(journal.phase)) throw new Error('An upgrade is in progress. Wait for it to finish before pruning backups.')
  if (journal?.phase === 'recovery-required') throw new Error('Recovery is required. Follow the recovery guide first; the journal names the backup it needs.')
  const protect = new Set(typeof journal?.id === 'string' ? [journal.id] : [])
  const backups = await listBackups(directory)
  const remove = selectBackupsToPrune(backups, { keep, protect })
  if (!dryRun) for (const backup of remove) await rm(backup.path, { recursive: true, force: true })
  return {
    kept: backups.filter(backup => !remove.includes(backup)).map(backup => backup.id),
    removed: remove.map(backup => backup.id),
    dryRun,
  }
}
