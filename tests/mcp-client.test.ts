import { describe, it, expect, beforeEach } from 'vitest'
import { Client, SdkHttpError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { resetDb } from './helpers/db'
import { seedChat, seedConnection, seedMessage } from './helpers/archive'
import { mintAccessKey } from '@/lib/services/access-keys'
import { POST } from '@/app/mcp/route'

// The transport's only contact with the network is this fetch; handing it the
// route handler puts the real client and the real server in one process.
async function connect(rawKey: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), {
    fetch: async (url: string | URL, init?: RequestInit) => POST(new Request(url, init)),
    requestInit: { headers: { authorization: `Bearer ${rawKey}` } },
  })
  const client = new Client({ name: 'steno-personal-tests', version: '0.1.0' })
  await client.connect(transport)
  return client
}

async function agentKey(): Promise<string> {
  const r = await mintAccessKey('claude code')
  if (!r.ok) throw new Error(r.reason)
  return r.rawKey
}

function firstText(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? []
  return content.map(c => c.text ?? '').join('\n')
}

describe('an MCP client reads a chat through a bearer key', () => {
  beforeEach(resetDb)

  it('connects, lists tools, and pages a transcript', async () => {
    const conn = await seedConnection({ channel: 'telegram', displayName: 'Alex' })
    const chat = await seedChat(conn, { title: 'Mum', kind: 'dm' })
    await seedMessage(chat, { text: 'call me back', senderName: 'Mum' })

    const client = await connect(await agentKey())
    try {
      const { tools } = await client.listTools()
      expect(tools.map(t => t.name).sort())
        .toEqual(['get_media', 'get_messages', 'list_chats', 'list_people', 'recent_messages', 'search_messages', 'whoami'])

      expect(firstText(await client.callTool({ name: 'list_chats', arguments: {} }))).toContain('Mum')

      const transcript = firstText(await client.callTool({ name: 'get_messages', arguments: { chat_id: chat } }))
      expect(transcript).toContain('call me back')

      const found = firstText(await client.callTool({ name: 'search_messages', arguments: { query: 'call' } }))
      expect(found).toContain('call me back')

      const people = firstText(await client.callTool({ name: 'list_people', arguments: {} }))
      expect(people).toBe('{"people":[],"nextCursor":null}')

      expect(firstText(await client.callTool({ name: 'whoami', arguments: {} }))).toContain('Alex')
    } finally {
      await client.close()
    }
  })

  it('refuses to connect without a valid key', async () => {
    // mcp-handler's withMcpAuth throws the same generic "No authorization
    // provided" OAuthError for a missing token AND an unrecognised one, so the
    // thrown message carries no distinguishing "401"/"unauthorized" text to
    // match on. The transport surfaces the response as an SdkHttpError with
    // the real HTTP status attached, so assert on that instead.
    const err: unknown = await connect('sp_not_a_real_key').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SdkHttpError)
    expect((err as SdkHttpError).status).toBe(401)
  })
})
