import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from './helpers/db'
import { seedChat, seedConnection, seedMessage } from './helpers/archive'
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

describe('content tools with nothing connected', () => {
  beforeEach(resetDb)

  it('answer with exactly the one sentence', async () => {
    const key = await agentKey()
    for (const [name, args] of [
      ['list_chats', {}],
      ['get_messages', { chat_id: 'anything' }],
      ['search_messages', { query: 'anything' }],
    ] as const) {
      expect(await callTool(key, name, args)).toBe('No personal account is connected.')
    }
  })

  it('still answer with the sentence when the only connection is revoked', async () => {
    await seedConnection({ channel: 'telegram', status: 'revoked' })
    expect(await callTool(await agentKey(), 'list_chats')).toBe('No personal account is connected.')
  })
})

describe('content tools with an archive', () => {
  beforeEach(resetDb)

  it('list_chats returns the chat with its title and message count', async () => {
    const conn = await seedConnection()
    const chat = await seedChat(conn, { title: 'Mum', kind: 'dm' })
    await seedMessage(chat, { text: 'call me back' })
    const out = JSON.parse(await callTool(await agentKey(), 'list_chats')) as Array<{
      id: string; title: string | null; kind: string; messageCount: number
    }>
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: chat, title: 'Mum', kind: 'dm', messageCount: 1 })
  })

  it('get_messages returns the transcript newest first and honours before/after', async () => {
    const conn = await seedConnection()
    const chat = await seedChat(conn, { title: 'Mum' })
    await seedMessage(chat, { text: 'older', sentAt: new Date('2026-01-01T10:00:00.000Z') })
    await seedMessage(chat, { text: 'newer', sentAt: new Date('2026-02-01T10:00:00.000Z') })
    const key = await agentKey()

    const all = JSON.parse(await callTool(key, 'get_messages', { chat_id: chat })) as {
      chat: { title: string | null }; messages: Array<{ text: string | null }>; nextCursor: string | null
    }
    expect(all.chat.title).toBe('Mum')
    expect(all.messages.map(m => m.text)).toEqual(['newer', 'older'])

    const bounded = JSON.parse(await callTool(key, 'get_messages', {
      chat_id: chat, before: '2026-01-15T00:00:00.000Z',
    })) as { messages: Array<{ text: string | null }> }
    expect(bounded.messages.map(m => m.text)).toEqual(['older'])
  })

  it('get_messages rejects a malformed timestamp instead of guessing', async () => {
    const conn = await seedConnection()
    const chat = await seedChat(conn)
    const out = await callTool(await agentKey(), 'get_messages', { chat_id: chat, before: 'yesterday' })
    expect(out).toContain('before')
  })

  it('get_messages on an unknown chat says so', async () => {
    await seedConnection()
    expect(await callTool(await agentKey(), 'get_messages', { chat_id: 'no-such-chat' })).toBe('Chat not found.')
  })

  it('search_messages finds text across chats and can be scoped to one', async () => {
    const conn = await seedConnection()
    const mum = await seedChat(conn, { title: 'Mum' })
    const work = await seedChat(conn, { title: 'Work', kind: 'group' })
    await seedMessage(mum, { text: 'bring the umbrella' })
    await seedMessage(work, { text: 'umbrella corp deck is ready' })
    const key = await agentKey()

    const wide = JSON.parse(await callTool(key, 'search_messages', { query: 'umbrella' })) as Array<{ chatId: string }>
    expect(wide.map(r => r.chatId).sort()).toEqual([mum, work].sort())

    const scoped = JSON.parse(await callTool(key, 'search_messages', { query: 'umbrella', chat_id: mum })) as Array<{ chatId: string }>
    expect(scoped.map(r => r.chatId)).toEqual([mum])
  })

  it('never serves a deleted message, through either tool', async () => {
    const conn = await seedConnection()
    const chat = await seedChat(conn)
    await seedMessage(chat, { text: 'retracted', deletedAt: new Date() })
    await seedMessage(chat, { text: 'kept' })
    const key = await agentKey()

    const transcript = await callTool(key, 'get_messages', { chat_id: chat })
    expect(transcript).toContain('kept')
    expect(transcript).not.toContain('retracted')
    expect(transcript).not.toContain('deletedAt')
    expect(await callTool(key, 'search_messages', { query: 'retracted' })).toBe('[]')
  })
})
