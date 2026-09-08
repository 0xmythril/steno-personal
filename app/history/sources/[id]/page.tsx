import Link from 'next/link'
import { eq } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { db } from '@/lib/db/client'
import { connections } from '@/lib/db/schema'
import { requireSession } from '@/lib/auth'
import { historyOptions, historySummary, parseHistoryFilters, keyActor, safeHistoryLabel } from '@/lib/services/history'
import { pendingDisputeCount } from '@/lib/services/disputes'
import { HistoryShell, HistoryHead, HistoryFiltersForm, HistoryFeed, HistoryRetention, historyHref, type Params } from '../../components'
export default async function SourceHistory({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Params> }) {
  const session = await requireSession(), { id } = await params, sp = await searchParams
  const source = db.select({ id: connections.id, mode: connections.mode, displayName: connections.displayName, channel: connections.channel, pushKeyId: connections.pushKeyId, lastSyncAt: connections.lastSyncAt, lastPushKeyId: connections.lastPushKeyId }).from(connections).where(eq(connections.id, id)).get()
  const snapshot = historyOptions().sources.find(s => s.id === id)
  if (!source && !snapshot) notFound()
  let filters
  try { filters = { ...parseHistoryFilters(sp), source: id } } catch { return <HistoryShell session={session}><h1>Invalid history filters</h1><Link href={`/history/sources/${id}`}>Clear filters</Link></HistoryShell> }
  const summary = historySummary(filters), pending = pendingDisputeCount(id)
  const label = source ? safeHistoryLabel(source.displayName, source.channel) : snapshot!.label
  return <HistoryShell session={session}><Link href="/history">← All activity</Link><HistoryHead title={label} exportHref={historyHref('/api/history/export', sp, { source: id })}>{source ? `${source.mode === 'push' ? 'Push source' : 'Paired account'}${source.pushKeyId ? ` · Created by ${keyActor(source.pushKeyId).label}` : ''}` : 'Deleted source · Retained activity'}</HistoryHead>
    <div className="history-summary"><div><p className="eyebrow">Latest push</p><strong>{source?.mode === 'push' && source.lastSyncAt ? source.lastSyncAt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'Not recorded'}</strong>{source?.lastPushKeyId && <p className="help">↑ {keyActor(source.lastPushKeyId).label}</p>}</div><div><p className="eyebrow">Recorded additions</p><strong>{summary.inserted}</strong><p className="help">In the selected period</p></div><div><p className="eyebrow">Pushes with conflicts</p><strong>{summary.conflictedPushes ?? 0} of {summary.pushes ?? 0}</strong><p className="help">In retained activity</p></div><div><p className="eyebrow">Unresolved</p><strong>{pending}</strong><Link href={`/history/disputes?source=${id}`}>Review disputes →</Link></div></div>
    <h2>Activity for this source</h2><HistoryFiltersForm params={sp} source={id} /><HistoryFeed filters={filters} params={sp} base={`/history/sources/${id}`} /><HistoryRetention />
  </HistoryShell>
}
