import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentSession, isFreshInstance } from '@/lib/auth'
import { loginAction } from './actions'
import { BrandLogo } from '@/app/brand-logo'
import { HostedCta } from '@/app/hosted-cta'

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentSession()) redirect('/')
  // Nothing to log in with yet: the first visitor pairs a channel on /setup and
  // receives the first key there.
  if (await isFreshInstance()) redirect('/setup')
  const { error } = await searchParams
  return (
    <main>
      <h1 className="brand"><BrandLogo size={28} /> steno-personal</h1>
      <p className="muted">A private copy of your Telegram and WhatsApp chats, kept on your own computer.</p>
      <p className="muted">Paste one of your access keys.</p>
      <form action={loginAction} className="card">
        <label>
          Access key<br />
          <input name="key" autoComplete="off" spellCheck={false} style={{ width: '100%' }} required />
        </label>
        {error && <p className="danger">That key is not valid or has been revoked.</p>}
        <p><button type="submit">Log in</button></p>
      </form>
      <p className="muted">
        Lost every key? <Link href="/login/recover">Pair your phone again</Link> to prove the archive is yours and get a new one.
      </p>
      <HostedCta />
    </main>
  )
}
