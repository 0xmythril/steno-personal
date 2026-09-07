import { and, desc, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { db, type Db } from '@/lib/db/client'
import { accessKeys, connections, historyEvents, historySources, historyState } from '@/lib/db/schema'

export type Store = Pick<Db, 'select' | 'insert' | 'update' | 'delete'>
export const HISTORY_DAYS = 90
export const HISTORY_LIMIT = 10_000
export const OPERATIONS = {
  push: 'Pushed a batch', list_chats: 'Listed chats', get_messages: 'Read messages', recent_messages: 'Read recent messages',
  search_messages: 'Searched messages', list_people: 'Listed people', get_media: 'Read an attachment', whoami: 'Read sources',
  export_chat: 'Exported a chat', portal_chats: 'Opened chats', portal_chat: 'Opened a conversation', portal_people: 'Opened people', portal_person: 'Opened a person',
  backfill: 'Synced conversation history', contacts: 'Synced contacts', live: 'Received live changes',
  key_created: 'Created a key', key_renamed: 'Renamed a key', key_revoked: 'Revoked a key',
  source_created: 'Created a source', source_connected: 'Connected a source', source_revoked: 'Disconnected a source', source_deleted: 'Deleted a source', source_error: 'Source needs attention',
  keep: 'Kept stored version', accept: 'Accepted incoming version', delete_message: 'Deleted disputed message', purge: 'Removed key contributions',
} as const
export type Operation = keyof typeof OPERATIONS
export type HistoryKind = typeof historyEvents.$inferSelect.kind
export type HistorySurface = typeof historyEvents.$inferSelect.surface
export type HistoryActor = { id: string | null; label: string }
export const OWNER: HistoryActor = { id: null, label: 'Owner' }
export const WORKER: HistoryActor = { id: null, label: 'Worker' }
const countsSchema = z.object(Object.fromEntries(['entries', 'inserted', 'duplicates', 'edited', 'deleted', 'conflicts', 'returned', 'sources', 'candidates', 'contacts'].map(k => [k, z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()]))).strict()

// History snapshots never fall back to account IDs; strip identifier-shaped
// labels too, including WhatsApp JIDs, phone numbers and pasted credentials.
export function safeHistoryLabel(label: string | null | undefined, fallback: string): string {
  const s = (label ?? '').trim().slice(0, 100)
  if (!s || /sp_[A-Za-z0-9_-]+|\d{5,}|@(?:s\.whatsapp\.net|lid|g\.us)/i.test(s)) return fallback
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ')
}
export function keyActor(id: string, store: Store = db): HistoryActor {
  const key = store.select({ label: accessKeys.label }).from(accessKeys).where(eq(accessKeys.id, id)).get()
  return { id, label: safeHistoryLabel(key?.label, 'Access key') }
}
export function recordEvent(input: {
  kind: HistoryKind; operation: Operation; surface?: HistorySurface; actor?: HistoryActor; sourceIds?: string[];
  subjectKeyId?: string; counts?: Record<string, number>; outcome?: typeof historyEvents.$inferSelect.outcome; now?: Date; runId?: string;
}, store: Store = db): string {
  const now = input.now ?? new Date()
  const counts = countsSchema.parse(input.counts ?? {}) as Record<string, number>
  if (!(input.operation in OPERATIONS)) throw new Error('invalid_history_operation')
  store.insert(historyState).values({ id: 1, enabledAt: now }).onConflictDoNothing().run()
  const actor = input.actor ?? (input.surface === 'worker' ? WORKER : OWNER)
  const event = store.insert(historyEvents).values({ kind: input.kind, operation: input.operation,
    surface: input.surface ?? 'portal', subjectKeyId: input.subjectKeyId, subjectLabel: input.subjectKeyId ? keyActor(input.subjectKeyId, store).label : null, actorId: actor.id, actorLabel: safeHistoryLabel(actor.label, 'Owner'),
    counts, occurredAt: now, finishedAt: input.outcome === 'running' ? null : now, outcome: input.outcome ?? 'completed', runId: input.runId,
  }).returning({ id: historyEvents.id }).get()
  const ids = [...new Set(input.sourceIds ?? [])]
  for (const id of ids) {
    const source = store.select({ label: connections.displayName, channel: connections.channel }).from(connections).where(eq(connections.id, id)).get()
    if (source) store.insert(historySources).values({ eventId: event.id, sourceId: id, label: safeHistoryLabel(source.label, source.channel), channel: source.channel }).run()
  }
  return event.id
}
export function finishEvent(id: string, counts: Record<string, number>, outcome: 'completed' | 'failed' | 'interrupted', store: Store = db) {
  store.update(historyEvents).set({ counts: countsSchema.parse(counts) as Record<string, number>, outcome, finishedAt: new Date() }).where(and(eq(historyEvents.id, id), eq(historyEvents.outcome, 'running'))).run()
}

export function trimHistory(now = new Date(), limit = HISTORY_LIMIT, days = HISTORY_DAYS) {
  return db.transaction(tx => {
    const cutoff = new Date(now.getTime() - days * 86_400_000)
    const removed = tx.delete(historyEvents).where(and(lt(historyEvents.occurredAt, cutoff), sql`${historyEvents.outcome} != 'running'`)).returning({ id: historyEvents.id }).all()
    const excess = tx.select({ id: historyEvents.id }).from(historyEvents).where(sql`${historyEvents.outcome} != 'running'`)
      .orderBy(desc(historyEvents.occurredAt), desc(historyEvents.id)).limit(HISTORY_LIMIT + 1000).offset(limit).all()
    for (let i = 0; i < excess.length; i += 200) tx.delete(historyEvents).where(inArray(historyEvents.id, excess.slice(i, i + 200).map(e => e.id))).run()
    if (removed.length || excess.length) tx.update(historyState).set({ trimmedAt: now }).where(eq(historyState.id, 1)).run()
    return removed.length + excess.length
  })
}

export type HistoryFilters = { kind?: HistoryKind; source?: string; actor?: string; from?: Date; to?: Date; cursor?: string; until?: string }
const kinds: HistoryKind[] = ['push', 'read', 'sync', 'key', 'connection', 'resolution', 'purge']
export const HISTORY_KINDS = kinds
export function parseHistoryFilters(params: Record<string, string | string[] | undefined>): HistoryFilters {
  const one = (key: string) => typeof params[key] === 'string' ? params[key] as string : undefined
  const date = (key: string) => {
    const s = one(key); if (!s) return undefined
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s) throw new Error('invalid_history_date')
    return new Date(Date.parse(s) + (key === 'to' ? 86_400_000 : 0))
  }
  const kind = one('kind'); if (kind && !kinds.includes(kind as HistoryKind)) throw new Error('invalid_history_kind')
  const from = date('from'), to = date('to'); if (from && to && from >= to) throw new Error('invalid_history_range')
  const cursor = one('cursor'), until = one('until')
  for (const c of [cursor, until]) if (c && !/^\d{1,16}_[a-f0-9-]{36}$/.test(c)) throw new Error('invalid_history_cursor')
  return { kind: kind as HistoryKind | undefined, source: one('source')?.slice(0, 100), actor: one('actor')?.slice(0, 100), from, to, cursor, until }
}
export function eventCursor(row: { occurredAt: Date; id: string }) { return `${row.occurredAt.getTime()}_${row.id}` }
function whereHistory(f: HistoryFilters): SQL | undefined {
  const terms: SQL[] = []
  if (f.kind) terms.push(eq(historyEvents.kind, f.kind))
  if (f.actor) terms.push(or(eq(historyEvents.actorId, f.actor), eq(historyEvents.subjectKeyId, f.actor))!)
  if (f.source) terms.push(sql`exists (select 1 from event_sources es where es.event_id = ${historyEvents.id} and es.source_id = ${f.source})`)
  if (f.from) terms.push(sql`${historyEvents.occurredAt} >= ${f.from.getTime()}`)
  if (f.to) terms.push(lt(historyEvents.occurredAt, f.to))
  for (const [c, inclusive] of [[f.cursor, false], [f.until, true]] as const) if (c) {
    const [ms, id] = c.split('_'); const at = new Date(Number(ms))
    terms.push(or(lt(historyEvents.occurredAt, at), and(eq(historyEvents.occurredAt, at), inclusive ? sql`${historyEvents.id} <= ${id}` : lt(historyEvents.id, id)))!)
  }
  return and(...terms)
}
export function historyPage(filters: HistoryFilters = {}, limit = 50) {
  const rows = db.select().from(historyEvents).where(whereHistory(filters)).orderBy(desc(historyEvents.occurredAt), desc(historyEvents.id)).limit(Math.min(limit, 200) + 1).all()
  const page = rows.slice(0, Math.min(limit, 200))
  const sources = page.length ? db.select().from(historySources).where(inArray(historySources.eventId, page.map(r => r.id))).all() : []
  return { events: page.map(e => ({ ...e, sources: sources.filter(s => s.eventId === e.id) })), nextCursor: rows.length > page.length ? eventCursor(page[page.length - 1]) : null }
}
export function historyOptions() {
  return {
    sources: db.selectDistinct({ id: historySources.sourceId, label: historySources.label }).from(historySources).all(),
    actors: [...db.selectDistinct({ id: historyEvents.actorId, label: historyEvents.actorLabel }).from(historyEvents).where(sql`${historyEvents.actorId} is not null`).all(), ...db.selectDistinct({ id: historyEvents.subjectKeyId, label: historyEvents.subjectLabel }).from(historyEvents).where(sql`${historyEvents.subjectKeyId} is not null`).all()],
    state: db.select().from(historyState).get(),
  }
}
export function historySummary(filters: HistoryFilters) {
  return db.select({ events: sql<number>`count(*)`, pushes: sql<number>`sum(case when kind = 'push' then 1 else 0 end)`,
    conflictedPushes: sql<number>`sum(case when kind = 'push' and json_extract(counts, '$.conflicts') > 0 then 1 else 0 end)`,
    inserted: sql<number>`coalesce(sum(json_extract(counts, '$.inserted')), 0)`,
  }).from(historyEvents).where(whereHistory({ ...filters, cursor: undefined, until: undefined })).get()!
}
export function csvCell(value: unknown) {
  let s = String(value ?? '')
  if (/^[\s]*[=+\-@\t\r\n]/.test(s)) s = `'${s}`
  return `"${s.replaceAll('"', '""')}"`
}
export function* historyCsv(filters: HistoryFilters) {
  yield ['Time (UTC)', 'Kind', 'Operation', 'Surface', 'Actor', 'Affected key', 'Sources', 'Outcome', 'Counts'].map(csvCell).join(',') + '\r\n'
  const first = historyPage({ ...filters, cursor: undefined }, 1).events[0]
  if (!first) return
  let cursor: string | undefined
  do {
    const page = historyPage({ ...filters, cursor, until: eventCursor(first) }, 200)
    for (const row of page.events) yield [row.occurredAt.toISOString(), row.kind, OPERATIONS[row.operation as Operation], row.surface, row.actorLabel, row.subjectLabel, row.sources.map(s => s.label).join('; '), row.outcome,
      Object.entries(row.counts).map(([k, n]) => `${k}: ${n}`).join('; ')].map(csvCell).join(',') + '\r\n'
    cursor = page.nextCursor ?? undefined
  } while (cursor)
}

