import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { db } from '@/lib/db/client'
import { historyEvents } from '@/lib/db/schema'
import { resetDb } from './helpers/db'
import { makeConnection } from './helpers/media-fixtures'
import { historyCsv, historyPage, historySummary, parseHistoryFilters, recordEvent, recordLiveChanges } from '@/lib/services/history'

beforeEach(resetDb)
afterEach(() => vi.useRealTimers())

it('filters individual sync runs by operation and outcome across pages and CSV', () => {
  const now = new Date('2026-09-08T10:00:00Z')
  const ids = [0, 1, 2].map(() => recordEvent({ kind: 'sync', operation: 'contacts', surface: 'worker', outcome: 'failed', now, counts: { contacts: 0 } }))
  recordEvent({ kind: 'sync', operation: 'contacts', surface: 'worker', outcome: 'completed', now, counts: { contacts: 0 } })
  recordEvent({ kind: 'sync', operation: 'backfill', surface: 'worker', outcome: 'failed', now })
  recordEvent({ kind: 'read', operation: 'list_chats', outcome: 'failed', now })
  const filters = parseHistoryFilters({ operation: 'contacts', outcome: 'failed', actor: 'system', from: '2026-09-08', to: '2026-09-08' })
  const first = historyPage(filters, 2), second = historyPage({ ...filters, cursor: first.nextCursor! }, 2)
  expect([...first.events, ...second.events].map(e => e.id).sort()).toEqual(ids.sort())
  expect(second.nextCursor).toBeNull()
  const csv = [...historyCsv(filters)].join('')
  expect(csv.trim().split('\r\n')).toHaveLength(4)
  expect(csv).not.toContain('Synced conversation history')
  expect(historyPage().events).toHaveLength(6)
  expect(historyPage(parseHistoryFilters({ operation: 'contacts', outcome: 'completed' })).events[0].counts).toEqual({ contacts: 0 })
})

it('validates operation and outcome filters and treats empty form values as unrestricted', () => {
  for (const params of [{ operation: 'typo' }, { operation: 'list_chats' }, { outcome: 'typo' }]) expect(() => parseHistoryFilters(params)).toThrow()
  expect(parseHistoryFilters({ operation: '', outcome: '' })).toMatchObject({ operation: undefined, outcome: undefined })
  for (const outcome of ['running', 'completed', 'failed', 'interrupted']) expect(parseHistoryFilters({ outcome }).outcome).toBe(outcome)
})

it('applies the same diagnostic filters to source summaries', () => {
  recordEvent({ kind: 'sync', operation: 'backfill', surface: 'worker', outcome: 'completed', counts: { inserted: 7 } })
  recordEvent({ kind: 'sync', operation: 'backfill', surface: 'worker', outcome: 'failed', counts: { inserted: 2 } })
  expect(historySummary(parseHistoryFilters({ operation: 'backfill', outcome: 'failed' })).inserted).toBe(2)
})

it('exports exact run timing and distinguishes a live window from a sync duration', () => {
  const start = new Date('2026-09-08T23:55:00Z'), finish = new Date('2026-09-08T23:55:02.125Z')
  db.insert(historyEvents).values([
    { kind: 'sync', operation: 'contacts', surface: 'worker', actorLabel: 'Worker', occurredAt: start, finishedAt: finish, outcome: 'completed', counts: { contacts: 0 } },
    { kind: 'sync', operation: 'backfill', surface: 'worker', actorLabel: 'Worker', occurredAt: start, outcome: 'running' },
    { kind: 'sync', operation: 'live', surface: 'worker', actorLabel: 'Worker', occurredAt: start, finishedAt: finish, outcome: 'completed', counts: { inserted: 1 } },
  ]).run()
  const lines = [...historyCsv({})].join('').trim().split('\r\n')
  const header = lines[0].split(',').map(s => s.slice(1, -1))
  const cell = (line: string, name: string) => line.split(',')[header.indexOf(name)]
  const contacts = lines.find(l => l.includes('Synced contacts'))!, running = lines.find(l => l.includes('Synced conversation history'))!, live = lines.find(l => l.includes('Received live changes'))!
  expect(cell(contacts, 'Finished (UTC)')).toBe('"2026-09-08T23:55:02.125Z"')
  expect(cell(contacts, 'Duration (seconds)')).toBe('"2.125"')
  expect(cell(running, 'Finished (UTC)')).toBe('""')
  expect(cell(running, 'Duration (seconds)')).toBe('""')
  expect(cell(live, 'Duration (seconds)')).toBe('""')
  expect(cell(live, 'Window end (UTC)')).toBe('"2026-09-09T00:00:00.000Z"')
  expect(cell(live, 'Last change recorded (UTC)')).toBe('"2026-09-08T23:55:02.125Z"')
})

it('records the actual first and latest live-change times within each five-minute window', async () => {
  const source = await makeConnection('telegram')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-08T10:02:03Z'))
  recordLiveChanges(source.id, { inserted: 1 })
  let events = historyPage({ operation: 'live' }).events
  expect(events[0].occurredAt.toISOString()).toBe('2026-09-08T10:00:00.000Z')
  expect(events[0].finishedAt?.toISOString()).toBe('2026-09-08T10:02:03.000Z')
  vi.setSystemTime(new Date('2026-09-08T10:04:59Z'))
  recordLiveChanges(source.id, { inserted: 1 })
  events = historyPage({ operation: 'live' }).events
  expect(events).toHaveLength(1)
  expect(events[0].counts.inserted).toBe(2)
  expect(events[0].finishedAt?.toISOString()).toBe('2026-09-08T10:04:59.000Z')
  vi.setSystemTime(new Date('2026-09-08T10:05:01Z'))
  recordLiveChanges(source.id, { inserted: 1 })
  expect(historyPage({ operation: 'live' }).events).toHaveLength(2)
})
