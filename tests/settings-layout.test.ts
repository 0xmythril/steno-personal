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
    // gets the one standard mcpServers JSON block. A third, conditional block
    // is the push door's own config — shown only for a key that can push.
    const details = src.match(/<details/g) ?? []
    expect(details.length).toBe(3)
    expect(src).toMatch(/<details className="snippet" open>[\s\S]*?<pre>\{prompt\}/)
    expect(src).toMatch(/<details className="snippet">[\s\S]*?<pre>\{json\}[\s\S]*?<pre>\{command\}/)
    expect(src).toMatch(/<summary[\s\S]*?<CopyButton/)
  })

  it('the push snippet is gated on the selected key being able to push', () => {
    expect(src).toMatch(/\{pushUrl && pushCommand && pushJson && \([\s\S]*?<details className="snippet">[\s\S]*?<\/details>\s*\)\}/)
  })

  // A push-only key admitted to the selector (see settings-structure.test.ts)
  // must not fall through to a read snippet: it would carry a key that 401s
  // on every read tool. This replaces the deleted case "never offers a
  // push-only key to the connect-an-agent snippets" — the promise is now
  // kept by gating, not by excluding the key from the list.
  it('the agent-setup prompt and standard-config blocks are gated on the selected key being able to read, not on it being able to push', () => {
    // Anchored to the two read blocks themselves: a whole-file regex would
    // still pass if a gate were dropped from one block but not the other, or
    // if canPush leaked into a read gate.
    const readRegion = src.slice(src.indexOf('{canRead && ('), src.indexOf('{pushUrl && pushCommand && pushJson && ('))
    expect(readRegion, 'the read-gated region exists').toContain('{canRead && (')
    expect(readRegion.match(/\{canRead && \(/g)?.length, 'both read blocks carry their own canRead gate').toBe(2)
    expect(readRegion).toMatch(/\{canRead && \(\s*<details className="snippet" open>[\s\S]*?<pre>\{prompt\}[\s\S]*?<\/details>\s*\)\}/)
    expect(readRegion).toMatch(/\{canRead && \(\s*<details className="snippet">[\s\S]*?<pre>\{json\}[\s\S]*?<pre>\{command\}[\s\S]*?<\/details>\s*\)\}/)
    expect(readRegion, 'a read block must not also test canPush').not.toMatch(/canPush/)
  })

  it('the read gates and the push gate are three distinct booleans, so a future edit cannot re-couple them', () => {
    const pushGateIndex = src.indexOf('{pushUrl && pushCommand && pushJson && (')
    expect(pushGateIndex, 'the push gate exists').toBeGreaterThan(-1)
    const pushRegion = src.slice(pushGateIndex, src.indexOf('</details>', pushGateIndex) + '</details>'.length)
    expect(pushRegion, 'the push gate must not also test canRead').not.toMatch(/canRead/)
    // canRead and canPush are each computed from the selected row's own
    // field, not from one another — a push-only key (canRead false, canPush
    // true) therefore shows the push block and nothing else.
    expect(src).toMatch(/const canRead = rawKey \? \(selected\?\.canRead \?\? false\) : true/)
    expect(src).toMatch(/const canPush = rawKey \? \(selected\?\.canPush \?\? false\) : true/)
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