// A durable five-minute bucket, updated inside the same transaction as live
// ingest. Unlike process-local counters it survives an interrupted worker.
export function recordLiveChanges(sourceId: string, counts: Record<string, number>, store: Store = db) {
  const bucket = Math.floor(Date.now() / 300_000) * 300_000
  const runId = `live:${sourceId}:${bucket}`
  const existing = store.select().from(historyEvents).where(eq(historyEvents.runId, runId)).get()
  if (existing) {
    const merged = { ...existing.counts }
    for (const [k, n] of Object.entries(counts)) merged[k] = (merged[k] ?? 0) + n
    store.update(historyEvents).set({ counts: merged, finishedAt: new Date() }).where(eq(historyEvents.id, existing.id)).run()
  } else recordEvent({ kind: 'sync', operation: 'live', surface: 'worker', sourceIds: [sourceId], counts, runId, now: new Date(bucket) }, store)
}

// Called only by the worker entrypoint, before it starts any runs. This
// deployment has one worker per archive; web processes never reconcile runs.
export function interruptAbandonedRuns() {
  db.update(historyEvents).set({ outcome: 'interrupted', finishedAt: new Date() }).where(eq(historyEvents.outcome, 'running')).run()
}

export function lastPushesForChats(ids: string[]) {
  const result = new Map<string, { at: Date; label: string }>()
  if (!ids.length) return result
  // Read only the page's known chats, preserving unknown legacy values.
  for (let i = 0; i < ids.length; i += 200) {
    const rows = db.all<{ id: string; at: number; label: string | null }>(sql`select c.id, c.last_push_at as at, k.label from chats c left join access_keys k on k.id = c.last_push_key_id where c.id in (${sql.join(ids.slice(i, i + 200).map(id => sql`${id}`), sql`, `)}) and c.last_push_at is not null`)
    for (const row of rows) result.set(row.id, { at: new Date(row.at), label: safeHistoryLabel(row.label, 'Unknown key') })
  }
  return result
}


export function formatHistoryCounts(counts: Record<string, number>) {
  const singular: Record<string, string> = { entries: 'entry', duplicates: 'duplicate', conflicts: 'conflict', sources: 'source', candidates: 'disputed copy', contacts: 'contact' }
  return Object.entries(counts).map(([k, n]) => `${n} ${n === 1 ? singular[k] ?? k : k === 'candidates' ? 'disputed copies' : k}`).join(' · ')
}
