import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetDb } from './helpers/db'
import { callPushTool, callTool, pushRequest, pushRpc } from './helpers/mcp'
import { mintAccessKey, type KeyCapabilities } from '@/lib/services/access-keys'
import { DATA_NOT_INSTRUCTIONS } from '@/lib/mcp/copy'
import { POST } from '@/app/mcp/push/route'

async function key(caps: KeyCapabilities): Promise<string> {
  const r = await mintAccessKey('agent', caps)
  if (!r.ok) throw new Error(r.reason)
  return r.rawKey
}

const batch = {
  source: { type: 'slack', id: 'acme', label: 'Slack (Acme)' },
  messages: [{
    externalChatId: 'C01', chatKind: 'group', chatTitle: '#eng', externalMessageId: '1',
    senderExternalId: 'U01', senderName: 'Ada', fromOwner: false, sentAt: '2026-09-05T10:00:00Z', type: 'text', text: 'hello',
  }],
}

describe('MCP push door', () => {
  beforeEach(resetDb)

  it('401s a missing, unknown or read-only key: this door is for push keys', async () => {
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    expect((await POST(pushRequest('', body))).status).toBe(401)
    expect((await POST(pushRequest('sp_not_a_real_key', body))).status).toBe(401)
    const readOnly = await key({ read: true, push: false })
    expect((await POST(pushRequest(readOnly, body))).status).toBe(401)
  })

  it('lists exactly one tool, push_messages, not annotated read-only', async () => {
    const raw = await key({ read: false, push: true })
    const { message } = await pushRpc(raw, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const tools = message?.result?.tools ?? []
    expect(tools.map(t => t.name)).toEqual(['push_messages'])
    expect(tools[0].annotations?.readOnlyHint).toBe(false)
    expect(tools[0].description ?? '').toContain(DATA_NOT_INSTRUCTIONS)
    expect((tools[0].description ?? '').endsWith(DATA_NOT_INSTRUCTIONS)).toBe(true)
  })

  it('delivers a batch and reports counts, minus the format field the door already knows', async () => {
    const raw = await key({ read: false, push: true })
    const out = JSON.parse(await callPushTool(raw, 'push_messages', batch)) as {
      source: { id: string }; inserted: number; duplicates: number; edited: number; deleted: number
      conflicts: number; conflicting: unknown[]
    }
    expect(out).toMatchObject({ inserted: 1, duplicates: 0, edited: 0, deleted: 0, conflicts: 0, conflicting: [] })
    expect(typeof out.source.id).toBe('string')

    const again = JSON.parse(await callPushTool(raw, 'push_messages', batch)) as { inserted: number; duplicates: number }
    expect(again).toMatchObject({ inserted: 0, duplicates: 1 })
  })

  it('a validation failure returns the problem list as text with isError true, never a thrown JSON-RPC error', async () => {
    const raw = await key({ read: false, push: true })
    const { message } = await pushRpc(raw, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'push_messages', arguments: { ...batch, source: { ...batch.source, type: 'telegram' } } },
    })
    expect(message?.error).toBeUndefined()
    expect(message?.result?.isError).toBe(true)
  })

  it('a key with both capabilities pushes through this door and reads through the other', async () => {
    const raw = await key({ read: true, push: true })
    const pushed = JSON.parse(await callPushTool(raw, 'push_messages', batch)) as { inserted: number }
    expect(pushed.inserted).toBe(1)
    const read = JSON.parse(await callTool(raw, 'list_chats')) as { chats: unknown[] }
    expect(read.chats).toHaveLength(1)
  })

  it('records one usage event, the same name as the HTTP door, distinguished by surface', async () => {
    const telemetry = await import('@/lib/services/telemetry')
    const spy = vi.spyOn(telemetry, 'track')
    const raw = await key({ read: false, push: true })
    await callPushTool(raw, 'push_messages', batch)
    expect(spy).toHaveBeenCalledWith('source_pushed', { surface: 'mcp' })
    spy.mockRestore()
  })
})
