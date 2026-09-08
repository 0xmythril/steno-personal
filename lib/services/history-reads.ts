import { inArray, sql } from 'drizzle-orm'
import { headers } from 'next/headers'
import { authenticateRequest, currentSession, type PortalSession } from '@/lib/auth'
import { db } from '@/lib/db/client'
import { chats, historyState, messages } from '@/lib/db/schema'
import { log } from '@/lib/log'
import { keyActor, recordEvent, trimHistory, type HistoryActor, type HistorySurface, type Operation } from './history'

// Project only counts and local source references out of results. Text, query
// terms, tool arguments, media bytes and credentials never enter the event.
export function readSummary(result: unknown): { returned: number; sourceIds: string[] } {
  const sources = new Set<string>(), localIds = new Set<string>(), chatIds = new Set<string>()
  function inspect(value: unknown, depth = 0) {
    if (depth > 5 || !value || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const item of value) inspect(item, depth + 1); return }
    const row = value as Record<string, unknown>
    if ((row.mode === 'live' || row.mode === 'push') && typeof row.id === 'string') sources.add(row.id)
    if (typeof row.connectionId === 'string') sources.add(row.connectionId)
    if (typeof row.chatId === 'string') chatIds.add(row.chatId)
    if (typeof row.id === 'string') localIds.add(row.id)
    for (const name of ['chats', 'messages', 'results', 'people', 'connections', 'chat', 'person', 'media']) if (row[name]) inspect(row[name], depth + 1)
  }
  inspect(result)
  const ids = [...localIds, ...chatIds]
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200)
    for (const c of db.select({ source: chats.connectionId }).from(chats).where(inArray(chats.id, part)).all()) sources.add(c.source)
    for (const m of db.select({ chat: messages.chatId }).from(messages).where(inArray(messages.id, part)).all()) chatIds.add(m.chat)
  }
  const cids = [...chatIds]
  for (let i = 0; i < cids.length; i += 200) for (const c of db.select({ source: chats.connectionId }).from(chats).where(inArray(chats.id, cids.slice(i, i + 200))).all()) sources.add(c.source)
  let returned = 0
  if (Array.isArray(result)) returned = result.length
  else if (result && typeof result === 'object') {
    const row = result as Record<string, unknown>
    const array = ['messages', 'results', 'chats', 'people', 'connections'].map(k => row[k]).find(Array.isArray)
    returned = array ? array.length : row.id || row.chat ? 1 : 0
  }
  return { returned, sourceIds: [...sources] }
}
export function recordRead(operation: Operation, actor: HistoryActor, surface: HistorySurface, result: unknown, failed = false, requestedSourceId?: string) {
  try {
    const summary = readSummary(result)
    recordEvent({ kind: 'read', operation, actor, surface, sourceIds: requestedSourceId ? [...summary.sourceIds, requestedSourceId] : summary.sourceIds, counts: { returned: summary.returned }, outcome: failed ? 'failed' : 'completed' })
    trimHistory()
  } catch {
    // Archive availability wins if metadata recording fails. No result/error
    // payload is logged. A persistent counter makes degraded coverage visible.
    log.error({}, 'history read recording failed')
    try { db.insert(historyState).values({ id: 1, readFailures: 1 }).onConflictDoUpdate({ target: historyState.id, set: { readFailures: sql`${historyState.readFailures} + 1` } }).run() } catch { /* Database itself may be unavailable. */ }
  }
}
export async function recordPortalRead(session: PortalSession, operation: Operation, result: unknown) {
  const h = await headers()
  if (h.has('next-router-prefetch') || h.get('purpose') === 'prefetch' || h.get('sec-purpose')?.includes('prefetch')) return
  recordRead(operation, { id: session.keyId ?? session.passkeyId, label: session.label }, 'portal', result)
}
export function withHistoryRead<A extends unknown[]>(operation: Operation, handler: (request: Request, ...args: A) => Promise<Response>) {
  return async (request: Request, ...args: A): Promise<Response> => {
    const response = await handler(request, ...args)
    if (response.status === 401 || response.status === 403) return response
    try {
      const auth = await authenticateRequest(request)
      if (!auth) return response
      const session = auth.via === 'cookie' ? await currentSession() : null
      const actor = session ? { id: session.keyId ?? session.passkeyId, label: session.label } : auth.keyId ? keyActor(auth.keyId) : { id: null, label: 'Owner' }
      let result: unknown = null
      if (response.headers.get('Content-Type')?.includes('application/json')) result = await response.clone().json()
      // Media responses are streams: do not buffer or clone their bytes.
      else if (operation === 'get_media' && response.ok) result = { id: new URL(request.url).pathname.split('/').pop() }
      recordRead(operation, actor, 'api', result, !response.ok, new URL(request.url).searchParams.get('source') ?? undefined)
    } catch { log.error({}, 'history request recording failed') }
    return response
  }
}
