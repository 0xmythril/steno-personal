import Link from 'next/link'
import { requireSession } from '@/lib/auth'
import { Nav } from '@/app/nav'
import { listChats, CHAT_CHANNELS } from '@/lib/services/queries'
import type { Channel } from '@/lib/channels/port'
import { hasActiveConnection, listSources } from '@/lib/services/connections'
import { formatRelativeTime, CHANNEL_LABELS, sourceLabel } from '@/lib/format'
import { NO_CONNECTION } from '@/lib/mcp/copy'

const KIND_LABELS = { dm: 'Direct', group: 'Group', channel: 'Channel' } as const

const isChannel = (v: unknown): v is Channel => typeof v === 'string' && (CHAT_CHANNELS as readonly string[]).includes(v)

export default async function ChatsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession()
  const sp = await searchParams
  const sources = await listSources()
  // Anything but a known channel means "all" — the value comes from a URL.
  const channel = isChannel(sp.channel) ? sp.channel : undefined
  // Anything but a known source id means "all" — the value comes from a URL.
  const source = typeof sp.source === 'string' ? sources.find(s => s.id === sp.source) : undefined
  const [chats, connected] = await Promise.all([listChats({ channel, sourceId: source?.id }), hasActiveConnection()])

  return (
    <>
      <Nav label={session.label} via={session.via} current="chats" />
      <main>
        <div className="page-head">
          <div><p className="eyebrow">Archive</p><h1>Chats</h1></div>
          <span className="sub mono">{chats.length} {chats.length === 1 ? 'chat' : 'chats'}</span>
        </div>

        {!connected && (
          // A short pointer, never a second copy of the consent copy — that has
          // exactly one home, on the connections screen. The sentence is the
          // same one the MCP tools give an agent.
          <div className="banner">
            <div>
              <strong>{NO_CONNECTION}</strong>
              <Link href="/connections">Connect one</Link> to start archiving.
              {chats.length > 0 && ' Everything already archived stays readable below.'}
            </div>
          </div>
        )}

        <div className="chips" role="group" aria-label="Filter by channel">
          {channel || source ? <Link className="chip filter" href="/">All</Link> : <span className="chip">All</span>}
          {CHAT_CHANNELS.map(ch => (
            channel === ch
              ? <span key={ch} className="chip">{CHANNEL_LABELS[ch]}</span>
              : <Link key={ch} className="chip filter" href={`/?channel=${ch}`}>{CHANNEL_LABELS[ch]}</Link>
          ))}
          {sources.map(s => (
            source?.id === s.id
              ? <span key={s.id} className="chip">{s.label ?? sourceLabel(s.channel)}</span>
              : <Link key={s.id} className="chip filter" href={`/?source=${s.id}`}>{s.label ?? sourceLabel(s.channel)}</Link>
          ))}
        </div>

        {chats.length === 0 ? (
          <div className="empty">
            <h2>{
              source ? `No chats pushed to ${source.label ?? sourceLabel(source.channel)} yet.`
                : channel ? `No ${CHANNEL_LABELS[channel]} chats archived yet.`
                : 'No chats archived yet.'
            }</h2>
            <p>Chats appear here as soon as a connected account has archived one.</p>
          </div>
        ) : (
          <div className="tbl"><div className="scroll">
            <table>
              <thead><tr><th>Chat</th><th>Channel</th><th>Kind</th><th className="num">Messages</th><th>Last message</th></tr></thead>
              <tbody>
                {chats.map(c => (
                  <tr key={c.id}>
                    <td className="name"><Link href={`/chats/${c.id}`}>{c.title ?? 'Untitled chat'}</Link></td>
                    <td>{sourceLabel(c.channel)}{c.pushers.length > 0 && (
                      <> <span className="chip note">pushed by {c.pushers.length === 1 ? c.pushers[0] : `${c.pushers.length} keys`}</span></>
                    )}</td>
                    <td className="muted">{KIND_LABELS[c.kind]}</td>
                    <td className="num">{c.messageCount.toLocaleString('en')}</td>
                    <td className="muted mono">{formatRelativeTime(c.lastMessageAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div></div>
        )}
      </main>
    </>
  )
}
