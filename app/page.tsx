import { requireSession } from '@/lib/auth'
import { Nav } from '@/app/nav'

export default async function ChatsPage() {
  const s = await requireSession()
  return (
    <main>
      <Nav label={s.label} />
      <h1>Chats</h1>
      <p className="muted">No account is connected yet.</p>
    </main>
  )
}
