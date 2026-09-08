import { beforeEach, expect, it } from 'vitest'
import { db } from '@/lib/db/client'
import { connections, messages, messageDisputes } from '@/lib/db/schema'
import { resetDb } from './helpers/db'
import { mintAccessKey, revokeAccessKey } from '@/lib/services/access-keys'
import { importBatch, parseBatch } from '@/lib/services/import'
import { purgePreview, purgeRevokedKey, getDispute, resolveDispute } from '@/lib/services/disputes'
import { historyPage } from '@/lib/services/history'
beforeEach(resetDb)
async function key(label: string) { const r = await mintAccessKey(label, { read: true, push: true }); if (!r.ok) throw Error(); return r.id }
function batch(id: string, text: string) { const r = parseBatch({ format: 'steno/1', source: { type: 'slack', id: 'studio', label: 'Studio' }, messages: [{ externalChatId: 'chat', externalMessageId: id, chatKind: 'group', sentAt: '2026-09-01T00:00:00Z', text }] }); if (!r.ok) throw Error(); return r.batch }
const owner = { id: null, label: 'Owner' }
it('later purge removes only the original delivering key plus its incoming-only candidates', async () => {
  const a = await key('old'), b = await key('new')
  await importBatch(a, batch('old', 'old message')); const source = await importBatch(b, batch('new', 'new message')); await importBatch(a, batch('new', 'competing copy'))
  await revokeAccessKey(a)
  const preview = purgePreview(a)!
  expect(preview.rows).toHaveLength(1); expect(preview.candidates).toHaveLength(1)
  expect(purgeRevokedKey(a, owner, preview.token)).toMatchObject({ ok: true, messagesDeleted: 1, sourcesDeleted: 0 })
  expect(db.select().from(messages).all().map(m => m.text)).toEqual(['new message'])
  expect(db.select().from(messageDisputes).all()).toHaveLength(0)
  expect(db.select().from(messages).get()!.conflictedAt).toBeNull()
  expect(historyPage({ kind: 'purge', source: source.source.id }).events).toHaveLength(1)
  expect(purgeRevokedKey(a, owner)).toMatchObject({ ok: true, messagesDeleted: 0 })
})
it('preview changes refuse deletion, and tombstone-only sources survive', async () => {
  const a = await key('old'), b = await key('new')
  await importBatch(a, batch('one', 'stored')); await importBatch(b, batch('one', 'other'))
  await revokeAccessKey(a); const preview = purgePreview(a)!
  const message = db.select().from(messages).get()!, dispute = getDispute(message.id)!
  resolveDispute({ messageId: message.id, token: dispute.token, action: 'delete' }, owner)
  expect(purgeRevokedKey(a, owner, preview.token)).toMatchObject({ ok: false, reason: 'stale' })
  expect(purgeRevokedKey(a, owner)).toMatchObject({ ok: true, sourcesDeleted: 0 })
  expect(db.select().from(connections).all()).toHaveLength(1)
  await importBatch(b, batch('one', 'resurrect'))
  expect(db.select().from(messages).get()!.deletedAt).not.toBeNull()
})

it('attributes an incoming-only key cleanup to its affected source while keeping the message', async () => {
  const a = await key('original'), b = await key('incoming-only')
  const pushed = await importBatch(a, batch('one', 'stored')); await importBatch(b, batch('one', 'different'))
  await revokeAccessKey(b); const preview = purgePreview(b)!
  expect(preview.rows).toHaveLength(0); expect(preview.sources.map(s => s.id)).toEqual([pushed.source.id])
  expect(purgeRevokedKey(b, owner, preview.token)).toMatchObject({ ok: true, messagesDeleted: 0 })
  expect(db.select().from(messages).get()!.text).toBe('stored')
  expect(historyPage({ kind: 'purge', source: pushed.source.id }).events).toHaveLength(1)
})
