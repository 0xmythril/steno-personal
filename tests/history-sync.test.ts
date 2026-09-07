import { beforeEach, expect, it } from 'vitest'
import { resetDb } from './helpers/db'
import { makeConnection } from './helpers/media-fixtures'
import { FakePort } from '@/lib/channels/fake-port'
import { SessionManager } from '@/lib/channels/session-manager'
import { historyPage, recordEvent, interruptAbandonedRuns } from '@/lib/services/history'
import { recordMessage, applyEdit, applyDelete, type IncomingMessage } from '@/lib/services/ingest'

beforeEach(resetDb)
const message = (text = 'private message'): IncomingMessage => ({ externalChatId: 'chat', externalMessageId: 'one', chatKind: 'group', chatTitle: 'Group', senderExternalId: 'author', senderName: 'Alice', fromOwner: false, sentAt: new Date(), type: 'text', text, media: null, raw: {} })
it('records backfill/contact runs once and does not turn heartbeat ticks into sync history', async () => {
  const port = new FakePort('telegram'); port.scriptBackfill([message()]); await makeConnection('telegram')
  const manager = new SessionManager(new Map([['telegram', port]]))
  try {
    await manager.tick(); await manager.whenIdle()
    const before = historyPage({ kind: 'sync' }).events
    expect(before.filter(e => e.operation === 'backfill')).toHaveLength(1)
    expect(before.find(e => e.operation === 'backfill')).toMatchObject({ counts: { inserted: 1, duplicates: 0 }, outcome: 'completed' })
    expect(before.filter(e => e.operation === 'contacts')).toHaveLength(1)
    expect(before.some(e => e.operation === 'live')).toBe(false)
    await manager.tick(); await manager.whenIdle()
    expect(historyPage({ kind: 'sync' }).events).toHaveLength(before.length)
  } finally { await manager.stopAll() }
})
it('durably aggregates only committed live changes and interrupts abandoned runs', async () => {
  const c = await makeConnection('telegram')
  await recordMessage(c.id, 'telegram', message()); await recordMessage(c.id, 'telegram', message())
  await applyEdit(c.id, 'telegram', message('edited')); await applyDelete(c.id, { externalChatId: 'chat', externalMessageId: 'one' })
  const live = historyPage({ kind: 'sync' }).events.filter(e => e.operation === 'live')
  expect(live).toHaveLength(1); expect(live[0].counts).toEqual({ inserted: 1, edited: 1, deleted: 1 })
  recordEvent({ kind: 'sync', operation: 'backfill', surface: 'worker', sourceIds: [c.id], outcome: 'running', runId: 'crashed-run' })
  interruptAbandonedRuns()
  expect(historyPage({ kind: 'sync' }).events.find(e => e.operation === 'backfill')?.outcome).toBe('interrupted')
})
