import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentSession, isFreshInstance } from '@/lib/auth'
import { countActivePasskeys } from '@/lib/services/passkeys'
import { PasskeyLogin } from '@/app/passkey-login'
import { loginAction } from './actions'
import { BrandLogo, Wordmark } from '@/app/brand-logo'
import { HostedCta } from '@/app/hosted-cta'

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentSession()) redirect('/')
  // Nothing to log in with yet: the first visitor pairs a channel on /setup and
  // receives the first key there.
  if (await isFreshInstance()) redirect('/setup')
  const { error } = await searchParams
  // The passkey button only when there is a passkey to use; the browser
  // decides on top of that whether it can offer one at all.
  const hasPasskeys = (await countActivePasskeys()) > 0
  return (
    <main>
      <div className="login">
        <header className="brand-head">
          <span className="brand"><BrandLogo size={28} /><Wordmark /></span>
          <h1>A private copy of your Telegram and WhatsApp chats, kept on your own computer.</h1>
        </header>
        {/* PasskeyLogin draws the divider under itself, or renders nothing at
            all — see the note in that file. This half labels itself either way. */}
        <div className="login-ways">
          {hasPasskeys && <PasskeyLogin />}
          <div className="choice">
            <p className="muted">Paste one of your access keys.</p>
            <form action={loginAction} className="card">
              <label className="field">
                <span>Access key</span>
                <input name="key" className="mono" autoComplete="off" spellCheck={false} required />
              </label>
              {error && <p className="danger" role="alert">That key is not valid or has been revoked.</p>}
              <button type="submit" className="primary">Log in</button>
            </form>
          </div>
        </div>
        <p className="help">
          Lost every key? <Link href="/login/recover">Pair your phone again</Link> to prove the archive is yours and get a new one.
        </p>
        <HostedCta />
      </div>
    </main>
  )
}
