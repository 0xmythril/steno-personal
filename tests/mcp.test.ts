import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetDb } from './helpers/db'
import { seedChat, seedConnection, seedMessage } from './helpers/archive'
import { callTool, listTools, mcpRequest, rpc } from './helpers/mcp'
import * as queries from '@/lib/services/queries'
import { createPerson, linkIdentity } from '@/lib/services/people'
import { mintAccessKey, revokeAccessKey } from '@/lib/services/access-keys'
import { POST } from '@/app/mcp/route'

async function agentKey(label = 'agent'): Promise<string> {
  const r = await mintAccessKey(label)
  if (!r.ok) throw new Error(r.reason)
  return r.rawKey
}

describe('MCP bearer auth', () => {
  beforeEach(resetDb)

  it('401s a missing or unknown key', async () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    expect((await POST(mcpRequest('', body))).status).toBe(401)
    expect((await POST(mcpRequest('sp_not_a_real_key', body))).status).toBe(401)
    expect((await POST(mcpRequest('definitely-not-prefixed', body))).status).toBe(401)
  })

  it('401s the next call after that key is revoked', async () => {
    // The M3 exit criterion, driven end to end: the same key that worked a
    // moment ago is refused once it is revoked. The test above only covers
    // keys that were never valid.
    const minted = await mintAccessKey('to be revoked')
    if (!minted.ok) throw new Error(minted.reason)
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    expect((await POST(mcpRequest(minted.rawKey, body))).status).toBe(200)
    await revokeAccessKey(minted.id)
    expect((await POST(mcpRequest(minted.rawKey, body))).status).toBe(401)
  })

  it('lists exactly the seven read tools for a valid key', async () => {
    const key = await agentKey()
    expect((await listTools(key)).map(t => t.name).sort())
      .toEqual(['get_media', 'get_messages', 'list_chats', 'list_people', 'recent_messages', 'search_messages', 'whoami'])
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

describe('content tools with nothing to serve', () => {
  beforeEach(resetDb)

  it('answer with exactly the one sentence', async () => {
    const key = await agentKey()
    for (const [name, args] of [
      ['list_chats', {}],
      ['get_messages', { chat_id: 'anything' }],
      ['search_messages', { query: 'anything' }],
      ['list_people', {}],
    ] as const) {
      expect(await callTool(key, name, args)).toBe('No personal account is connected.')
    }
  })

  it('still answer with the sentence when a revoked connection archived nothing', async () => {
    await seedConnection({ channel: 'telegram', status: 'revoked' })
    expect(await callTool(await agentKey(), 'list_chats')).toBe('No personal account is connected.')
  })

  it('serve the archive of a revoked connection, exactly as the portal does', async () => {
    // Disconnecting ends the channel session; it does not retract the
    // history. app/page.tsx keeps rendering it ("Everything already archived
    // stays readable below.") and GET /api/chats keeps serving it to the same
    // access key, so the agent surface must not disagree.
    const conn = await seedConnection({ channel: 'telegram', status: 'revoked' })
    const chat = await seedChat(conn, { title: 'Mum', kind: 'dm' })
    await seedMessage(chat, { text: 'call me back' })
    const key = await agentKey()

    const { chats } = JSON.parse(await callTool(key, 'list_chats')) as { chats: Array<{ id: string; title: string | null }> }
    expect(chats.map(c => c.title)).toEqual(['Mum'])
    const transcript = JSON.parse(await callTool(key, 'get_messages', { chat_id: chat })) as {
      messages: Array<{ text: string | null }>
    }
    expect(transcript.messages.map(m => m.text)).toEqual(['call me back'])
    expect(await callTool(key, 'search_messages', { query: 'call' })).toContain(chat)
  })
})

describe('content tools with an archive', () => {
  beforeEach(resetDb)

  it('list_chats returns the chat with its title and message count', async () => {
    const conn = await seedConnection()
    const chat = await seedChat(conn, { title: 'Mum', kind: 'dm' })
    await seedMessage(chat, { text: 'call me back' })
    const { chats: out } = JSON.parse(await callTool(await agentKey(), 'list_chats')) as { chats: Array<{
      id: string; title: string | null; kind: string; messageCount: number
    }> }
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

  it('answers a failed query with a fixed sentence, never the query or its parameters', async () => {
    // The MCP SDK returns a thrown handler's error.message to the client
    // verbatim, and drizzle builds that message out of the SQL and the bound
    // values. The guard in the route is the only thing standing between the
    // two, so this drives a real failure through it.
    const conn = await seedConnection()
    await seedChat(conn, { title: 'Mum' })
    const spy = vi.spyOn(queries, 'pageChats').mockRejectedValue(
      new Error('Failed query: select "title" from "chats"\nparams: ["SECRET"]'),
    )
    try {
      const { message } = await rpc(await agentKey(), {
        jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_chats', arguments: {} },
      })
      expect(message?.error).toBeUndefined()
      expect(message?.result?.isError).toBe(true)
      expect((message?.result?.content ?? []).map(c => c.text).join('')).toBe('Internal error.')
      expect(JSON.stringify(message)).not.toContain('SECRET')
      expect(JSON.stringify(message)).not.toContain('Failed query')
    } finally {
      spy.mockRestore()
    }
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

describe('list_people', () => {
  beforeEach(resetDb)

  it('answers with the address book — and never a phone number or a channel id', async () => {
    // The tool exists so an agent can resolve the `person` on a chat or a
    // message. It must not become a way to read the address book's raw
    // material: a Telegram user id, a WhatsApp JID (which IS a number), or the
    // phone column behind them (people design decision 6).
    const conn = await seedConnection({ channel: 'telegram' })
    const chat = await seedChat(conn, { title: 'Ada', kind: 'dm', externalChatId: '42' })
    await seedMessage(chat, { text: 'hello' })

    const { id } = await createPerson({ name: 'Ada', notes: 'from the archive' })
    await linkIdentity(id, {
      channel: 'telegram', externalId: '42', displayName: 'Ada', phone: '+447700900123',
    })
    await linkIdentity(id, { channel: 'whatsapp', externalId: '447700900123@s.whatsapp.net' })

    const out = await callTool(await agentKey(), 'list_people')
    expect(JSON.parse(out)).toEqual([{
      id, name: 'Ada', notes: 'from the archive',
      channels: ['telegram', 'whatsapp'], chatCount: 1,
      chats: [{ id: chat, title: 'Ada', channel: 'telegram', kind: 'dm' }],
    }])
    expect(out).not.toContain('+447700900123')
    expect(out).not.toContain('@s.whatsapp.net')
    expect(out).not.toContain('externalId')
  })

  it('is gated like the content tools, so an empty instance says nothing else', async () => {
    // An address book with people in it but nothing connected and nothing
    // archived would otherwise answer where list_chats refuses to.
    await createPerson({ name: 'Ada' })
    expect(await callTool(await agentKey(), 'list_people')).toBe('No personal account is connected.')
  })

  it('serves the address book of a revoked connection, exactly as the portal does', async () => {
    const conn = await seedConnection({ channel: 'telegram', status: 'revoked' })
    const chat = await seedChat(conn, { title: 'Ada', kind: 'dm', externalChatId: '42' })
    await seedMessage(chat, { text: 'hello' })
    await createPerson({ name: 'Ada' })
    const out = JSON.parse(await callTool(await agentKey(), 'list_people')) as Array<{ name: string }>
    expect(out.map(p => p.name)).toEqual(['Ada'])
  })
})
