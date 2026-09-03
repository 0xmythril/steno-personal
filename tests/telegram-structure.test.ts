import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const src = readFileSync('lib/channels/telegram.ts', 'utf8')
// Strip comments once: a word in an explanatory comment must never be the
// reason a ban passes or a requirement fails.
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = path.join(dir, entry)
    if (entry === 'node_modules' || entry.startsWith('.')) return []
    if (statSync(full).isDirectory()) return walk(full)
    return /\.tsx?$/.test(entry) ? [full] : []
  })
}

describe('the mtcute boundary', () => {
  it('only lib/channels/telegram.ts imports @mtcute/*', () => {
    // Repo-wide, not a list someone remembered to update: the claim stops
    // meaning anything the day a new file imports it from somewhere else.
    const importers = ['lib', 'app', 'worker', 'scripts']
      .flatMap(walk)
      .filter(f => /@mtcute\//.test(readFileSync(f, 'utf8')))
    expect(importers).toEqual(['lib/channels/telegram.ts'])
  })

  it('the binding exposes no send or mutate call — except the sanctioned logOut()', () => {
    // mtcute HAS a setOnline() wrapper whose presence flip happens inside an
    // internal RPC that never spells `offline: false` at our call site, so the
    // call itself is banned alongside the content mutators.
    expect(code).not.toMatch(/\.sendText\(|\.sendMedia\(|\.readHistory\(|\.deleteMessages\(|\.editMessage\(|\.setTyping\(|\.setOnline\(/)
    // The contact list is READ (getContacts) and never written: mtcute has
    // wrappers for all four contact mutations, and listContacts() sitting next
    // to them is exactly why they are banned by name.
    expect(code).not.toMatch(/\.addContact\(|\.importContacts\(|\.deleteContacts\(|\.setContactNote\(/)
    // logOut() is the one sanctioned mutation: auth.logOut destroys only OUR
    // OWN access — no content, no other device, no profile data.
    expect(code).toMatch(/\.logOut\(\)/)
  })

  it('goes invisible and never visible', () => {
    expect(code).toMatch(/offline:\s*true/)
    expect(code).not.toMatch(/offline:\s*false/)
  })

  it('bounds every RPC that runs on a manager tick', () => {
    // mtcute defaults to `timeout: Infinity`, and every call here is awaited
    // inside reconcileActive — an unanswered one wedges the tick, and with it
    // SIGTERM. The raw call carries its own timeout; getMe() and logOut()
    // take no per-call options, so they inherit one through withParams.
    expect(code).toMatch(/account\.updateStatus[\s\S]{0,80}timeout: RPC_TIMEOUT_MS/)
    expect(code).toMatch(/withParams\(\{ timeout: RPC_TIMEOUT_MS \}\)\.getMe\(\)/)
    expect(code).toMatch(/withParams\(\{ timeout: RPC_TIMEOUT_MS \}\)\.logOut\(\)/)
    expect(code).toMatch(/withParams\(\{ timeout: RPC_TIMEOUT_MS \}\)\.getContacts\(\)/)
    // No unbounded survivor of either call.
    expect(code).not.toMatch(/(?<!withParams\(\{ timeout: RPC_TIMEOUT_MS \}\))\.getMe\(\)/)
  })

  it('never reaches for the log-out-everywhere primitive', () => {
    // auth.resetAuthorizations is a DIFFERENT MTProto call from the one
    // logOut() wraps, and it would kill the owner's other devices.
    expect(code).not.toMatch(/resetAuthorizations/)
  })
})
