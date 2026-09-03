import { Fragment } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireSession } from '@/lib/auth'
import { Nav } from '@/app/nav'
import { getMessages } from '@/lib/services/queries'
import { groupRuns, groupByDate, linkify } from '@/lib/transcript'
import { formatTime } from '@/lib/format'
import { MediaAttachment } from './media-attachment'

const PAGE_SIZE = 50

// Read-only by construction: there is no reply box and nowhere to type,
// because the connection physically cannot send. A structural test asserts the
// absence, so nothing here may grow a form, an input, or a submit control.
//
// The layout is the steno pad from DESIGN.md: time in a 64px margin against a
// rule, the speaker and their words beside it.
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
  const olderHref = page.nextCursor ? `/chats/${page.chat.id}?cursor=${encodeURIComponent(page.nextCursor)}` : null
  // "Latest" is the first page, landed at its foot. From the first page
  // itself that is just a scroll; from an older page it is a navigation.
  const latestHref = cursor ? `/chats/${page.chat.id}#bottom` : '#bottom'

  // Older / Latest at both ends of the page, Top only at the foot: a
  // 100-message page is long enough that the reader needs both directions
  // without scrolling to find them. Links only — no control here may send.
  const pager = (
    <p className="pager">
      {olderHref && <Link href={olderHref}>&uarr; Older messages</Link>}
      <Link href={latestHref}>Latest messages &darr;</Link>
    </p>
  )

  return (
    <>
      <Nav label={session.label} via={session.via} current="chats" />
      <main>
        <p className="muted"><Link href="/">&larr; All chats</Link></p>
        <div className="pad">
          <div className="pad-head">
            <h1 id="top">{page.chat.title ?? 'Untitled chat'}</h1>
            <span className="muted mono">
              Read-only archive &middot; {page.chat.messageCount.toLocaleString('en')} messages
              {/* The address book is edited on /people; this page only ever
                  links to it, because nothing here may grow a form. */}
              {page.chat.person
                ? <> &middot; <Link href={`/people/${page.chat.person.id}`}>{page.chat.person.name}</Link></>
                : page.chat.kind === 'dm' && <> &middot; <Link href="/people">Add to people</Link></>}
            </span>
          </div>

          {pager}

          {chronological.length === 0 ? (
            <div className="empty" style={{ border: 0 }}>
              <h2>No messages archived in this chat yet.</h2>
            </div>
          ) : (
            <ul className="transcript">
              {groupByDate(chronological).map(group => (
                <Fragment key={group.dateLabel}>
                  <li className="date-sep">{group.dateLabel}</li>
                  {groupRuns(group.messages).map(run => (
                    <li key={run.messages[0].id} className="msg-run">
                      <span className="msg-time">{formatTime(run.messages[0].sentAt)}</span>
                      <div className="msg-col">
                        <p className={run.isMe ? 'msg-who me' : 'msg-who'}>
                          {run.isMe ? 'You' : run.senderLabel}
                          {run.rawLabel && <span className="muted"> ({run.rawLabel})</span>}
                        </p>
                        {run.messages.map(m => (
                          <div key={m.id} className="msg-body">
                            {m.text === null
                              ? <span className="kind">({m.type})</span>
                              : linkify(m.text).map((seg, i) => seg.kind === 'link'
                                ? <a key={i} href={seg.href} target="_blank" rel="noopener noreferrer nofollow">{seg.value}</a>
                                : <Fragment key={i}>{seg.value}</Fragment>)}
                            {m.editedAt && <span className="edited">edited</span>}
                            {m.media && <MediaAttachment media={m.media} />}
                          </div>
                        ))}
                      </div>
                    </li>
                  ))}
                </Fragment>
              ))}
            </ul>
          )}

          <p className="pager foot" id="bottom">
            {olderHref && <Link href={olderHref}>&uarr; Older messages</Link>}
            {cursor && <Link href={`/chats/${page.chat.id}#bottom`}>Latest messages &darr;</Link>}
            <Link href="#top">Back to top &uarr;</Link>
          </p>
        </div>
      </main>
    </>
  )
}
