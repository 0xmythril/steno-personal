import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const PORT_FILE = path.join(ROOT, 'lib/channels/whatsapp.ts')
const SELF = path.join(ROOT, 'tests/whatsapp-structure.test.ts')
const SKIP_DIRS = new Set(['node_modules', 'data', 'coverage', 'dist', 'drizzle', 'docs'])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    // Dot-directories are tooling state (.next, .git, .claude/worktrees with
    // whole extra checkouts of this repo), never source.
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(entry)) out.push(full)
  }
  return out
}

// Spec invariant 2: one importer per library. A repo-wide walk, not an import
// graph, because a lazy require or a re-export would slip past a graph.
describe('only lib/channels/whatsapp.ts may reach for Baileys', () => {
  it('no other source file names the package', () => {
    const needle = ['@whiskeysockets', 'baileys'].join('/')
    const offenders = walk(ROOT)
      .filter(f => f !== PORT_FILE && f !== SELF)
      .filter(f => readFileSync(f, 'utf8').includes(needle))
      .map(f => path.relative(ROOT, f))
    expect(offenders).toEqual([])
  })
})

// Spec invariant 3: invisible. Nothing user-visible is ever sent.
describe('the WhatsApp port sends nothing', () => {
  const src = () => readFileSync(PORT_FILE, 'utf8')
  // The first seven are sends. The last three are READS that would still be
  // new traffic to WhatsApp on the owner's behalf: listContacts() answers out
  // of the map the phone already pushes, and "no new WhatsApp call" is a
  // promise of this branch, not a convention.
  const BANNED = [
    'sendMessage(', 'sendPresenceUpdate(', 'readMessages(', 'sendReceipt(', 'sendReceipts(',
    'chatModify(', 'updateProfile',
    'onWhatsApp(', 'fetchStatus(', 'getBusinessProfile(',
  ]

  for (const call of BANNED) {
    it(`never calls ${call}`, () => {
      expect(src()).not.toContain(call)
    })
  }

  it('opens every socket with markOnlineOnConnect: false', () => {
    expect(src()).toContain('markOnlineOnConnect: false')
    expect(src()).not.toContain('markOnlineOnConnect: true')
  })

  it('keeps emitOwnEvents on so the owner’s own messages archive', () => {
    expect(src()).toContain('emitOwnEvents: true')
  })

  // History depth is asked for by syncFullHistory alone. The desktop browser
  // tuple this file used to carry is what WhatsApp terminates on (close code
  // 428, before any QR), so it must stay gone: Baileys' default tuple pairs.
  it('still asks for full history', () => {
    expect(src()).toContain('syncFullHistory')
  })

  it('never identifies as a desktop client', () => {
    expect(src()).not.toContain("'Desktop'")
  })
})

// Filled in by Task 6 and Task 7. Guarded so this file is green in between.
describe('wiring', () => {
  it('the port registry registers the WhatsApp port', () => {
    // lib/channels/ports.ts, not worker/index.ts: M1 moved the registry out of
    // the worker (importing the worker starts its tick loop), so this is the
    // file that has to name the port.
    const src = readFileSync(path.join(ROOT, 'lib/channels/ports.ts'), 'utf8')
    if (!src.includes('BaileysWhatsAppPort')) return
    expect(src).toMatch(/ports\.set\(\s*'whatsapp'/)
  })

  it('the connections page carries the WhatsApp consent sentences verbatim', () => {
    const file = path.join(ROOT, 'app/connections/whatsapp-consent.tsx')
    if (!existsSync(file)) return
    const src = readFileSync(file, 'utf8')
    for (const sentence of [
      'This connects through an unofficial WhatsApp client.',
      'Use it at your own risk.',
    ]) {
      expect(src).toContain(sentence)
    }
    expect(src).toMatch(/from '\.\/consent'/)
  })

  it('the connections page no longer gates WhatsApp behind "not available yet"', () => {
    // Guarded the same way as the sentence check above: Task 7 is what
    // removes the placeholder, so this stays inert (and green) until then.
    const consentFile = path.join(ROOT, 'app/connections/whatsapp-consent.tsx')
    if (!existsSync(consentFile)) return
    const src = readFileSync(path.join(ROOT, 'app/connections/page.tsx'), 'utf8')
    expect(src).not.toContain('not available yet')
  })
})
