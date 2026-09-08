import Link from 'next/link'
import { requireSession } from '@/lib/auth'
import { disputeList } from '@/lib/services/disputes'
import { safeHistoryLabel } from '@/lib/services/history'
import { HistoryShell, HistoryTabs, HistoryHead, historyHref, type Params } from '../components'
export default async function DisputesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const session = await requireSession(), params = await searchParams
  const source = typeof params.source === 'string' ? params.source : undefined, key = typeof params.key === 'string' ? params.key : undefined
  const page = disputeList(source, key, typeof params.cursor === 'string' ? params.cursor : undefined)
  return <HistoryShell session={session}><HistoryHead>Review disagreements before changing your archive.</HistoryHead><HistoryTabs active="disputes" />
    {params.resolved && <p role="status" className="banner">Decision recorded in activity.</p>}
    {(source || key) && <p className="help">Showing filtered disputes. <Link href="/history/disputes">Show all</Link></p>}
    <div className="history-section-head"><h2>Needs a decision</h2><p className="help">The stored version stays visible until you choose otherwise.</p></div>
    <section className="history-record">{page.rows.length ? page.rows.map(d => <article key={d.id} className="history-dispute-row"><div><p className="help"><Link href={`/history/sources/${d.sourceId}`}>{safeHistoryLabel(d.sourceLabel, d.channel)}</Link> · {d.conflictedAt?.toISOString().slice(0, 16).replace('T', ' ')} UTC</p><h3>{d.title ?? 'Conversation'} · {d.senderName ?? 'Unknown sender'}</h3><p className="help">Different versions of an archived message</p></div><Link className="btn" href={`/history/disputes/${d.id}`}>Compare →</Link></article>) : <div className="empty"><h2>No unresolved disputes</h2><p>New disagreements will appear here. Decisions are recorded in Activity.</p><Link href="/history">View activity</Link></div>}</section>
    {page.next && <Link href={historyHref('/history/disputes', params, { cursor: page.next })}>More disputes →</Link>}
    <p className="help">Accepting or deleting changes your Steno archive only. Your original conversations are untouched.</p>
  </HistoryShell>
}
