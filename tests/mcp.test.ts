import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from './helpers/db'
import { seedConnection } from './helpers/archive'
import { callTool, listTools, mcpRequest } from './helpers/mcp'
import { mintAccessKey } from '@/lib/services/access-keys'
import { POST } from '@/app/mcp/route'

async function agentKey(label = 'agent'): Promise<string> {
  const r = await mintAccessKey(label)
  if (!r.ok) throw new Error(r.reason)
  return r.rawKey
}

describe('MCP bearer auth', () => {
  beforeEach(resetDb)

  it('401s a missing, unknown, or revoked key', async () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    expect((await POST(mcpRequest('', body))).status).toBe(401)
    expect((await POST(mcpRequest('sp_not_a_real_key', body))).status).toBe(401)
    expect((await POST(mcpRequest('definitely-not-prefixed', body))).status).toBe(401)
  })

  it('lists exactly the four read tools for a valid key', async () => {
    const key = await agentKey()
    expect((await listTools(key)).map(t => t.name).sort())
      .toEqual(['get_messages', 'list_chats', 'search_messages', 'whoami'])
  })
})

describe('whoami', () => {
  beforeEach(resetDb)

  it('reports an empty list when nothing is connected', async () => {
    expect(await callTool(await agentKey(), 'whoami')).toBe(JSON.stringify({ connections: [] }))
  })

  it('reports channel, display name and status — never an account id', async () => {
    await seedConnection({ channel: 'telegram', displayName: 'Alex' })
    await seedConnection({ channel: 'whatsapp', displayName: 'Alex on WhatsApp', status: 'revoked' })
    const out = JSON.parse(await callTool(await agentKey(), 'whoami')) as {
      connections: Array<{ channel: string; displayName: string | null; status: string }>
    }
    expect(out.connections).toHaveLength(2)
    expect(out.connections.map(c => [c.channel, c.status]).sort())
      .toEqual([['telegram', 'active'], ['whatsapp', 'revoked']])
    expect(out.connections.every(c => Object.keys(c).sort().join() === 'channel,displayName,status')).toBe(true)
    expect(JSON.stringify(out)).not.toContain('acct-')
  })
})
