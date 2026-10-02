// Host entry point, run inside a container with the control directory at
// /state (scripts/prune-backups.sh). Prints backup ids only; never a path
// from the manifest, which carries the deployment's environment.
import { pruneBackups } from './backups.mjs'

const args = process.argv.slice(2)
const keep = args.includes('--keep') ? Number(args[args.indexOf('--keep') + 1]) : NaN
const dryRun = args.includes('--dry-run')
if (!Number.isInteger(keep) || keep < 1) {
  console.error('Usage: node prune.mjs --keep <n> [--dry-run]')
  process.exit(2)
}
try {
  const { kept, removed } = await pruneBackups(process.env.STENO_STATE_DIR || '/state', { keep, dryRun })
  for (const id of removed) console.log(`${dryRun ? 'would remove' : 'removed'} backups/${id}`)
  console.log(`${kept.length} backup${kept.length === 1 ? '' : 's'} kept${dryRun ? ', nothing changed' : ''}`)
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
