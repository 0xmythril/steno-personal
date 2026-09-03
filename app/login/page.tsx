import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentSession, isFreshInstance } from '@/lib/auth'
import { loginAction } from './actions'
import { BrandLogo, Wordmark } from '@/app/brand-logo'
import { HostedCta } from '@/app/hosted-cta'

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentSession()) redirect('/')
  // Nothing to log in with yet: the first visitor pairs a channel on /setup and
  // receives the first key there.
  if (await isFreshInstance()) redirect('/setup')
  const { error } = await searchParams
  return (
    <main>
      <div className="login">
        <span className="brand"><BrandLogo size={28} /><Wordmark /></span>
        <h1>A private copy of your Telegram and WhatsApp chats, kept on your own computer.</h1>
        <p className="muted">Paste one of your access keys.</p>
        <form action={loginAction} className="card">
          <label className="field">
            <span>Access key</span>
            <input name="key" className="mono" autoComplete="off" spellCheck={false} required />
          </label>
          {error && <p className="danger" role="alert">That key is not valid or has been revoked.</p>}
          <div className="actions"><button type="submit" className="primary">Log in</button></div>
        </form>
        <p className="help">
          Lost every key? <Link href="/login/recover">Pair your phone again</Link> to prove the archive is yours and get a new one.
        </p>
        <HostedCta />
      </div>
    </main>
  )
}
