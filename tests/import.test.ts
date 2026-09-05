import { describe, it, expect, beforeEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { chats, connections, messages } from '@/lib/db/schema'
import { resetDb } from './helpers/db'
import { mintAccessKey } from '@/lib/services/access-keys'
import { importBatch, parseBatch, FORMAT, MAX_BATCH_ITEMS, MAX_TEXT_BYTES, type Batch } from '@/lib/services/import'
import { searchMessages } from '@/lib/services/queries'

async function pushKey(): Promise<string> {
  const r = await mintAccessKey('cron', 'push')
  if (!r.ok) throw new Error(r.reason)
  return r.id
}

const message = (over: Record<string, unknown> = {}) => ({
  externalChatId: 'C01', chatKind: 'group', chatTitle: '#eng', externalMessageId: '1725500000.000100',
  senderExternalId: 'U01', senderName: 'Ada', fromOwner: false, sentAt: '2026-09-05T10:00:00Z',
  type: 'text', text: 'the vendor agreed to net 30', ...over,
})

const batch = (over: Record<string, unknown> = {}): unknown => ({
  format: FORMAT,
  source: { type: 'slack', id: 'acme', label: 'Slack (Acme)' },
  messages: [message(), message({ externalMessageId: '1725500000.000200', text: 'second', replyToExternalId: '1725500000.000100' })],
  ...over,
})

function parsed(input: unknown): Batch {
  const r = parseBatch(input)
  if (!r.ok) throw new Error(JSON.stringify(r.problems))
  return r.batch
}

describe('parseBatch', () => {
  it('accepts the documented shape and fills defaults', () => {
    const b = parsed(batch())
    expect(b.source).toEqual({ type: 'slack', id: 'acme', label: 'Slack (Acme)' })
    expect(b.messages).toHaveLength(2)
    expect(b.messages[0].editedAt).toBeNull()
    expect(b.deletes).toEqual([])
  })

  it('rejects the wrong format, a bad slug, a bad kind and an out-of-range time, naming the entry', () => {
    const wrong = parseBatch(batch({ format: 'steno/2' }))
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.problems[0].path).toBe('format')

    const slug = parseBatch(batch({ source: { type: 'Slack', id: 'acme', label: 'x' } }))
    expect(slug.ok).toBe(false)

    const kind = parseBatch(batch({ messages: [message({ chatKind: 'thread' })] }))
    expect(kind.ok).toBe(false)
    if (!kind.ok) expect(kind.problems[0]).toMatchObject({ index: 0, path: 'messages.0.chatKind' })

    const early = parseBatch(batch({ messages: [message({ sentAt: '1989-12-31T00:00:00Z' })] }))
    expect(early.ok).toBe(false)
    const late = parseBatch(batch({ messages: [message({ sentAt: '2999-01-01T00:00:00Z' })] }))
    expect(late.ok).toBe(false)
  })

  it('refuses attachments by name', () => {
    const r = parseBatch(batch({ messages: [message({ media: { mimeType: 'image/png' } })] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problems[0].reason).toBe('media_not_supported')
  })

  it('caps sizes and counts, and lists at most twenty problems', () => {
    const big = parseBatch(batch({ messages: [message({ text: 'x'.repeat(MAX_TEXT_BYTES + 1) })] }))
    expect(big.ok).toBe(false)
    const many = parseBatch(batch({ messages: Array.from({ length: MAX_BATCH_ITEMS + 1 }, (_, i) => message({ externalMessageId: String(i) })) }))
    expect(many.ok).toBe(false)
    const broken = parseBatch(batch({ messages: Array.from({ length: 30 }, () => message({ chatKind: 'nope' })) }))
    expect(broken.ok).toBe(false)
    if (!broken.ok) expect(broken.problems).toHaveLength(20)
  })
})

describe('importBatch', () => {
  beforeEach(resetDb)

  it('creates the source row and records the messages', async () => {
    const keyId = await pushKey()
    const res = await importBatch(keyId, parsed(batch()))
    expect(res).toMatchObject({ inserted: 2, duplicates: 0, edited: 0, deleted: 0 })
    const [source] = await db.select().from(connections)
    expect(source).toMatchObject({
      id: res.source.id, channel: 'slack', mode: 'push', status: 'active', purpose: 'archive',
      externalAccountId: 'acme', displayName: 'Slack (Acme)', pushKeyId: keyId,
    })
    expect(source.lastSyncAt).toBeInstanceOf(Date)
    const [chat] = await db.select().from(chats)
    expect(chat).toMatchObject({ connectionId: source.id, channel: 'slack', externalChatId: 'C01', kind: 'group', title: '#eng' })
    const rows = await db.select().from(messages)
    expect(rows.map(r => r.text).sort()).toEqual(['second', 'the vendor agreed to net 30'])
    expect(rows.find(r => r.text === 'second')?.replyToExternalId).toBe('1725500000.000100')
    // Searchable like anything else the archive holds.
    const hits = await searchMessages('vendor')
    expect(hits.hits.map(h => h.channel)).toEqual(['slack'])
  })

  it('is idempotent on resend and reuses the source row', async () => {
    const keyId = await pushKey()
    const first = await importBatch(keyId, parsed(batch()))
    const again = await importBatch(keyId, parsed(batch({ source: { type: 'slack', id: 'acme', label: 'Renamed' } })))
    expect(again.source.id).toBe(first.source.id)
    expect(again).toMatchObject({ inserted: 0, duplicates: 2 })
    expect((await db.select().from(connections)).map(c => c.displayName)).toEqual(['Renamed'])
    expect(await db.select().from(messages)).toHaveLength(2)
  })

  it('applies an edit to a known message and inserts an unknown one', async () => {
    const keyId = await pushKey()
    await importBatch(keyId, parsed(batch()))
    const res = await importBatch(keyId, parsed(batch({ messages: [
      message({ text: 'net 45 after all', editedAt: '2026-09-05T11:00:00Z' }),
      message({ externalMessageId: 'new', text: 'brand new', editedAt: '2026-09-05T11:00:00Z' }),
    ] })))
    expect(res).toMatchObject({ inserted: 1, duplicates: 1, edited: 1 })
    const rows = await db.select().from(messages)
    const edited = rows.find(r => r.externalMessageId === '1725500000.000100')
    expect(edited?.text).toBe('net 45 after all')
    expect(edited?.editedAt).toBeInstanceOf(Date)
    expect(rows.find(r => r.externalMessageId === 'new')?.text).toBe('brand new')
  })

  it('tombstones a delete so no read path serves it', async () => {
    const keyId = await pushKey()
    await importBatch(keyId, parsed(batch()))
    const res = await importBatch(keyId, parsed(batch({ messages: [], deletes: [{ externalChatId: 'C01', externalMessageId: '1725500000.000100' }] })))
    expect(res.deleted).toBe(1)
    const [row] = await db.select().from(messages).where(eq(messages.externalMessageId, '1725500000.000100'))
    expect(row.deletedAt).toBeInstanceOf(Date)
    expect((await searchMessages('vendor')).hits).toEqual([])
    // Deleted stays deleted: a resend of the original does not resurrect it.
    await importBatch(keyId, parsed(batch()))
    const [still] = await db.select().from(messages).where(and(eq(messages.externalMessageId, '1725500000.000100')))
    expect(still.deletedAt).toBeInstanceOf(Date)
  })

  it('accepts a pushed source whose type is a live channel', async () => {
    const keyId = await pushKey()
    const res = await importBatch(keyId, parsed(batch({ source: { type: 'whatsapp', id: 'export-2026', label: 'WhatsApp export' } })))
    expect(res.inserted).toBe(2)
    const [source] = await db.select().from(connections)
    expect(source).toMatchObject({ channel: 'whatsapp', mode: 'push' })
  })

  it('keeps two sources apart', async () => {
    const keyId = await pushKey()
    const a = await importBatch(keyId, parsed(batch()))
    const b = await importBatch(keyId, parsed(batch({ source: { type: 'slack', id: 'other', label: 'Other' } })))
    expect(a.source.id).not.toBe(b.source.id)
    expect(b.inserted).toBe(2)
    expect(await db.select().from(messages)).toHaveLength(4)
  })
})
