import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireSession } from '@/lib/auth'
import { purgePreview } from '@/lib/services/disputes'
import { ConfirmDialog } from '@/app/confirm-dialog'
import { HistoryShell, HistoryHead, type Params } from '../../components'
import { purgeAction } from '../../actions'
export default async function PurgePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Params> }) {
  const session = await requireSession(), { id } = await params, sp = await searchParams, preview = purgePreview(id)
  if (!preview) notFound()
  const n = preview.rows.length, copies = preview.candidates.length
  return <HistoryShell session={session}><Link href="/history/keys">← Revoked keys</Link><HistoryHead title={`Data from ${preview.key.label}`}>This key has been revoked. It can no longer read or push.</HistoryHead>
    {sp.changed && <p role="alert" className="banner">The remaining data changed. Review these updated counts before confirming.</p>}
    <div className="history-summary"><div><p className="eyebrow">Messages to remove</p><strong>{n}</strong><p className="help">Originally delivered by this key</p></div><div><p className="eyebrow">Disputed copies</p><strong>{copies}</strong><p className="help">Pending text to remove</p></div></div>
    <div className="tbl"><div className="scroll"><table><thead><tr><th>Source</th><th>From this key</th><th>Other keys · kept</th></tr></thead><tbody>{preview.sources.map(s => <tr key={s.id}><td><Link href={`/history/sources/${s.id}`}>{s.label}</Link></td><td className="mono">{s.remove}</td><td className="mono">{s.keep}</td></tr>)}</tbody></table></div></div>
    <section className="card"><h2>Remove this key’s contributions</h2><p>Remove {n} {n === 1 ? 'message' : 'messages'} originally delivered by this key and {copies} pending disputed {copies === 1 ? 'copy' : 'copies'}. Messages originally delivered by other keys remain. Empty affected sources are removed; sources containing deletion records are kept.</p><p className="help">This follows the original delivering key. It does not undo later accepted edits by this key on other keys’ messages. Activity retains a record without message text.</p>
      <div className="history-actions">{(n > 0 || copies > 0) && <ConfirmDialog trigger="Remove contributions…" title={`Remove ${n} messages and ${copies} disputed copies?`} body="The reviewed contributions will be removed from your Steno archive. Messages delivered by other keys remain. This cannot be undone."><form action={purgeAction}><input type="hidden" name="id" value={id} /><input type="hidden" name="token" value={preview.token} /><button type="submit" className="danger">Remove contributions</button></form></ConfirmDialog>}<Link href="/history/keys">Keep data</Link></div>
    </section></HistoryShell>
}
