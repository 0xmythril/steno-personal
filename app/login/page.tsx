import { redirect } from 'next/navigation'
import { currentSession } from '@/lib/auth'
import { loginAction } from './actions'
import { BrandLogo } from '@/app/brand-logo'
import { HostedCta } from '@/app/hosted-cta'

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentSession()) redirect('/')
  const { error } = await searchParams
  return (
    <main>
      <h1 className="brand"><BrandLogo size={28} /> steno-personal</h1>
      <p className="muted">A private copy of your Telegram and WhatsApp chats, kept on your own computer.</p>
      <p className="muted">Paste an access key. The first one was printed in the container log at first boot.</p>
      <form action={loginAction} className="card">
        <label>
          Access key<br />
          <input name="key" autoComplete="off" spellCheck={false} style={{ width: '100%' }} required />
        </label>
        {error && <p className="danger">That key is not valid or has been revoked.</p>}
        <p><button type="submit">Log in</button></p>
      </form>
      <HostedCta />
    </main>
  )
}
