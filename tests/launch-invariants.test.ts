import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'

// A repo-wide sweep, not a unit test. It exists because the promises this
// project makes (AGPL, no telemetry, no cloud storage, one importer per chat
// library, an honest WhatsApp warning) are the product on the open-source
// side, and every one of them is a single careless import or paragraph edit
// away from being false.

const SOURCE_ROOTS = ['lib', 'app', 'worker', 'scripts']
const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.mjs', '.js'])

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue
      out.push(...walk(full))
    } else if (SOURCE_EXT.has(path.extname(entry))) {
      out.push(full)
    }
  }
  return out
}

const sourceFiles = SOURCE_ROOTS.flatMap(walk)

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
  // The exact three sentences from the consent screen (shared-interfaces,
  // "Consent copy"). The README must say what the user is told before
  // pairing, word for word, so nobody discovers it only after the QR.
  const SENTENCES = [
    'WhatsApp does not permit unofficial clients.',
    'Your number can be restricted or banned, and your phone will show an unofficial-client notice under Linked devices.',
    'The risk is higher when this runs on a cloud host than on a machine at home.',
  ]

  it('README contains all three sentences verbatim', () => {
    const readme = readFileSync('README.md', 'utf8')
    for (const s of SENTENCES) expect(readme).toContain(s)
  })
})

describe('no telemetry, no cloud identity, one importer per chat library', () => {
  const BANNED_EVERYWHERE = ['@/lib/services/analytics', 'posthog', '@mocanetwork']
  const SCOPED = [
    { needle: 'mtcute', allowed: 'lib/channels/telegram.ts' },
    { needle: 'baileys', allowed: 'lib/channels/whatsapp.ts' },
  ]

  it('finds source files to check', () => {
    expect(sourceFiles.length).toBeGreaterThan(5)
  })

  it('nothing imports analytics, PostHog, or Moca', () => {
    const offenders: string[] = []
    for (const file of sourceFiles) {
      for (const spec of importedModules(readFileSync(file, 'utf8'))) {
        if (BANNED_EVERYWHERE.some(b => spec.includes(b))) offenders.push(`${file} -> ${spec}`)
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

  it('no analytics package', () => {
    expect(names.filter(n => n.startsWith('posthog'))).toEqual([])
  })

  it('no Moca package', () => {
    expect(names.filter(n => n.startsWith('@mocanetwork/'))).toEqual([])
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

  it('the Railway template URL is the only placeholder in the repo docs', () => {
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
    // The one sanctioned placeholder, and only in the README.
    expect(readFileSync('README.md', 'utf8')).toContain('<RAILWAY_TEMPLATE_URL>')
  })

  it('SECURITY.md points at GitHub private reporting and offers no email', () => {
    const src = readFileSync('SECURITY.md', 'utf8')
    expect(src).toContain('Report a vulnerability')
    expect(src).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
  })
})
