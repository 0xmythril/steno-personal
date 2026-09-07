import { beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { historyEvents, messageDisputes, messages } from '@/lib/db/schema'
import { resetDb } from './helpers/db'
import { mintAccessKey } from '@/lib/services/access-keys'
import { importBatch, parseBatch } from '@/lib/services/import'
import { historyPage, historyCsv, recordEvent, trimHistory, csvCell, safeHistoryLabel } from '@/lib/services/history'
import { getDispute, resolveDispute } from '@/lib/services/disputes'

beforeEach(resetDb)
async function key(label: string) { const r = await mintAccessKey(label, { read: true, push: true }); if (!r.ok) throw Error(); return r.id }
function batch(text: string, edit?: string) { const r = parseBatch({ format: 'steno/1', source: { type: 'slack', id: 'studio', label: 'Studio' }, messages: [{ externalChatId: 'chat', externalMessageId: 'one', chatKind: 'group', sentAt: '2026-09-01T00:00:00Z', text, editedAt: edit }] }); if (!r.ok) throw Error(); return r.batch }
const owner = { id: null, label: 'Owner' }
describe('History and competing versions', () => {
  it('records a push once and captures competing text without putting it in events or CSV', async () => {
    const a = await key('a'), b = await key('b')
    await importBatch(a, batch('Thursday')); await importBatch(b, batch('Friday'))
    const rows = historyPage({ kind: 'push' }).events
    expect(rows).toHaveLength(2); expect(rows[0].counts.conflicts).toBe(1)
    const m = db.select().from(messages).get()!; const d = getDispute(m.id)!
    expect(d.candidates[0].incomingText).toBe('Friday')
    expect([...historyCsv({})].join('')).not.toMatch(/Thursday|Friday/)
    expect(JSON.stringify(rows)).not.toMatch(/Thursday|Friday/)
  })
  it('coalesces repeats, keeps distinct candidates and rejects stale resolution forms', async () => {
    const a = await key('a'), b = await key('b')
    await importBatch(a, batch('Thursday')); await importBatch(b, batch('Friday'))
    const m = db.select().from(messages).get()!; const old = getDispute(m.id)!
    await importBatch(b, batch('Friday')); await importBatch(b, batch('Saturday'))
    expect(db.select().from(messageDisputes).all()).toHaveLength(2)
    expect(resolveDispute({ messageId: m.id, token: old.token, action: 'keep' }, owner).ok).toBe(false)
    const current = getDispute(m.id)!
    const candidate = current.candidates.find(c => c.incomingText === 'Friday')!
    expect(resolveDispute({ messageId: m.id, token: current.token, action: 'accept', candidateId: candidate.id }, owner).ok).toBe(true)
    const accepted = db.select().from(messages).get()!
    expect(accepted.text).toBe('Friday'); expect(accepted.pushKeyId).toBe(a); expect(accepted.contentKeyId).toBe(b)
    expect(db.select().from(messageDisputes).all()).toHaveLength(0)
  })
  it('preserves the merged newer-edit rule and removes superseded candidates', async () => {
    const a = await key('a'); await importBatch(a, batch('first')); await importBatch(a, batch('conflict'))
    await importBatch(a, batch('new', '2026-09-07T12:00:00Z')); await importBatch(a, batch('old', '2026-09-06T12:00:00Z'))
    expect(db.select().from(messages).get()!.text).toBe('new')
    expect(db.select().from(messageDisputes).all()).toHaveLength(0)
  })
  it('deletes with a tombstone and cannot resurrect on replay', async () => {
    const a = await key('a'); await importBatch(a, batch('first')); await importBatch(a, batch('different'))
    const m = db.select().from(messages).get()!, d = getDispute(m.id)!
    resolveDispute({ messageId: m.id, token: d.token, action: 'delete' }, owner)
    await importBatch(a, batch('resurrect', '2026-09-08T00:00:00Z'))
    expect(db.select().from(messages).get()!.deletedAt).not.toBeNull(); expect(getDispute(m.id)).toBeNull()
  })
  it('retains unresolved candidates independently of event retention', async () => {
    const a = await key('a'); await importBatch(a, batch('first')); await importBatch(a, batch('different'))
    trimHistory(new Date(), 0)
    expect(db.select().from(historyEvents).all()).toHaveLength(0)
    expect(db.select().from(messageDisputes).all()).toHaveLength(1)
  })
  it('does not fabricate a candidate for legacy marks', async () => {
    const a = await key('a'); await importBatch(a, batch('first'))
    const m = db.select().from(messages).get()!
    db.update(messages).set({ conflictedAt: new Date() }).where(eq(messages.id, m.id)).run()
    const d = getDispute(m.id)!
    expect(d.candidates).toHaveLength(0)
    expect(resolveDispute({ messageId: m.id, token: d.token, action: 'accept' }, owner).ok).toBe(false)
  })
})
describe('retained metadata', () => {
  it('paginates tied timestamps without duplicates and applies age and count caps', () => {
    const now = new Date('2026-09-08T00:00:00Z')
    for (let i = 0; i < 5; i++) recordEvent({ kind: 'read', operation: 'list_chats', now })
    recordEvent({ kind: 'read', operation: 'list_chats', now: new Date('2025-01-01') })
    trimHistory(now, 4)
    const a = historyPage({}, 2), b = historyPage({ cursor: a.nextCursor! }, 2)
    expect(new Set([...a.events, ...b.events].map(e => e.id)).size).toBe(4)
    expect(b.nextCursor).toBeNull()
  })
  it('rejects untyped metadata and redacts identifiers from labels', () => {
    expect(() => recordEvent({ kind: 'push', operation: 'push', counts: { text: 1 } })).toThrow()
    expect(safeHistoryLabel('123456789@s.whatsapp.net', 'WhatsApp')).toBe('WhatsApp')
    expect(csvCell('=HYPERLINK("bad")')).toContain("'=HYPERLINK")
  })
})

describe('transaction boundaries', () => {
  it('rolls a whole batch back when a late database write fails', async () => {
    const a = await key('a')
    db.run(sql`create trigger fail_second before insert on messages when new.external_message_id = 'two' begin select raise(abort, 'simulated'); end`)
    const input = batch('one'); input.messages.push({ ...input.messages[0], externalMessageId: 'two' })
    try { await expect(importBatch(a, input)).rejects.toThrow() } finally { db.run(sql`drop trigger fail_second`) }
    expect(db.select().from(messages).all()).toHaveLength(0)
    expect(historyPage({ kind: 'push' }).events.map(e => e.outcome)).toEqual(['failed'])
  })
  it('an owner acceptance never lowers the source edit watermark', async () => {
    const a = await key('a'); await importBatch(a, batch('source', '2030-01-01T00:00:00Z')); await importBatch(a, batch('preferred'))
    const m = db.select().from(messages).get()!, d = getDispute(m.id)!
    resolveDispute({ messageId: m.id, token: d.token, action: 'accept', candidateId: d.candidates[0].id }, owner)
    await importBatch(a, batch('source', '2030-01-01T00:00:00Z'))
    expect(db.select().from(messages).get()!.text).toBe('preferred')
  })
})

it('refuses new candidate storage at capacity without committing earlier batch inserts', async () => {
  const a = await key('a'); await importBatch(a, batch('stored'))
  const m = db.select().from(messages).get()!
  db.transaction(tx => {
    for (let i = 0; i < 10_000; i++) tx.insert(messageDisputes).values({ messageId: m.id, revision: 0, incomingKeyId: a, incomingText: `candidate ${i}`, fingerprint: `fixture-${i}` }).run()
  })
  const input = batch('different'); input.messages.unshift({ ...input.messages[0], externalMessageId: 'new-before-failure', text: 'must roll back' })
  await expect(importBatch(a, input)).rejects.toThrow('dispute_capacity')
  expect(db.select().from(messages).all()).toHaveLength(1)
  expect(db.select().from(messageDisputes).all()).toHaveLength(10_000)
})
