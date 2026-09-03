import Link from 'next/link'
import { logoutAction } from '@/app/login/actions'
import { BrandLogo } from '@/app/brand-logo'

export function Nav({ label }: { label: string }) {
  return (
    <nav>
      <Link href="/" className="brand"><BrandLogo /> steno-personal</Link>
      <Link href="/">Chats</Link>
      <Link href="/connections">Connections</Link>
      <Link href="/settings">Settings</Link>
      <span className="muted" style={{ marginLeft: 'auto' }}>key: {label}</span>
      <form action={logoutAction} className="inline"><button type="submit">Log out</button></form>
    </nav>
  )
}
