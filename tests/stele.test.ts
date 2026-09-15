import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { connections, messages, chats } from '@/lib/db/schema'
import { encryptSecret } from '@/lib/services/crypto'
import { commitSteleChanges, steleState } from '@/lib/services/stele'
import { SteleWechatPort } from '@/lib/channels/stele'
import { SteleClient, SteleError } from '@/lib/channels/stele-client'
import { SessionManager } from '@/lib/channels/session-manager'
import { validSteleUrl } from '@/lib/channels/stele-url'
import { type SteleChange } from '@/lib/channels/stele-wire'
import { resetDb } from './helpers/db'

const initial = { sourceId: 'source', accountId: 'owner', cursor: null }
const chat = { id: 'chat', revision: 1, kind: 'dm' as const, title: 'Friend' }
const message = { id: 'message', chatId: 'chat', revision: 1, sender: { externalId: 'friend', displayName: 'Friend', isSelf: false }, sentAt: '2026-09-01T00:00:00Z', kind: 'text' as const, text: 'hello' }
const upsert: Extract<SteleChange, { type: 'upsert' }> = { type: 'upsert', chat, message }
const deletion: SteleChange = { type: 'delete', chatId: 'chat', messageId: 'message' }
async function connection(cursor: string | null = null) {
  return db.insert(connections).values({ channel: 'wechat', status: 'active', sessionCiphertext: encryptSecret(JSON.stringify({ ...initial, cursor })) }).returning().get()
}
function network(events: unknown[]) {
  const get = vi.spyOn(SteleClient.prototype, 'get').mockImplementation(async (path, schema) => {
    let result: unknown
    if (path === '/v1/status') result = { sourceId: 'source', session: 'linked', capture: 'ready', readable: true, reason: null, capabilities: { text: true, contacts: false, recalls: false } }
    else if (path === '/v1/checkpoint') result = { sourceId: 'source', cursor: 'H' }
    else if (path.startsWith('/v1/chats?')) result = { items: [chat], nextCursor: null, through: 'H' }
    else if (path.startsWith('/v1/chats/chat/messages?')) result = { items: [message], nextCursor: null, through: 'H' }
    else if (path === '/v1/chats/chat') result = chat
    else if (path === '/v1/chats/chat/messages/message') result = { ...message, revision: 2, text: 'updated' }
    else throw new Error('Unexpected path')
    return schema.parse(result)
  })
  const stream = vi.spyOn(SteleClient.prototype, 'stream').mockImplementation(async function* () { yield* events })
  return { get, stream }
}
beforeEach(resetDb)
afterEach(() => vi.restoreAllMocks())

