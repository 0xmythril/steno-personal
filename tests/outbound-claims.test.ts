import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

// The promise in PRIVACY.md is that everything which can leave the machine at
// runtime is named, and CONTRIBUTING rule 3 and the threat model repeat it.
// Twice now a document kept saying "no update check" after the code grew one.
// This sweep derives the destinations from the server-side source and holds
// every document that makes the claim to the same list, so the next drift
// fails CI instead of a reader's trust.

// Hosts the process itself talks to, and the name each document uses for
// them. Telegram and WhatsApp are the archive's own channels and are excluded
// on purpose: their traffic is what a chat client is.
const DESTINATIONS: Record<string, string> = {
  'openrouter.ai': 'OpenRouter',      // enrichment, off until a key is saved
  'us.i.posthog.com': 'PostHog',      // anonymous usage events, off in Settings
  'api.github.com': 'GitHub',         // release check, only on a click
  'ghcr.io': 'GHCR',                  // image pull by Docker, only on a click
}

// Hostnames that appear in server code without a byte being sent to them.
// Each entry needs a reason; an unexplained host is a new outbound call.
const NOT_A_DESTINATION: Record<string, string> = {
  'www.w3.org': 'the SVG namespace attribute in lib/qrcode.ts',
  'github.com': 'the release-notes link Settings shows, built in updater/releases.mjs; the browser follows it, the process never fetches it',
}
// Loopback is the app talking to itself (readiness probes, the supervisor).
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|0\.0\.0\.0|\[?::1\]?)$/

// Where the sweep looks: everything that runs on the server. Pages and
// components under app/ only render links, so they are limited to route
// handlers and server actions.
const SERVER_ROOTS = ['lib', 'worker', 'updater', 'scripts']
const SERVER_APP_FILES = /(^|\/)(route|actions)\.tsx?$/
const SOURCE_EXT = new Set(['.ts', '.tsx', '.mjs', '.js', '.sh'])

function walk(dir: string, keep: (file: string) => boolean): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, keep))
    else if (SOURCE_EXT.has(path.extname(entry)) && keep(full)) out.push(full)
  }
  return out
}

// Drops block comments and line comments. A "//" inside a URL is preceded by
// ":", so only "//" that is not is treated as a comment.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(line => {
    const at = line.search(/(^|[^:])\/\//)
    return at < 0 ? line : line.slice(0, at + (line[at] === '/' ? 0 : 1))
  }).join('\n')
}

const serverFiles = [
  ...SERVER_ROOTS.flatMap(root => walk(root, () => true)),
  ...walk('app', file => SERVER_APP_FILES.test(file)),
]

function hostsInSource(): Map<string, string[]> {
  const hosts = new Map<string, string[]>()
  const note = (host: string, file: string) => hosts.set(host, [...(hosts.get(host) ?? []), file])
  for (const file of serverFiles) {
    const src = stripComments(readFileSync(file, 'utf8'))
    for (const m of src.matchAll(/\bhttps?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)) {
      const host = m[1].toLowerCase()
      if (!LOOPBACK.test(host)) note(host, file)
    }
    // Image references carry no scheme: "ghcr.io/owner/repo".
    for (const m of src.matchAll(/(?:^|[\s'"`=(])((?:ghcr|docker)\.io)\//gm)) note(m[1], file)
  }
  return hosts
}

const section = (text: string, from: RegExp, to: RegExp): string => {
  const start = text.search(from)
  expect(start, `section ${from} not found`).toBeGreaterThanOrEqual(0)
  const rest = text.slice(start)
  const end = rest.slice(1).search(to)
  return end < 0 ? rest : rest.slice(0, end + 1)
}

describe('what leaves the machine', () => {
  const hosts = hostsInSource()

  it('the code reaches only the destinations the documents name', () => {
    const unexplained = [...hosts]
      .filter(([host]) => !(host in DESTINATIONS) && !(host in NOT_A_DESTINATION))
      .map(([host, files]) => `${host} in ${files.join(', ')}`)
    expect(unexplained, 'a hostname in server code that no document names; add it to PRIVACY.md, CONTRIBUTING rule 3 and the threat model, then to DESTINATIONS').toEqual([])
  })

  it('every listed destination is still reached by the code', () => {
    // Otherwise the list rots the other way and the documents over-claim.
    const gone = Object.keys(DESTINATIONS).filter(host => !hosts.has(host))
    expect(gone, 'a destination the documents name but the code no longer contacts').toEqual([])
    const stale = Object.keys(NOT_A_DESTINATION).filter(host => !hosts.has(host))
    expect(stale, 'an allowlisted host that no longer appears in the code').toEqual([])
  })

  // The documents that promise the list, and the part of each that does.
  const claims: Record<string, string> = {
    'PRIVACY.md': section(readFileSync('PRIVACY.md', 'utf8'), /^## What leaves your machine/m, /^## /m),
    'CONTRIBUTING.md': section(readFileSync('CONTRIBUTING.md', 'utf8'), /^3\. \*\*/m, /^4\. \*\*/m),
    'docs/threat-model.md': readFileSync('docs/threat-model.md', 'utf8'),
  }

  for (const [file, text] of Object.entries(claims)) {
    it(`${file} names every destination`, () => {
      const missing = Object.values(DESTINATIONS).filter(name => !text.includes(name))
      expect(missing, `${file} does not name`).toEqual([])
    })
  }

  it('no document still describes the list as it used to be', () => {
    const docs = ['README.md', 'PRIVACY.md', 'CONTRIBUTING.md', 'SECURITY.md',
      ...readdirSync('docs').filter(f => f.endsWith('.md')).map(f => `docs/${f}`)]
    const stale = [
      /\bno update checks?\b/i,          // there is one, on a click, since v0.3.0
      /\btwo things can leave\b/i,       // four hosts now
      /\bexactly two things\b/i,
      /\bboth listed and both switchable\b/i,
      /\bnothing else leaves\b/i,
    ]
    const offenders: string[] = []
    for (const file of docs) {
      const text = readFileSync(file, 'utf8')
      for (const re of stale) if (re.test(text)) offenders.push(`${file}: ${re.source}`)
    }
    expect(offenders).toEqual([])
  })
})
