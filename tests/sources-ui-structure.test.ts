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

  it('the current filter chip is a plain chip, the rest are filter chips', () => {
    const src = read('app/page.tsx')
    expect(src).toMatch(/className="chip"/)
    expect(src).toMatch(/className="chip filter"/)
  })

  it('carries no colour literal', () => {
    const src = read('app/page.tsx')
    expect(src).not.toMatch(/#[0-9a-f]{3,6}\b/i)
  })
})
