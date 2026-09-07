import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (f: string) => readFileSync(f, 'utf8')

// This file grows: later tasks in the sources-ui plan add describe blocks
// here for the connections page (Task 3) and the MCP push tool (Task 4).

describe('chats page', () => {
  it('imports listSources', () => {
    const src = read('app/page.tsx')
    expect(src).toMatch(/import\s*\{[^}]*\blistSources\b[^}]*\}\s*from\s*'@\/lib\/services\/connections'/)
  })

  it('renders a filter chip per source, linking to ?source=<id>', () => {
    const src = read('app/page.tsx')
    expect(src).toMatch(/sources\.map\(/)
    expect(src).toMatch(/href=\{`\/\?source=\$\{s\.id\}`\}/)
  })

  it('reads sp.source and passes sourceId to listChats', () => {
    const src = read('app/page.tsx')
    expect(src).toMatch(/sp\.source/)
    expect(src).toMatch(/listChats\(\{[^}]*sourceId[^}]*\}\)/)
  })

  it('marks a pushed chat with the note chip', () => {
    const src = read('app/page.tsx')
    expect(src).toMatch(/pushers\.length > 0/)
    expect(src).toMatch(/<span className="chip note">/)
  })

  it('source chips follow the filter rule: the current one plain, the rest filter, never off', () => {
    const src = read('app/page.tsx')
    // Anchor on the block itself: an assertion that only looks at the whole
    // file would pass on the channel row alone, feature deleted or not.
    const block = src.slice(src.indexOf('sources.map('))
    expect(block, 'the sources block exists').toContain('sources.map(')
    const chips = [...block.matchAll(/className="(chip[^"]*)"/g)].map(m => m[1])
    expect(chips).toContain('chip')
    expect(chips).toContain('chip filter')
    expect(chips.some(c => c.includes('off'))).toBe(false)
  })

  it('carries no colour literal', () => {
    const src = read('app/page.tsx')
    expect(src).not.toMatch(/#[0-9a-f]{3,6}\b/i)
  })
})

describe('transcript page', () => {
  const path = 'app/chats/[id]/page.tsx'

  it('imports listSources and formatRelativeTime for push provenance', () => {
    const src = read(path)
    expect(src).toMatch(/import\s*\{[^}]*\blistSources\b[^}]*\}\s*from\s*'@\/lib\/services\/connections'/)
    expect(src).toMatch(/import\s*\{[^}]*\bformatRelativeTime\b[^}]*\}\s*from\s*'@\/lib\/format'/)
  })

  it('marks a pushed chat with the note chip in the pad-head, naming who pushed it', () => {
    const src = read(path)
    // Anchor on the pad-head block itself, not the whole file: an assertion
    // that only looks at the whole file would pass on unrelated text alone,
    // feature deleted or not.
    const head = src.slice(src.indexOf('pad-head'), src.indexOf('{pager}'))
    expect(head, 'the pad-head block exists').toContain('pad-head')
    expect(head).toMatch(/pushers\.length > 0/)
    expect(head).toMatch(/<span className="chip note">/)
    expect(head).toMatch(/Pushed by/)
  })

  it('shows the last push time and conflict count from the source, in the pad-head', () => {
    const src = read(path)
    const head = src.slice(src.indexOf('pad-head'), src.indexOf('{pager}'))
    expect(head).toMatch(/last push/)
    expect(head).toMatch(/conflicts?/)
  })

  it('marks each run with who pushed it, only when more than one pusher delivered to this chat', () => {
    const src = read(path)
    expect(src).toMatch(/pushers\.length > 1/)
    expect(src).toMatch(/<span className="pushed-via">via /)
  })

  it('still offers no way to send anything', () => {
    const src = read(path)
    expect(src).not.toMatch(/<textarea|<form|type=["']submit["']|<input/)
  })

  it('carries no colour literal', () => {
    const src = read(path)
    expect(src).not.toMatch(/#[0-9a-f]{3,6}\b/i)
  })
})
