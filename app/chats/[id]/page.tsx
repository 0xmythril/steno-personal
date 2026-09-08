import { recordPortalRead } from '@/lib/services/history-reads'
import { Fragment } from 'react'
import { getSettings } from '@/lib/services/settings'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireSession } from '@/lib/auth'
import { Nav } from '@/app/nav'
import { getMessages } from '@/lib/services/queries'
import { listSources } from '@/lib/services/connections'
import { groupRuns, groupByDate, linkify } from '@/lib/transcript'
import { formatTime, formatRelativeTime, KIND_LABELS } from '@/lib/format'
import { MediaAttachment } from './media-attachment'
import { track } from '@/lib/services/telemetry'
import { AlertIcon, DownloadIcon } from '@/app/icons'

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

  const { advancedMode } = await getSettings()
  const [page, sources] = await Promise.all([getMessages(id, { limit: PAGE_SIZE, cursor }), advancedMode ? listSources() : Promise.resolve([])])
  if (!page) notFound()
  // That a transcript was opened. Not which one, and not which page of it.
  track('transcript_viewed', {})

  // listSources() only ever lists pushed connections, so a chat with no
  // pushers has no match here — and the lookup is skipped rather than relied
  // on to fail, since a revoked connection also drops out of the list.
  const source = page.chat.pushers.length > 0 ? sources.find(s => s.id === page.chat.connectionId) : undefined

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

  await recordPortalRead(session, 'portal_chat', page)

  return (
    <>
      <Nav label={session.label} via={session.via} current="chats" />
      <main>
        <p className="muted"><Link href="/">&larr; All chats</Link></p>
        <div className="pad">
          <div className="pad-head">
            <div className="pad-head-top">
              <h1 id="top">{page.chat.title ?? 'Untitled chat'}</h1>
              {/* Top right, level with the title — not a control set apart in
                  its own right-aligned row of prose, and not folded into the
                  left-reading meta column below it. A link, not a button in a
                  form: the transcript may grow no form control, and
                  `download` is enough to make the browser save the response
                  instead of navigating to it. The explanatory sentence this
                  used to carry lives in the accessible name now; the file it
                  downloads, named steno-<chat>-<date>.json, explains itself. */}
              {advancedMode && <a
                className="export-link"
                href={`/api/chats/${page.chat.id}/export`}
                download
                aria-label="Export this chat as a file with every message and who pushed it"
              >
                <DownloadIcon /> Export
              </a>}
            </div>
            <div className="pad-head-meta">
              <span className="muted mono">
                {KIND_LABELS[page.chat.kind]} &middot; {page.chat.messageCount.toLocaleString('en')} {page.chat.messageCount === 1 ? 'message' : 'messages'}
                {/* The address book is edited on /people; this page only ever
                    links to it, because nothing here may grow a form. */}
                {page.chat.person
                  ? <> &middot; <Link href={`/people/${page.chat.person.id}`}>{page.chat.person.name}</Link></>
                  : page.chat.kind === 'dm' && <> &middot; <Link href="/people">Add to people</Link></>}
              </span>
              {/* Second line, quieter: one plain sentence of provenance, not a
                  chip — a chip is a status or a brand mark and this is
                  neither. Pushers come from the messages, so the no-source
                  fallback outlives a revoked source; only the last-push time
                  and who pushed last live on the source row, so only that
                  half is gated on it. */}
              {advancedMode && (source || page.chat.pushers.length > 0) && (
                <span className="muted mono provenance">
                  {source ? (
                    <>
                      last push {formatRelativeTime(source.lastPushAt)}
                      {source.lastPushBy && <> by {source.lastPushBy}</>}
                      {page.chat.pushers.length > 1 && (
                        <> &middot; also pushed by {page.chat.pushers.filter(p => p !== source.lastPushBy).join(', ')}</>
                      )}
                    </>
                  ) : (
                    <>pushed by {page.chat.pushers.join(', ')}</>
                  )}
                </span>
              )}
            </div>
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
                      <span className="msg-time">
                        {formatTime(run.messages[0].sentAt)}
                      </span>
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
                            {/* The owner can compare conflicting versions in History. */}
                            {m.conflictedAt && (
                              <Link
                                href={`/history/disputes/${m.id}`}
                                className="conflict-marker"
                                aria-label="A later push disagreed with this message; the stored version was kept."
                              >
                                <AlertIcon /> conflict
                              </Link>
                            )}
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
