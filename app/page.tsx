import Link from 'next/link'
import { requireSession } from '@/lib/auth'
import { Nav } from '@/app/nav'
import { listChats, CHAT_CHANNELS, type ChatChannel } from '@/lib/services/queries'
import { hasActiveConnection } from '@/lib/services/connections'
import { formatRelativeTime, CHANNEL_LABELS } from '@/lib/format'

const KIND_LABELS = { dm: 'Direct', group: 'Group', channel: 'Channel' } as const

const isChannel = (v: unknown): v is ChatChannel => typeof v === 'string' && (CHAT_CHANNELS as readonly string[]).includes(v)

export default async function ChatsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession()
  const sp = await searchParams
  // Anything but a known channel means "all" — the value comes from a URL.
  const channel = isChannel(sp.channel) ? sp.channel : undefined
  const [chats, connected] = await Promise.all([listChats({ channel }), hasActiveConnection()])

  return (
    <main>
      <Nav label={session.label} />
      <h1>Chats</h1>

      {!connected && (
        // A short pointer, never a second copy of the consent copy — that has
        // exactly one home, on the connections screen.
        <p className="muted">
          No account is connected. <Link href="/connections">Connect one</Link> to start archiving.
          {chats.length > 0 && ' Everything already archived stays readable below.'}
        </p>
      )}

      <p className="muted">
        Show:{' '}
        {channel ? <Link href="/">All</Link> : <strong>All</strong>}
        {CHAT_CHANNELS.map(ch => (
          <span key={ch}>
            {' · '}
            {channel === ch ? <strong>{CHANNEL_LABELS[ch]}</strong> : <Link href={`/?channel=${ch}`}>{CHANNEL_LABELS[ch]}</Link>}
          </span>
        ))}
      </p>

      {chats.length === 0 ? (
        <p className="muted">{channel ? `No ${CHANNEL_LABELS[channel]} chats archived yet.` : 'No chats archived yet.'}</p>
      ) : (
        <table>
          <thead><tr><th>Chat</th><th>Channel</th><th>Kind</th><th>Messages</th><th>Last message</th></tr></thead>
          <tbody>
            {chats.map(c => (
              <tr key={c.id}>
                <td><Link href={`/chats/${c.id}`}>{c.title ?? 'Untitled chat'}</Link></td>
                <td className="muted">{CHANNEL_LABELS[c.channel]}</td>
                <td className="muted">{KIND_LABELS[c.kind]}</td>
                <td className="muted">{c.messageCount}</td>
                <td className="muted">{formatRelativeTime(c.lastMessageAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}
