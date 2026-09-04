import Link from 'next/link'
import { logoutAction } from '@/app/login/actions'
import { BrandLogo, Wordmark } from '@/app/brand-logo'

export type NavPage = 'chats' | 'people' | 'connections' | 'settings'

const LINKS: { page: NavPage; href: string; text: string }[] = [
  { page: 'chats', href: '/', text: 'Chats' },
  { page: 'people', href: '/people', text: 'People' },
  { page: 'connections', href: '/connections', text: 'Connections' },
  { page: 'settings', href: '/settings', text: 'Settings' },
]

// Four pages, and the session's credential — `key` or `passkey`, with its
// label — and a Log out where the shared design system draws an avatar: this
// edition signs in with access keys and passkeys, not accounts.
export function Nav({ label, via, current }: { label: string; via: 'key' | 'passkey'; current?: NavPage }) {
  return (
    <nav className="top" aria-label="Main">
      <Link href="/" className="brand"><BrandLogo size={24} /><Wordmark /></Link>
      <div className="links">
        {LINKS.map(l => (
          <Link key={l.page} href={l.href} className={l.page === current ? 'on' : undefined} aria-current={l.page === current ? 'page' : undefined}>{l.text}</Link>
        ))}
      </div>
      <span className="session">
        {via} <code>{label}</code>
        <form action={logoutAction} className="inline"><button type="submit">Log out</button></form>
      </span>
    </nav>
  )
}
