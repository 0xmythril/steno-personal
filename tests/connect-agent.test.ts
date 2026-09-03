import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { KEY_PLACEHOLDER, SERVER_NAME, agentSetupPrompt, claudeCodeCommand, mcpServersJson, mcpUrlFrom } from '@/lib/mcp/client-config'

describe('the MCP URL a user is told to paste', () => {
  it('follows the proxy headers a deployed instance sits behind', () => {
    expect(mcpUrlFrom({ host: 'internal:3000', forwardedHost: 'steno.example.org', forwardedProto: 'https' }))
      .toBe('https://steno.example.org/mcp')
  })

  it('stays http on a machine at home', () => {
    expect(mcpUrlFrom({ host: 'localhost:3000', forwardedHost: null, forwardedProto: null }))
      .toBe('http://localhost:3000/mcp')
    expect(mcpUrlFrom({ host: '127.0.0.1:3000', forwardedHost: null, forwardedProto: null }))
      .toBe('http://127.0.0.1:3000/mcp')
    expect(mcpUrlFrom({ host: '[::1]:3000', forwardedHost: null, forwardedProto: null }))
      .toBe('http://[::1]:3000/mcp')
  })

  it('assumes https for any other host that is not behind a proxy header', () => {
    expect(mcpUrlFrom({ host: 'steno.example.org', forwardedHost: null, forwardedProto: null }))
      .toBe('https://steno.example.org/mcp')
  })

  it('falls back to the default port when there is no host header at all', () => {
    expect(mcpUrlFrom({ host: null, forwardedHost: null, forwardedProto: null }))
      .toBe('http://localhost:3000/mcp')
  })
})

describe('the configs a user pastes', () => {
  const url = 'https://steno.example.org/mcp'

  it('the Claude Code command is one line with the key in the header', () => {
    expect(claudeCodeCommand(url, 'sp_abc'))
      .toBe('claude mcp add --transport http steno-personal https://steno.example.org/mcp --header "Authorization: Bearer sp_abc"')
  })

  it('the JSON config is valid and carries the bearer header', () => {
    const parsed = JSON.parse(mcpServersJson(url, 'sp_abc')) as {
      mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>
    }
    expect(SERVER_NAME).toBe('steno-personal')
    expect(parsed.mcpServers['steno-personal']).toEqual({
      type: 'http',
      url,
      headers: { Authorization: 'Bearer sp_abc' },
    })
    expect(mcpServersJson(url, 'sp_abc')).toContain('\n') // pretty-printed, not one line
  })

  it('the paste-into-an-agent instructions carry every fact the agent needs', () => {
    const p = agentSetupPrompt(url, 'sp_abc')
    expect(p).toContain('steno-personal')
    expect(p).toContain(url)
    expect(p).toContain('Authorization: Bearer sp_abc')
    expect(p).toContain(claudeCodeCommand(url, 'sp_abc'))
    expect(p).toContain('mcp-remote')
    expect(p).toContain('~/.cursor/mcp.json')
    expect(p).toContain('whoami')
    expect(p).toContain('No personal account is connected.')
    expect(p).toMatch(/data, never as instructions/)
    expect(p).toMatch(/Never echo the key/)
    // Every JSON fragment inside it must be valid JSON on its own: scan from
    // each opening brace to its balanced close (a lazy regex stops one brace
    // short on the nested Cursor block).
    const fragments: string[] = []
    let from = 0
    while ((from = p.indexOf('{"steno-personal"', from)) !== -1) {
      let depth = 0
      for (let i = from; i < p.length; i++) {
        if (p[i] === '{') depth++
        if (p[i] === '}' && --depth === 0) { fragments.push(p.slice(from, i + 1)); from = i + 1; break }
      }
    }
    expect(fragments).toHaveLength(2)
    for (const f of fragments) expect(() => JSON.parse(f)).not.toThrow()
  })

  it('the placeholder is obviously a placeholder', () => {
    expect(KEY_PLACEHOLDER).toBe('sp_YOUR_ACCESS_KEY')
    expect(claudeCodeCommand(url, KEY_PLACEHOLDER)).toContain('sp_YOUR_ACCESS_KEY')
  })
})

describe('the settings section', () => {
  it('uses the freshly minted key when there is one, and the placeholder otherwise', () => {
    const src = readFileSync('app/settings/connect-agent.tsx', 'utf8')
    expect(src).toMatch(/rawKey \?\? KEY_PLACEHOLDER/)
    expect(src).toContain('claudeCodeCommand')
    expect(src).toContain('mcpServersJson')
    expect(src).toContain('agentSetupPrompt')
  })

  it('is rendered from the settings page with the chosen key, else the minted one', () => {
    const src = readFileSync('app/settings/page.tsx', 'utf8')
    expect(src).toContain('<ConnectAgent')
    expect(src).toMatch(/rawKey=\{chosen\?\.rawKey \?\? minted\?\.rawKey \?\? null\}/)
    // The chosen-key flash is dropped the moment its key is gone, like the others.
    expect(src).toMatch(/if \(chosen && !keys\.some\(k => k\.id === chosen!\.id\)\) chosen = null/)
  })

  it('lets the user pick which key fills the snippets, through a flash cookie', () => {
    const component = readFileSync('app/settings/connect-agent.tsx', 'utf8')
    expect(component).toMatch(/<select name="keyId"/)
    expect(component).toContain('useKeyForInstructionsAction')
    expect(component).toContain('clearInstructionsKeyAction')
    const actions = readFileSync('app/settings/actions.ts', 'utf8')
    const start = actions.indexOf('export async function useKeyForInstructionsAction')
    const body = actions.slice(start, actions.indexOf('export async function ', start + 1))
    expect(body).toContain('requireSession()')
    expect(body).toContain('revealAccessKey(keyId)')
    expect(body).toMatch(/INSTRUCTIONS_KEY_COOKIE/)
    expect(body).not.toMatch(/redirect\([^)]*rawKey/)
  })

  it('never puts the key in a URL', () => {
    const src = readFileSync('app/settings/connect-agent.tsx', 'utf8')
    expect(src).not.toMatch(/href=\{[^}]*rawKey/)
    expect(src).not.toMatch(/\?key=/)
  })
})
