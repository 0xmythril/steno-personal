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