describe('Stele durable consumer', () => {
  it('rolls back messages and checkpoint when a later change fails', async () => {
    const c = await connection()
    const invalid = { ...upsert, message: { ...message, id: 'invalid', sentAt: 'invalid' } } as SteleChange
    expect(() => commitSteleChanges(c.id, initial, [upsert, invalid], 'next')).toThrow()
    expect(db.select().from(messages).all()).toHaveLength(0)
    expect(steleState(c.id)).toEqual(initial)
  })
  it('keeps unseen deletes terminal and rejects stale checkpoint writers', async () => {
    const c = await connection()
    commitSteleChanges(c.id, initial, [deletion], null)
    expect(db.select().from(connections).where(eq(connections.id, c.id)).get()?.lastSyncAt).toBeNull()
    commitSteleChanges(c.id, initial, [upsert], 'next', true)
    expect(db.select().from(messages).get()?.deletedAt).not.toBeNull()
    expect(() => commitSteleChanges(c.id, initial, [], 'old')).toThrow('checkpoint changed')
  })
  it('preserves newer revisions and reconciles only its own connection', async () => {
    const c = await connection()
    const other = db.insert(connections).values({ channel: 'telegram', status: 'active' }).returning().get()
    commitSteleChanges(c.id, initial, [{ ...upsert, message: { ...message, revision: 3, text: 'new' } }], 'one')
    commitSteleChanges(c.id, steleState(c.id), [upsert], 'two')
    expect(db.select().from(messages).get()?.text).toBe('new')
    commitSteleChanges(c.id, steleState(c.id), [], 'three', true)
    expect(db.select().from(messages).get()?.deletedAt).not.toBeNull()
    expect(db.select().from(connections).where(eq(connections.id, other.id)).get()?.status).toBe('active')
    db.update(connections).set({ revokedAt: new Date() }).where(eq(connections.id, c.id)).run()
    expect(() => commitSteleChanges(c.id, { ...initial, cursor: 'three' }, [], 'four')).toThrow('not active')
  })
  it('publishes bootstrap only after replay catches up, and resumes saved state', async () => {
    const c = await connection()
    const n = network([{ type: 'edit', cursor: 'I', data: { chatId: 'chat', messageId: 'message', revision: 2 } }, { type: 'caught_up', cursor: 'I' }])
    const port = new SteleWechatPort(), session = await port.open(JSON.stringify(initial), { connectionId: c.id })
    await session.sync!(() => true)
    expect(db.select().from(messages).get()?.text).toBe('updated')
    expect(steleState(c.id).cursor).toBe('I')
    n.stream.mockImplementation(async function* () { yield { type: 'caught_up', cursor: 'J' } })
    const resumed = await port.open(JSON.stringify(steleState(c.id)), { connectionId: c.id })
    await resumed.sync!(() => true)
    expect(n.stream).toHaveBeenLastCalledWith('/v1/events?after=I')
    expect(steleState(c.id).cursor).toBe('J')
  })
  it('does not publish an unfinished baseline or advance after a failed fetch', async () => {
    const c = await connection()
    const n = network([])
    const session = await new SteleWechatPort().open(JSON.stringify(initial), { connectionId: c.id })
    await expect(session.sync!(() => true)).rejects.toThrow()
    expect(db.select().from(messages).all()).toHaveLength(0)
    expect(steleState(c.id).cursor).toBeNull()
    commitSteleChanges(c.id, initial, [], 'saved')
    n.stream.mockImplementation(async function* () { yield { type: 'message', cursor: 'next', data: { chatId: 'missing', messageId: 'missing', revision: 1 } } })
    await expect(session.sync!(() => true)).rejects.toThrow()
    expect(steleState(c.id).cursor).toBe('saved')
  })
  it('rebuilds on an expired cursor and refuses source changes', async () => {
    const c = await connection('expired')
    const n = network([{ type: 'caught_up', cursor: 'fresh' }])
    n.stream.mockImplementationOnce(async function* () { throw new SteleError('cursor_expired'); yield undefined })
    const session = await new SteleWechatPort().open(JSON.stringify(steleState(c.id)), { connectionId: c.id })
    await session.sync!(() => true)
    expect(n.stream).toHaveBeenLastCalledWith('/v1/events?after=H')
    expect(steleState(c.id).cursor).toBe('fresh')
    vi.spyOn(SteleClient.prototype, 'status').mockResolvedValue({ sourceId: 'different', session: 'linked', capture: 'ready', readable: true, reason: null, capabilities: { text: true, contacts: false, recalls: false } })
    await expect(session.sync!(() => true)).rejects.toMatchObject({ code: 'account_mismatch' })
    expect(steleState(c.id).cursor).toBe('fresh')
  })
  it('commits chat renames with their event cursor', async () => {
    const c = await connection('saved')
    network([{ type: 'chat', cursor: 'renamed', data: { id: 'chat', revision: 1 } }, { type: 'caught_up', cursor: 'renamed' }])
    const session = await new SteleWechatPort().open(JSON.stringify(steleState(c.id)), { connectionId: c.id })
    await session.sync!(() => true)
    expect(db.select().from(chats).get()?.title).toBe('Friend')
    expect(steleState(c.id).cursor).toBe('renamed')
  })
  it('opens externally paired sessions in the worker and retries sync on later ticks', async () => {
    await connection()
    const n = network([{ type: 'caught_up', cursor: 'H' }])
    const manager = new SessionManager(new Map([['wechat', new SteleWechatPort()]]))
    await manager.tick(); await manager.whenIdle()
    expect(n.stream).toHaveBeenCalledTimes(1)
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 4000)
    await manager.tick(); await manager.whenIdle()
    expect(n.stream).toHaveBeenCalledTimes(2)
    await manager.stopAll()
  })
})

it('permits only configured secure origins or loopback HTTP', () => {
  for (const url of ['https://stele.example', 'http://127.0.0.1:9090', 'http://[::1]:9090']) expect(validSteleUrl(url)).toBe(true)
  for (const url of ['http://remote.example', 'https://user:secret@host', 'https://host/path', 'https://host?token=secret', 'file:///tmp/data']) expect(validSteleUrl(url)).toBe(false)
})
