import { mintAccessKey } from '@/lib/services/access-keys'
import { errorShape } from '@/lib/log'

// Recovery path when every key is lost: `npm run mint-key -- "label"`
// (or `docker compose exec app npm run mint-key -- "label"`).
async function main() {
  const label = process.argv[2] ?? 'recovery'
  const r = await mintAccessKey(label)
  if (!r.ok) { console.error(`mint failed: ${r.reason}`); process.exit(1) }
  console.log(r.rawKey)
}

main().catch(err => { console.error(errorShape(err)); process.exit(1) })
