import Link from 'next/link'
import { Nav } from '@/app/nav'
import type { PortalSession } from '@/lib/auth'
import { historyOptions, historyPage, formatHistoryCounts, HISTORY_KINDS, HISTORY_OUTCOMES, SYNC_OPERATIONS, LIVE_WINDOW_MS, OPERATIONS, type HistoryFilters, type Operation } from '@/lib/services/history'
import { pendingDisputeCount } from '@/lib/services/disputes'
import type { ReactNode } from 'react'

export type Params = Record<string, string | string[] | undefined>
export function historyHref(base: string, params: Params, extra: Record<string, string | undefined> = {}) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries({ ...params, ...extra })) if (typeof v === 'string' && v) q.set(k, v)
  return `${base}${q.size ? `?${q}` : ''}`
}
export function HistoryShell({ session, children }: { session: PortalSession; children: ReactNode }) {
  return <><Nav label={session.label} via={session.via} current="history" /><main className="history-page">{children}</main></>
}
export function HistoryTabs({ active }: { active: 'activity' | 'disputes' | 'keys' }) {
  return <div className="history-tabs" role="navigation" aria-label="History views">
    <Link href="/history" aria-current={active === 'activity' ? 'page' : undefined}>Activity</Link>
    <Link href="/history/disputes" aria-current={active === 'disputes' ? 'page' : undefined}>Disputes <span className="history-count">{pendingDisputeCount()}</span></Link>
    <Link href="/history/keys" aria-current={active === 'keys' ? 'page' : undefined}>Revoked keys</Link>
  </div>
}
export function HistoryHead({ title = 'History', children, exportHref }: { title?: string; children: ReactNode; exportHref?: string }) {
  return <div className="page-head"><div><h1>{title}</h1><p className="muted">{children}</p></div>{exportHref && <a className="btn" href={exportHref} download>Export CSV</a>}</div>
}
export function HistoryFiltersForm({ params, source }: { params: Params; source?: string }) {
  const options = historyOptions()
  return <form className="history-filters" method="get">
    {!source && <div className="field"><label htmlFor="source">Source</label><select name="source" id="source" defaultValue={typeof params.source === 'string' ? params.source : ''}><option value="">All sources</option>{Array.from(new Map(options.sources.map(s => [s.id, s])).values()).map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></div>}
    <div className="field"><label htmlFor="kind">Activity</label><select id="kind" name="kind" defaultValue={typeof params.kind === 'string' ? params.kind : ''}><option value="">All activity</option>{HISTORY_KINDS.map(k => <option key={k} value={k}>{k}</option>)}</select></div>
    <div className="field"><label htmlFor="operation">Sync operation</label><select id="operation" name="operation" defaultValue={typeof params.operation === 'string' ? params.operation : ''}><option value="">Any operation</option>{Object.entries(SYNC_OPERATIONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
    <div className="field"><label htmlFor="outcome">Outcome</label><select id="outcome" name="outcome" defaultValue={typeof params.outcome === 'string' ? params.outcome : ''}><option value="">All outcomes</option>{HISTORY_OUTCOMES.map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></div>
    <div className="field"><label htmlFor="actor">Key or actor</label><select id="actor" name="actor" defaultValue={typeof params.actor === 'string' ? params.actor : ''}><option value="">All actors</option>{Array.from(new Map(options.actors.map(a => [a.id, a])).values()).map(a => <option key={a.id} value={a.id!}>{a.label}</option>)}</select></div>
    <div className="field"><label htmlFor="from">From (UTC)</label><input type="date" id="from" name="from" defaultValue={typeof params.from === 'string' ? params.from : ''} /></div>
    <div className="field"><label htmlFor="to">Through (UTC)</label><input type="date" id="to" name="to" defaultValue={typeof params.to === 'string' ? params.to : ''} /></div>
    <div className="history-filter-actions"><button type="submit">Apply</button><Link href={source ? `/history/sources/${source}` : '/history'}>Clear</Link></div>
  </form>
}
export function HistoryFeed({ filters, params, base = '/history' }: { filters: HistoryFilters; params: Params; base?: string }) {
  const page = historyPage(filters)
  return <section className="history-record" aria-label="Recorded activity"><div className="history-record-head"><span>Newest first</span><span>Times in UTC</span></div>
    {page.events.length === 0 ? <div className="empty"><h2>No matching activity</h2><p>Try another filter, or push data to start recording activity.</p></div> : page.events.map(e => <article className="history-event" key={e.id}>
      <time dateTime={e.occurredAt.toISOString()}><span>{e.operation === 'live' ? 'Window start' : e.kind === 'sync' ? 'Started' : 'Recorded'}</span><span>{e.occurredAt.toISOString().slice(0, 10)}</span><span>{e.occurredAt.toISOString().slice(11, 23)}</span></time>
      <div className="history-event-main"><p><span className="history-kind">{e.kind}</span> <strong>{OPERATIONS[e.operation as Operation] ?? 'Activity'}</strong></p>
        {e.subjectLabel && <p className="help">Key: {e.subjectLabel}</p>}<p className="help">{e.sources.map((s, i) => <span key={s.sourceId}>{i > 0 && ' · '}<Link href={`/history/sources/${s.sourceId}`}>{s.label}</Link></span>)}{e.sources.length === 0 && e.kind === 'sync' && 'Source not recorded'}{(e.sources.length > 0 || e.kind === 'sync') && ' · '}{e.surface}</p>
        <p className="help">{Object.keys(e.counts).length ? formatHistoryCounts(e.counts) : e.outcome === 'running' ? 'Counts available when this run finishes.' : 'Counts not recorded.'}</p>
      {e.kind === 'sync' && <HistorySyncTiming event={e} />}
        {e.kind === 'push' && (e.counts.edited || e.counts.conflicts) ? <p className="help">Edits and conflicts are included in duplicates.</p> : null}
      </div><div className="history-event-side"><span>{e.actorLabel}</span><span className={e.outcome === 'failed' || e.counts.conflicts ? 'history-warning' : ''}>{e.outcome}</span>{!!e.counts.conflicts && <Link href={historyHref('/history/disputes', {}, { source: e.sources[0]?.sourceId })}>Review disputes →</Link>}</div>
    </article>)}
    <div className="history-record-head"><span>Message text is never stored in activity. Sources are those returned or explicitly selected.</span>{page.nextCursor && <Link href={historyHref(base, params, { cursor: page.nextCursor })}>Older activity →</Link>}</div>
  </section>
}
function utc(date: Date) { return date.toISOString().replace('T', ' ').replace('Z', ' UTC') }
function HistorySyncTiming({ event: e }: { event: ReturnType<typeof historyPage>['events'][number] }) {
  if (e.operation === 'live') return <p className="help">Grouped five-minute window · {utc(e.occurredAt)} – {utc(new Date(e.occurredAt.getTime() + LIVE_WINDOW_MS))}{e.finishedAt && <> · Last change recorded {utc(e.finishedAt)}</>}</p>
  if (!e.finishedAt) return <p className="help">In progress · End time and duration will appear when this run finishes. Refresh for an update.</p>
  return <p className="help">Ended {utc(e.finishedAt)} · Duration {Math.max(0, (e.finishedAt.getTime() - e.occurredAt.getTime()) / 1000)} seconds</p>
}
export function HistoryRetention() {
  const state = historyOptions().state
  return <div className="history-retention"><p>Activity is kept for 90 days or 10,000 events, whichever expires first. Unresolved disputes are kept separately.</p>{state && <p>Recording began {state.enabledAt.toISOString().slice(0, 10)}.{state.trimmedAt && ' Older activity has expired.'}</p>}{!!state?.readFailures && <p className="history-warning">Some reads could not be recorded. History may be incomplete; see the local operational logs.</p>}</div>
}
