import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { KEY_PLACEHOLDER, claudeCodeCommand, mcpServersJson, mcpUrlFrom } from '@/lib/mcp/client-config'

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
      .toBe('claude mcp add --transport http steno https://steno.example.org/mcp --header "Authorization: Bearer sp_abc"')
  })

  it('the JSON config is valid and carries the bearer header', () => {
    const parsed = JSON.parse(mcpServersJson(url, 'sp_abc')) as {
      mcpServers: { steno: { type: string; url: string; headers: Record<string, string> } }
    }
    expect(parsed.mcpServers.steno).toEqual({
      type: 'http',
      url,
      headers: { Authorization: 'Bearer sp_abc' },
    })
    expect(mcpServersJson(url, 'sp_abc')).toContain('\n') // pretty-printed, not one line
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
  })

  it('is rendered from the settings page with the minted key', () => {
    const src = readFileSync('app/settings/page.tsx', 'utf8')
    expect(src).toContain('<ConnectAgent')
    expect(src).toMatch(/rawKey=\{minted\?\.rawKey \?\? null\}/)
  })

  it('never puts the key in a URL', () => {
    const src = readFileSync('app/settings/connect-agent.tsx', 'utf8')
    expect(src).not.toMatch(/href=\{[^}]*rawKey/)
    expect(src).not.toMatch(/\?key=/)
  })
})
