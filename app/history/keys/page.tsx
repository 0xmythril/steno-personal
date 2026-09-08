import Link from 'next/link'
import { requireSession } from '@/lib/auth'
import { revokedPushKeys } from '@/lib/services/disputes'
import { HistoryShell, HistoryTabs, HistoryHead, type Params } from '../components'
export default async function HistoryKeys({ searchParams }: { searchParams: Promise<Params> }) {
  const session = await requireSession(), params = await searchParams, keys = revokedPushKeys()
  return <HistoryShell session={session}><HistoryHead>Revoked keys can no longer connect. Their contributions may still be in your archive.</HistoryHead><HistoryTabs active="keys" />
    {params.removed && <p role="status" className="banner">The reviewed contributions were removed. Other keys’ messages were kept.</p>}<h2>Revoked push keys</h2>
    {keys.length ? <div className="tbl"><div className="scroll"><table><thead><tr><th>Key</th><th>Revoked (UTC)</th><th>Remaining messages</th><th>Disputed copies</th><th /></tr></thead><tbody>{keys.map(k => <tr key={k.id}><td>{k.label}</td><td className="mono">{k.revokedAt?.toISOString().slice(0, 10)}</td><td className="mono">{k.messageCount}</td><td className="mono">{k.candidateCount}</td><td>{k.messageCount || k.candidateCount ? <Link href={`/history/keys/${k.id}`}>Review data →</Link> : <span className="muted">No remaining data</span>}</td></tr>)}</tbody></table></div></div> : <div className="empty"><h2>No revoked push keys</h2><p>Keys revoked in Settings will appear here.</p><Link href="/settings">Open Settings</Link></div>}
    <p className="help">Revocation stops future access. Removing previously delivered data is a separate decision.</p></HistoryShell>
}
