import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'

// A repo-wide sweep, not a unit test. It exists because the promises this
// project makes (AGPL, no telemetry, no cloud storage, one importer per chat
// library, an honest WhatsApp warning) are the product on the open-source
// side, and every one of them is a single careless import or paragraph edit
// away from being false.

const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.mjs', '.js'])
// Everything at the top level that is not source: build output, git, the
// working documents, and the two directories whose own content is allowed to
// name the things banned below (a test asserting "nothing imports posthog"
// must not be an offender itself; the docs quote package names in prose).
const NOT_SOURCE = new Set(['node_modules', 'tests', 'docs'])
// Every dot-directory is tooling state, never source: .next, .git,
// .superpowers, and .claude — whose worktrees/ holds whole extra checkouts of
// this repo that would otherwise be swept as second importers.
const isSource = (entry: string) => !NOT_SOURCE.has(entry) && !entry.startsWith('.')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (!isSource(entry)) continue
      out.push(...walk(full))
    } else if (SOURCE_EXT.has(path.extname(entry))) {
      out.push(full)
    }
  }
  return out
}

// Derived, not listed: a hard-coded set of roots means a file added under a
// new top-level directory is invisible to every sweep below, which is exactly
// the regression this file exists to catch. Every top-level directory except
// NOT_SOURCE, plus the top-level source files themselves.
const sourceFiles = readdirSync('.')
  .filter(isSource)
  .flatMap(entry => (statSync(entry).isDirectory()
    ? walk(entry)
    : SOURCE_EXT.has(path.extname(entry)) ? [entry] : []))

// Matches `import ... from 'x'`, `import 'x'`, `require('x')`, `import('x')`.
function importedModules(src: string): string[] {
  const specs: string[] = []
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const re of patterns) {
    for (const m of src.matchAll(re)) specs.push(m[1])
  }
  return specs
}

describe('licence', () => {
  it('LICENSE starts with the AGPL-3.0 header', () => {
    const head = readFileSync('LICENSE', 'utf8').slice(0, 400)
    expect(head).toContain('GNU AFFERO GENERAL PUBLIC LICENSE')
    expect(head).toContain('Version 3, 19 November 2007')
  })

  it('package.json declares AGPL-3.0-only', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(pkg.license).toBe('AGPL-3.0-only')
  })
})

describe('the WhatsApp warning is on the front page', () => {
  // The exact sentences from the consent screen
  // (app/connections/whatsapp-consent.tsx). The README must say what the user
  // is told before pairing, word for word, so nobody discovers it only after
  // the QR.
  const SENTENCES = [
    'This connects through an unofficial WhatsApp client.',
    'Use it at your own risk.',
  ]

  it('README contains the consent sentences verbatim', () => {
    const readme = readFileSync('README.md', 'utf8')
    for (const s of SENTENCES) expect(readme).toContain(s)
  })
})

// The analytics, telemetry and crash-reporting SDKs we know of, matched as a
// prefix of an import specifier and of a package name. It is a known-names
// list, not a general outbound-traffic guard: a bare fetch() to a telemetry
// endpoint is not caught by it, and PRIVACY.md says so rather than claiming
// more than this list delivers.
const BANNED_EVERYWHERE = [
  '@/lib/services/analytics', '@mocanetwork',
  'posthog', 'mixpanel', '@segment/', 'analytics-node',
  '@sentry/', '@amplitude/', '@vercel/analytics', 'plausible',
]
const isBanned = (name: string): boolean =>
  BANNED_EVERYWHERE.some(b => name === b || name.startsWith(b))

describe('no telemetry, no cloud identity, one importer per chat library', () => {
  const SCOPED = [
    { needle: 'mtcute', allowed: 'lib/channels/telegram.ts' },
    { needle: 'baileys', allowed: 'lib/channels/whatsapp.ts' },
  ]

  it('finds source files to check', () => {
    expect(sourceFiles.length).toBeGreaterThan(5)
  })

  it('nothing imports an analytics, telemetry or cloud-identity module', () => {
    const offenders: string[] = []
    for (const file of sourceFiles) {
      for (const spec of importedModules(readFileSync(file, 'utf8'))) {
        if (isBanned(spec)) offenders.push(`${file} -> ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('only the two channel files import their chat library', () => {
    const offenders: string[] = []
    for (const file of sourceFiles) {
      const normalised = file.split(path.sep).join('/')
      for (const spec of importedModules(readFileSync(file, 'utf8'))) {
        for (const { needle, allowed } of SCOPED) {
          if (spec.includes(needle) && normalised !== allowed) offenders.push(`${file} -> ${spec}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('dependencies', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const names = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ]

  it('no analytics, telemetry or cloud-identity package', () => {
    expect(names.filter(isBanned)).toEqual([])
  })

  it('no Postgres driver', () => {
    expect(names.filter(n => n === 'postgres' || n === 'pg')).toEqual([])
  })
})

describe('launch documents', () => {
  const REQUIRED = [
    'README.md',
    'PRIVACY.md',
    'SECURITY.md',
    'CHANGELOG.md',
    'docs/architecture.md',
    'docs/self-hosting.md',
    'docs/threat-model.md',
    'scripts/smoke.sh',
  ]

  for (const file of REQUIRED) {
    it(`${file} exists and is not a stub`, () => {
      expect(existsSync(file)).toBe(true)
      expect(readFileSync(file, 'utf8').length).toBeGreaterThan(400)
    })
  }

  it('no placeholder marker survives in the repo docs, and the Railway button is real', () => {
    const docs = ['README.md', 'PRIVACY.md', 'SECURITY.md', 'CHANGELOG.md',
      'docs/architecture.md', 'docs/self-hosting.md', 'docs/threat-model.md']
    const offenders: string[] = []
    for (const file of docs) {
      const src = readFileSync(file, 'utf8')
      for (const marker of ['TODO', 'TBD', 'FIXME', 'XXX', 'COMING SOON', 'lorem ipsum']) {
        if (src.includes(marker)) offenders.push(`${file}: ${marker}`)
      }
    }
    expect(offenders).toEqual([])
    // The Deploy button must point at a real template, never at a placeholder.
    const readme = readFileSync('README.md', 'utf8')
    expect(readme).toContain('https://railway.com/new/template/')
    expect(readme).not.toContain('RAILWAY_TEMPLATE_URL')
  })

  it('SECURITY.md points at GitHub private reporting and offers no email', () => {
    const src = readFileSync('SECURITY.md', 'utf8')
    expect(src).toContain('Report a vulnerability')
    expect(src).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
  })
})
