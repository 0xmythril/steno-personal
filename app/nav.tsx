import Link from 'next/link'
import { logoutAction } from '@/app/login/actions'
import { BrandLogo, Wordmark } from '@/app/brand-logo'

export type NavPage = 'chats' | 'connections' | 'settings'

const LINKS: { page: NavPage; href: string; text: string }[] = [
  { page: 'chats', href: '/', text: 'Chats' },
  { page: 'connections', href: '/connections', text: 'Connections' },
  { page: 'settings', href: '/settings', text: 'Settings' },
]

// Three pages, and the session's key label with a Log out where the shared
// design system draws an avatar: this edition signs in with access keys.
export function Nav({ label, current }: { label: string; current: NavPage }) {
  return (
    <nav className="top" aria-label="Main">
      <Link href="/" className="brand"><BrandLogo size={24} /><Wordmark /></Link>
      <div className="links">
        {LINKS.map(l => (
          <Link key={l.page} href={l.href} className={l.page === current ? 'on' : undefined} aria-current={l.page === current ? 'page' : undefined}>{l.text}</Link>
        ))}
      </div>
      <span className="session">
        key <code>{label}</code>
        <form action={logoutAction} className="inline"><button type="submit">Log out</button></form>
      </span>
    </nav>
  )
}
