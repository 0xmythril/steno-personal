import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// The Connect-your-agent panel holds long, unbreakable lines (an MCP URL, a
// JSON config, a paste-in prompt). Its shape is what keeps them from pushing
// the page sideways or hiding the Fill in button off the right edge.
describe('the connect-agent panel', () => {
  const src = readFileSync('app/settings/connect-agent.tsx', 'utf8')
  const css = readFileSync('app/globals.css', 'utf8')

  it('grid columns can shrink below their longest line', () => {
    // A 1fr track is minmax(auto, 1fr): without min-width: 0 on the items, a
    // <pre> or a token field sets the column's floor at its longest line.
    expect(css).toMatch(/\.two-up > \*\s*\{[^}]*min-width:\s*0/)
  })

  it('offers two ways in, not one per vendor: the agent prompt, open, and the standard config', () => {
    // The paste-in prompt already carries the Claude Code command and the
    // Cursor path, so per-client blocks only repeat it. What it cannot cover
    // is a client that cannot edit its own config (Claude Desktop), which
    // gets the one standard mcpServers JSON block.
    const details = src.match(/<details/g) ?? []
    expect(details.length).toBe(2)
    expect(src).toMatch(/<details className="snippet" open>[\s\S]*?<pre>\{prompt\}/)
    expect(src).toMatch(/<details className="snippet">[\s\S]*?<pre>\{json\}[\s\S]*?<pre>\{command\}/)
    expect(src).toMatch(/<summary[\s\S]*?<CopyButton/)
  })

  it('choosing a key fills the snippets in without a second click', () => {
    expect(src).toMatch(/<AutoSubmit>[\s\S]*<select name="keyId"[\s\S]*<\/AutoSubmit>/)
    const auto = readFileSync('app/settings/auto-submit.tsx', 'utf8')
    expect(auto).toMatch(/^'use client'/)
    expect(auto).toContain('requestSubmit()')
  })

  // Was: "well fill, not transparent". The well fill did make a button visible,
  // but .token, code and pre share that fill, so a read-only key rendered as the
  // same object as the Reveal button beside it. The promise is unchanged — a bare
  // button must read as a control — and the mechanism is now the edge outline,
  // which nothing static is allowed to carry. See DESIGN.md, Colors → Rules.
  it('a bare button reads as a control on both palettes: an edge outline, which no readout has', () => {
    expect(css).toMatch(/^button, \.btn \{[^}]*border: 1px solid var\(--edge\)/m)
    const token = css.match(/^\.token \{([^}]*)\}/m)?.[1] ?? ''
    expect(token).toMatch(/background: var\(--well\)/)
    expect(token, '.token shares the well fill but must not carry a border').not.toMatch(/\bborder\s*:/)
  })

  it('the MCP URL readout and the Copy URL button beside it are not the same object', () => {
    expect(src).toMatch(/<span className="token"><code>\{mcpUrl\}<\/code> <CopyButton/)
    const token = css.match(/^\.token \{([^}]*)\}/m)?.[1] ?? ''
    expect(token).not.toMatch(/\bborder\s*:/)
  })
})
