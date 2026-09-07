import { splitDifference } from '../../difference'
import Link from 'next/link'
import { requireSession } from '@/lib/auth'
import { getDispute } from '@/lib/services/disputes'
import { safeHistoryLabel } from '@/lib/services/history'
import { ConfirmDialog } from '@/app/confirm-dialog'
import { HistoryShell, HistoryHead, type Params } from '../../components'
import { resolveAction } from '../../actions'

function ChangedText({ text, other }: { text: string | null; other: string | null }) {
  if (text === null) return <em>No text</em>
  if (text === '') return <em>Empty text</em>
  const parts = splitDifference(text, other ?? '')
  return <>{parts.before}<mark>{parts.changed}</mark>{parts.after}</>

}
export default async function DisputePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Params> }) {
  const session = await requireSession(), { id } = await params, sp = await searchParams
  const d = getDispute(id)
  if (!d) return <HistoryShell session={session}><h1>This dispute is no longer open</h1><p>The message was reviewed, edited or removed.</p><Link href="/history/disputes">← All disputes</Link></HistoryShell>
  const candidate = d.candidates.find(c => c.id === sp.candidate) ?? d.candidates[0]
  const fields = (action: string) => <><input type="hidden" name="id" value={id} /><input type="hidden" name="token" value={d.token} /><input type="hidden" name="action" value={action} />{candidate && <input type="hidden" name="candidate" value={candidate.id} />}</>
  return <HistoryShell session={session}><Link href="/history/disputes">← All disputes</Link><HistoryHead title="One message. Two versions.">Compare the text and who supplied it, then decide what belongs in your archive.</HistoryHead>
    {sp.changed && <p role="alert" className="banner">This message changed. Review these latest versions before deciding.</p>}
    <div className="history-comparison-layout"><div className="history-content"><section className="card"><p className="eyebrow">{safeHistoryLabel(d.source.displayName, d.source.channel)}</p><h3>{d.chat.title ?? 'Conversation'} · {d.message.senderName ?? 'Unknown sender'}</h3><p className="help">Message sent {d.message.sentAt.toISOString()} · <Link href={`/chats/${d.chat.id}`}>View transcript →</Link></p></section>
    {d.candidates.length > 1 && <form method="get" className="row"><div className="field"><label htmlFor="candidate">Incoming version</label><select id="candidate" name="candidate" defaultValue={candidate.id}>{d.candidates.map((c, i) => <option key={c.id} value={c.id}>{i + 1}. {c.actor} · {c.lastSeenAt.toISOString()} · {c.occurrences} occurrences</option>)}</select></div><button>Compare version</button></form>}
    <div className="history-comparison"><section className="history-version"><div className="history-version-head"><h3>Stored version</h3><p className="help">↑ {d.storedActor}</p></div><div className="history-speech"><time>{d.message.sentAt.toISOString().slice(11, 16)}</time><div><strong>{d.message.senderName ?? 'Unknown sender'}</strong><p><ChangedText text={d.message.text} other={candidate?.incomingText ?? null} /></p></div></div></section>
    <section className="history-version"><div className="history-version-head"><h3>Incoming version</h3><p className="help">{candidate ? `↑ ${candidate.actor} · ${candidate.lastSeenAt.toISOString()}` : 'Not available'}</p></div>{candidate ? <div className="history-speech"><time>{d.message.sentAt.toISOString().slice(11, 16)}</time><div><strong>{d.message.senderName ?? 'Unknown sender'}</strong><p><ChangedText text={candidate.incomingText} other={d.message.text} /></p></div></div> : <p className="history-legacy">The incoming version was not saved before History was enabled. You can keep the stored version or delete the message.</p>}</section></div>
    <section className="card"><h3>Which version should stay?</h3><p className="help">This changes only your Steno archive. Highlighted text differs between versions.</p><div className="history-actions"><form action={resolveAction}>{fields('keep')}<button>Keep stored</button></form>
      {candidate && <ConfirmDialog trigger="Accept incoming…" title="Accept the incoming version?" body="The selected incoming text replaces the stored text in your Steno archive and is marked as edited. All currently reviewed alternatives are dismissed. The original conversation is unchanged."><form action={resolveAction}>{fields('accept')}<button type="submit" className="danger">Accept incoming</button></form></ConfirmDialog>}
      <ConfirmDialog trigger="Delete message…" title="Delete this archived message?" body="This removes the message and its disputed copies from your Steno archive. The original conversation is unchanged. This cannot be undone."><form action={resolveAction}>{fields('delete')}<button type="submit" className="danger">Delete message</button></form></ConfirmDialog>
    </div></section></div><aside className="card history-aside"><h3>Why this was flagged</h3><p>The incoming message had the same identity but different text, without an explicit edit timestamp. Steno kept the stored version.</p><p><Link href={`/history/sources/${d.source.id}`}>View source history →</Link></p>{candidate && <p>Seen {candidate.occurrences} {candidate.occurrences === 1 ? 'time' : 'times'}. First received {candidate.firstSeenAt.toISOString()}.</p>}</aside></div>
  </HistoryShell>
}
