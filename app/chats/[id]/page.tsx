import { Fragment } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireSession } from '@/lib/auth'
import { Nav } from '@/app/nav'
import { getMessages } from '@/lib/services/queries'
import { groupRuns, groupByDate } from '@/lib/transcript'
import { formatTime } from '@/lib/format'

const PAGE_SIZE = 100

// Read-only by construction: there is no reply box and nowhere to type,
// because the connection physically cannot send. A structural test asserts the
// absence, so nothing here may grow a form, an input, or a submit control.
export default async function ChatPage({ params, searchParams }: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ cursor?: string | string[] }>
}) {
  const session = await requireSession()
  const { id } = await params
  const sp = await searchParams
  const cursor = typeof sp.cursor === 'string' ? sp.cursor : undefined

  const page = await getMessages(id, { limit: PAGE_SIZE, cursor })
  if (!page) notFound()

  // The query returns newest-first; a conversation reads oldest-first.
  const chronological = [...page.messages].reverse()

  return (
    <main>
      <Nav label={session.label} />
      <p className="muted"><Link href="/">&larr; All chats</Link></p>
      <h1>{page.chat.title ?? 'Untitled chat'}</h1>
      <p className="muted">Read-only archive &middot; {page.chat.messageCount} messages</p>

      {page.nextCursor && (
        <p>
          <Link href={`/chats/${page.chat.id}?cursor=${encodeURIComponent(page.nextCursor)}`}>Older messages</Link>
        </p>
      )}

      {chronological.length === 0 ? (
        <p className="muted">No messages archived in this chat yet.</p>
      ) : (
        <ul className="transcript">
          {groupByDate(chronological).map(group => (
            <Fragment key={group.dateLabel}>
              <li className="date-sep">{group.dateLabel}</li>
              {groupRuns(group.messages).map(run => (
                <li key={run.messages[0].id} className="msg-run">
                  <p className="msg-meta">
                    <strong>{run.isMe ? 'You' : run.senderLabel}</strong>{' '}
                    <span className="muted">{formatTime(run.messages[0].sentAt)}</span>
                  </p>
                  {run.messages.map(m => (
                    <p key={m.id} className="msg-body">
                      {m.text ?? <span className="muted">({m.type})</span>}
                      {m.editedAt && <span className="muted"> (edited)</span>}
                    </p>
                  ))}
                </li>
              ))}
            </Fragment>
          ))}
        </ul>
      )}
    </main>
  )
}
