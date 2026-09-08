import { describe, it, expect, beforeEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { chats, connections, messages } from '@/lib/db/schema'
import { resetDb } from './helpers/db'
import { mintAccessKey } from '@/lib/services/access-keys'
import { importBatch, parseBatch, FORMAT, MAX_BATCH_ITEMS, MAX_TEXT_BYTES, type Batch } from '@/lib/services/import'
import { searchMessages } from '@/lib/services/queries'

async function pushKey(label = 'cron'): Promise<string> {
  const r = await mintAccessKey(label, { read: false, push: true })
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

  it('refuses a source type that names a live channel: that slug means a paired account, not a pushed export', () => {
    const r = parseBatch(batch({ source: { type: 'whatsapp', id: 'export-2026', label: 'WhatsApp export' } }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problems[0].reason).toBe('live_channel_not_pushable')
    // A pushed export of a live channel uses another slug instead.
    const ok = parseBatch(batch({ source: { type: 'whatsapp-export', id: 'export-2026', label: 'WhatsApp export' } }))
    expect(ok.ok).toBe(true)
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
    expect(edited?.editedAt).toEqual(new Date('2026-09-05T11:00:00Z'))
    expect(rows.find(r => r.externalMessageId === 'new')).toMatchObject({
      text: 'brand new', editedAt: new Date('2026-09-05T11:00:00Z'),
    })
  })

  it.each([false, true])('keeps the newest edit when retrying an older batch (already edited on insert: %s)', async (editedOnInsert) => {
    const keyId = await pushKey()
    const older = parsed(batch({ messages: [message({ text: 'older version', editedAt: '2026-09-05T11:00:00Z' })] }))
    const newer = parsed(batch({ messages: [message({ text: 'latest version', editedAt: '2026-09-05T12:00:00Z' })] }))
    if (!editedOnInsert) await importBatch(keyId, parsed(batch()))
    await importBatch(keyId, older)
    expect(await importBatch(keyId, newer)).toMatchObject({ inserted: 0, duplicates: 1, edited: 1 })
    expect(await importBatch(keyId, older)).toMatchObject({ inserted: 0, duplicates: 1, edited: 0, conflicts: 0 })
    const [row] = await db.select().from(messages).where(eq(messages.externalMessageId, '1725500000.000100'))
    expect(row).toMatchObject({ text: 'latest version', editedAt: new Date('2026-09-05T12:00:00Z') })
    expect((await searchMessages('latest version')).hits).toHaveLength(1)
    expect((await searchMessages('older version')).hits).toHaveLength(0)
  })

  it('does not replace a newly inserted edited message with an older edit', async () => {
    const keyId = await pushKey()
    await importBatch(keyId, parsed(batch({ messages: [message({ text: 'latest version', editedAt: '2026-09-05T12:00:00Z' })] })))
    expect(await importBatch(keyId, parsed(batch({ messages: [message({ text: 'older version', editedAt: '2026-09-05T11:00:00Z' })] }))))
      .toMatchObject({ duplicates: 1, edited: 0 })
    const [row] = await db.select().from(messages)
    expect(row).toMatchObject({ text: 'latest version', editedAt: new Date('2026-09-05T12:00:00Z') })
  })

  it('equal edit timestamps preserve text and conflict markers, including equivalent timezone offsets', async () => {
    const keyId = await pushKey()
    const original = parsed(batch({ messages: [message({ text: 'latest version', editedAt: '2026-09-05T12:00:00Z' })] }))
    await importBatch(keyId, original)
    await importBatch(keyId, parsed(batch({ messages: [message({ text: 'disputed version' })] })))
    const [before] = await db.select().from(messages)
    expect(before.conflictedAt).toBeInstanceOf(Date)
    expect(await importBatch(keyId, original)).toMatchObject({ duplicates: 1, edited: 0 })
    expect(await importBatch(keyId, parsed(batch({ messages: [message({ text: 'replacement', editedAt: '2026-09-05T20:00:00+08:00' })] }))))
      .toMatchObject({ duplicates: 1, edited: 0 })
    const [after] = await db.select().from(messages)
    expect(after).toMatchObject({ text: before.text, editedAt: before.editedAt, conflictedAt: before.conflictedAt })
  })

  it('concurrent imports keep the newest source edit timestamp', async () => {
    const keyId = await pushKey()
    await importBatch(keyId, parsed(batch()))
    const edits = ['2026-09-05T13:00:00Z', '2026-09-05T12:00:00Z', '2026-09-05T11:00:00Z']
    await Promise.all(edits.map(editedAt => importBatch(keyId, parsed(batch({ messages: [message({ text: editedAt, editedAt })] })))))
    const [row] = await db.select().from(messages).where(eq(messages.externalMessageId, '1725500000.000100'))
    expect(row).toMatchObject({ text: edits[0], editedAt: new Date(edits[0]) })
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

  it('a deleted message resent with other text is a duplicate, not a conflict, and stays deleted', async () => {
    const keyId = await pushKey()
    await importBatch(keyId, parsed(batch()))
    await importBatch(keyId, parsed(batch({ messages: [], deletes: [{ externalChatId: 'C01', externalMessageId: '1725500000.000100' }] })))
    const res = await importBatch(keyId, parsed(batch({ messages: [
      message({ text: 'rewritten after deletion' }),
      message({ text: 'edited after deletion', editedAt: '2026-09-05T12:00:00Z' }),
    ] })))
    expect(res).toMatchObject({ inserted: 0, duplicates: 2, edited: 0, conflicts: 0 })
    const [row] = await db.select().from(messages).where(eq(messages.externalMessageId, '1725500000.000100'))
    expect(row.deletedAt).toBeInstanceOf(Date)
    expect(row.text).toBe('the vendor agreed to net 30')
    // A tombstone is never a conflict and is never marked, even when the
    // resend disagrees with the text buried under it.
    expect(row.conflictedAt).toBeNull()
  })

  it('a conflicting push sets conflicted_at on exactly the disputed message and leaves the others null', async () => {
    const a = await pushKey('agent-a')
    const b = await pushKey('agent-b')
    await importBatch(a, parsed(batch()))
    const res = await importBatch(b, parsed(batch({ messages: [
      message({ text: 'a different account of the same message' }),
      message({ externalMessageId: '1725500000.000200', text: 'second' }),
    ] })))
    expect(res).toMatchObject({ inserted: 0, duplicates: 2, conflicts: 1 })
    const rows = await db.select().from(messages)
    const disputed = rows.find(r => r.externalMessageId === '1725500000.000100')!
    const agreed = rows.find(r => r.externalMessageId === '1725500000.000200')!
    expect(disputed.conflictedAt).toBeInstanceOf(Date)
    expect(disputed.text).toBe('the vendor agreed to net 30')
    expect(agreed.conflictedAt).toBeNull()
  })

  it('a resend with editedAt that updates the text clears conflicted_at, because an explicit edit settles the disagreement', async () => {
    const a = await pushKey('agent-a')
    const b = await pushKey('agent-b')
    await importBatch(a, parsed(batch()))
    await importBatch(b, parsed(batch({ messages: [message({ text: 'a different account of the same message' })] })))
    const [beforeEdit] = await db.select().from(messages).where(eq(messages.externalMessageId, '1725500000.000100'))
    expect(beforeEdit.conflictedAt).toBeInstanceOf(Date)

    await importBatch(a, parsed(batch({ messages: [
      message({ text: 'net 45 after all', editedAt: '2026-09-05T11:00:00Z' }),
    ] })))
    const [afterEdit] = await db.select().from(messages).where(eq(messages.externalMessageId, '1725500000.000100'))
    expect(afterEdit.text).toBe('net 45 after all')
    expect(afterEdit.editedAt).toBeInstanceOf(Date)
    expect(afterEdit.conflictedAt).toBeNull()
  })

  it('last_push_key_id is the key of the most recent batch', async () => {
    const a = await pushKey('agent-a')
    const b = await pushKey('agent-b')
    await importBatch(a, parsed(batch()))
    let [source] = await db.select().from(connections)
    expect(source.lastPushKeyId).toBe(a)
    await importBatch(b, parsed(batch({ messages: [message({ externalMessageId: 'from-b', text: 'from b' })] })))
    ;[source] = await db.select().from(connections)
    expect(source.lastPushKeyId).toBe(b)
  })

  it('records which key pushed each message', async () => {
    const keyId = await pushKey()
    await importBatch(keyId, parsed(batch()))
    const rows = await db.select().from(messages)
    expect(rows.every(r => r.pushKeyId === keyId)).toBe(true)
  })

  it('two keys may push to one source, each message carrying its own key', async () => {
    const a = await pushKey('agent-a')
    const b = await pushKey('agent-b')
    const first = await importBatch(a, parsed(batch()))
    const second = await importBatch(b, parsed(batch({
      source: { type: 'slack', id: 'acme', label: 'Slack (Acme)' },
      messages: [message({ externalMessageId: 'from-b', text: 'from b' })],
    })))
    expect(second.source.id).toBe(first.source.id)
    expect(second.inserted).toBe(1)
    const rows = await db.select().from(messages)
    expect(rows.find(r => r.externalMessageId === '1725500000.000100')?.pushKeyId).toBe(a)
    expect(rows.find(r => r.externalMessageId === 'from-b')?.pushKeyId).toBe(b)
  })

  it('a second key pushing different text for a known message, with no editedAt, counts a conflict and leaves the stored text alone', async () => {
    const a = await pushKey('agent-a')
    const b = await pushKey('agent-b')
    await importBatch(a, parsed(batch()))
    const res = await importBatch(b, parsed(batch({ messages: [message({ text: 'a different account of the same message' })] })))
    expect(res).toMatchObject({ inserted: 0, duplicates: 1, edited: 0, conflicts: 1 })
    expect(res.conflicting).toEqual([{ externalChatId: 'C01', externalMessageId: '1725500000.000100' }])
    const [row] = await db.select().from(messages).where(eq(messages.externalMessageId, '1725500000.000100'))
    expect(row.text).toBe('the vendor agreed to net 30')
    expect(row.pushKeyId).toBe(a)
  })

  it('a resend with the same text is not a conflict', async () => {
    const keyId = await pushKey()
    await importBatch(keyId, parsed(batch()))
    const res = await importBatch(keyId, parsed(batch()))
    expect(res).toMatchObject({ inserted: 0, duplicates: 2, conflicts: 0 })
    expect(res.conflicting).toEqual([])
  })

  it('keeps two sources apart', async () => {
    const keyId = await pushKey()
    const a = await importBatch(keyId, parsed(batch()))
    const b = await importBatch(keyId, parsed(batch({ source: { type: 'slack', id: 'other', label: 'Other' } })))
    expect(a.source.id).not.toBe(b.source.id)
    expect(b.inserted).toBe(2)
    expect(await db.select().from(messages)).toHaveLength(4)
  })

  it('counts only deletes that tombstoned something', async () => {
    const keyId = await pushKey()
    await importBatch(keyId, parsed(batch()))
    const res = await importBatch(keyId, parsed(batch({ messages: [], deletes: [
      { externalChatId: 'C01', externalMessageId: '1725500000.000100' },
      { externalChatId: 'C01', externalMessageId: 'never-seen' },
      { externalChatId: 'no-such-chat', externalMessageId: '1725500000.000100' },
    ] })))
    expect(res.deleted).toBe(1)
  })

  it('two concurrent batches for one source share one row', async () => {
    const keyId = await pushKey()
    const [a, b] = await Promise.all([importBatch(keyId, parsed(batch())), importBatch(keyId, parsed(batch()))])
    expect(a.source.id).toBe(b.source.id)
    expect(await db.select().from(connections)).toHaveLength(1)
    expect(await db.select().from(messages)).toHaveLength(2)
  })
})
