import { countActiveAccessKeys, mintAccessKey } from './access-keys'

// The one sanctioned place a raw key reaches stdout (spec decision 8): with
// no active key there is no other way in. The README tells the user to log
// in with it, mint their own, and revoke this one.
export async function ensureBootstrapKey(print: (line: string) => void): Promise<'minted' | 'exists'> {
  if ((await countActiveAccessKeys()) > 0) return 'exists'
  const r = await mintAccessKey('bootstrap')
  if (!r.ok) throw new Error(`bootstrap mint failed: ${r.reason}`)
  print('')
  print('==========================================================')
  print('  steno-personal: your first access key')
  print(`  ${r.rawKey}`)
  print('  Paste it at /login, then mint a named key in Settings')
  print('  and revoke this one.')
  print('==========================================================')
  print('')
  return 'minted'
}
