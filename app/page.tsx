import Link from 'next/link'
import { requireSession } from '@/lib/auth'
import { Nav } from '@/app/nav'
import { listChats } from '@/lib/services/queries'
import { hasActiveConnection } from '@/lib/services/connections'
import { formatRelativeTime } from '@/lib/format'

const KIND_LABELS = { dm: 'Direct', group: 'Group', channel: 'Channel' } as const

export default async function ChatsPage() {
  const session = await requireSession()
  const [chats, connected] = await Promise.all([listChats(), hasActiveConnection()])

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

      {chats.length === 0 ? (
        <p className="muted">No chats archived yet.</p>
      ) : (
        <table>
          <thead><tr><th>Chat</th><th>Kind</th><th>Messages</th><th>Last message</th></tr></thead>
          <tbody>
            {chats.map(c => (
              <tr key={c.id}>
                <td><Link href={`/chats/${c.id}`}>{c.title ?? 'Untitled chat'}</Link></td>
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
