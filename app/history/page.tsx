import Link from 'next/link'
import { requireSession } from '@/lib/auth'
import { parseHistoryFilters } from '@/lib/services/history'
import { pendingDisputeCount } from '@/lib/services/disputes'
import { HistoryShell, HistoryTabs, HistoryHead, HistoryFiltersForm, HistoryFeed, HistoryRetention, historyHref, type Params } from './components'
export default async function HistoryPage({ searchParams }: { searchParams: Promise<Params> }) {
  const session = await requireSession(), params = await searchParams
  let filters
  try { filters = parseHistoryFilters(params) } catch { return <HistoryShell session={session}><h1>Invalid history filters</h1><Link href="/history">Clear filters</Link></HistoryShell> }
  const pending = pendingDisputeCount()
  return <HistoryShell session={session}><HistoryHead exportHref={historyHref('/api/history/export', params)}>See what arrived, what was read, and what needs your attention.</HistoryHead><HistoryTabs active="activity" />
    {pending > 0 && <div className="history-attention"><div><strong>{pending} {pending === 1 ? 'dispute needs' : 'disputes need'} a decision</strong><p className="help">Different versions of messages already in your archive.</p></div><Link href="/history/disputes">Review →</Link></div>}
    <HistoryFiltersForm params={params} /><HistoryFeed filters={filters} params={params} /><HistoryRetention />
  </HistoryShell>
}
