import { redirect } from 'next/navigation'
import { currentSession } from '@/lib/auth'
import { loginAction } from './actions'
import { BrandLogo, Wordmark } from '@/app/brand-logo'
import { HostedCta } from '@/app/hosted-cta'

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentSession()) redirect('/')
  const { error } = await searchParams
  return (
    <main>
      <div className="login">
        <span className="brand"><BrandLogo size={28} /><Wordmark /></span>
        <h1>A private copy of your Telegram and WhatsApp chats, kept on your own computer.</h1>
        <p className="muted">Paste an access key. The first one was printed in the container log at first boot.</p>
        <form action={loginAction} className="card">
          <label className="field">
            <span>Access key</span>
            <input name="key" className="mono" autoComplete="off" spellCheck={false} required />
          </label>
          {error && <p className="danger" role="alert">That key is not valid or has been revoked.</p>}
          <div className="actions"><button type="submit" className="primary">Log in</button></div>
        </form>
        <HostedCta />
      </div>
    </main>
  )
}
