import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDb } from './helpers/db'
import { seedConnection, seedChat, seedMessage } from './helpers/archive'
import { mintAccessKey } from '@/lib/services/access-keys'
import { historyPage } from '@/lib/services/history'
import { callTool, listTools } from './helpers/mcp'
import { GET as chatsGet } from '@/app/api/chats/route'
import { GET as exportHistory } from '@/app/api/history/export/route'
import { GET as searchGet } from '@/app/api/search/route'
import { recordRead, recordPortalRead } from '@/lib/services/history-reads'
import { createSession } from '@/lib/services/sessions'

const jar = new Map<string, string>()
const reqHeaders = new Headers()
vi.mock('next/headers', () => ({ cookies: async () => ({ get: (key: string) => jar.has(key) ? { value: jar.get(key) } : undefined }), headers: async () => reqHeaders }))
beforeEach(async () => { await resetDb(); jar.clear(); reqHeaders.delete('next-router-prefetch') })
async function key(label: string) { const r = await mintAccessKey(label); if (!r.ok) throw Error(); return r }

describe('History read boundaries', () => {
  it('attributes concurrent MCP calls to their own keys without logging discovery', async () => {
    const a = await key('alpha'), b = await key('beta')
    const source = await seedConnection(), chat = await seedChat(source); await seedMessage(chat)
    await listTools(a.rawKey)
    expect(historyPage({ kind: 'read' }).events).toHaveLength(0)
    await Promise.all([callTool(a.rawKey, 'list_chats'), callTool(b.rawKey, 'get_messages', { chat_id: chat })])
    const events = historyPage({ kind: 'read' }).events
    expect(events).toHaveLength(2)
    expect(events.find(e => e.operation === 'list_chats')?.actorId).toBe(a.id)
    expect(events.find(e => e.operation === 'get_messages')?.actorId).toBe(b.id)
    expect(events.every(e => e.sources.some(s => s.sourceId === source))).toBe(true)
  })
  it('records empty scoped searches without storing query terms', async () => {
    const a = await key('agent'), source = await seedConnection()
    const response = await searchGet(new Request(`http://localhost/api/search?q=private-needle&source=${source}`, { headers: { Authorization: `Bearer ${a.rawKey}` } }))
    expect(response.status).toBe(200)
    const events = historyPage({ kind: 'read', source }).events
    expect(events).toHaveLength(1); expect(events[0].counts.returned).toBe(0)
    expect(JSON.stringify(events)).not.toContain('private-needle')
  })
  it('refuses bearer-only history export and does not record History introspection', async () => {
    const a = await key('owner')
    expect((await exportHistory(new Request('http://localhost/api/history/export'))).status).toBe(401)
    expect((await exportHistory(new Request('http://localhost/api/history/export', { headers: { Authorization: `Bearer ${a.rawKey}` } }))).status).toBe(403)
    jar.set('sp_session', await createSession({ keyId: a.id }))
    const response = await exportHistory(new Request('http://localhost/api/history/export'))
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await response.text(); expect(historyPage({ kind: 'read' }).events).toHaveLength(0)
  })
  it('records portal passkey identity, skips speculative prefetch and never logs denied API reads', async () => {
    const session = { sessionId: 'not-recorded', via: 'passkey' as const, keyId: null, passkeyId: 'passkey-id', label: 'Phone' }
    reqHeaders.set('next-router-prefetch', '1'); await recordPortalRead(session, 'portal_chats', [])
    expect(historyPage({ kind: 'read' }).events).toHaveLength(0)
    reqHeaders.delete('next-router-prefetch'); await recordPortalRead(session, 'portal_chats', [])
    const events = historyPage({ kind: 'read' }).events
    expect(events[0].actorId).toBe('passkey-id'); expect(JSON.stringify(events)).not.toContain('not-recorded')
    expect((await chatsGet(new Request('http://localhost/api/chats'))).status).toBe(401)
    expect(historyPage({ kind: 'read' }).events).toHaveLength(1)
  })
  it('counts a cross-source read once globally and once in each source filter', async () => {
    const a = await seedConnection({ channel: 'telegram' }), b = await seedConnection({ channel: 'whatsapp' })
    recordRead('list_chats', { id: null, label: 'Owner' }, 'portal', [{ connectionId: a }, { connectionId: b }])
    expect(historyPage({ kind: 'read' }).events).toHaveLength(1)
    expect(historyPage({ kind: 'read', source: a }).events).toHaveLength(1)
    expect(historyPage({ kind: 'read', source: b }).events).toHaveLength(1)
  })
})
