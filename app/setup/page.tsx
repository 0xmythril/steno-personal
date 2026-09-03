import { redirect } from 'next/navigation'
import { isFreshInstance } from '@/lib/auth'
import { listConnections, PASSWORD_REJECTED, type ConnectionStatus } from '@/lib/services/connections'
import { renderQrSvg } from '@/lib/qrcode'
import { CHANNEL_LABELS } from '@/lib/format'
import type { Channel } from '@/lib/channels/port'
import { Consent } from '@/app/connections/consent'
import { WhatsAppConsent } from '@/app/connections/whatsapp-consent'
import { ConnectPanel } from '@/app/connections/connect-panel'
import { ConnectButton } from '@/app/connections/connect-button'
import { setupConnectAction, setupPasswordAction, setupCancelAction, finishSetupAction } from './actions'

// First run. Open to whoever reaches a fresh instance first — exactly the
// exposure the old log-printed key had, minus the log — and closed for good
// the moment a key exists. Pairing an account is what makes the visitor the
// owner: that account becomes the proof recovery checks against later.

// Reads the database (is the instance fresh?) before any request API, so
// Next must be told not to prerender this at build time — an env-less Docker
// build has no database to ask.
export const dynamic = 'force-dynamic'

function errorText(c: ConnectionStatus): string | null {
  if (!c.lastError || c.lastError === PASSWORD_REJECTED) return null
  return c.lastError
}

function SetupChannelCard({ channel, live }: { channel: Channel; live: ConnectionStatus | undefined }) {
  const consent = channel === 'whatsapp' ? <WhatsAppConsent /> : <Consent channel={channel} />
  if (live?.status === 'pending') {
    return (
      <section className="card">
        <h2>{CHANNEL_LABELS[channel]}</h2>
        {consent}
        <ConnectPanel
          connectionId={live.id}
          channel={channel}
          initial={{
            status: live.status,
            qrAt: live.login?.qrAt ? live.login.qrAt.toISOString() : null,
            needsPassword: live.login?.needsPassword ?? false,
            passwordRejected: live.login?.passwordRejected ?? false,
            lastError: live.lastError,
          }}
          qrSvg={live.login?.qr ? renderQrSvg(live.login.qr, `${CHANNEL_LABELS[channel]} login QR code`) : null}
          statusUrl={`/api/setup/connections/${live.id}`}
          actions={{ submitPassword: setupPasswordAction, cancel: setupCancelAction }}
        />
      </section>
    )
  }
  return (
    <section className="card">
      <h2>{CHANNEL_LABELS[channel]}</h2>
      {live && errorText(live) && <p className="danger" role="alert">{errorText(live)}</p>}
      {consent}
      <ConnectButton channel={channel} action={setupConnectAction} />
    </section>
  )
}

export default async function SetupPage() {
  if (!(await isFreshInstance())) redirect('/login')
  const all = await listConnections()
  const archive = all.filter(c => c.purpose === 'archive' && c.revokedAt === null)
  const active = archive.find(c => c.status === 'active')
  const liveOf = (channel: Channel) => archive.find(c => c.channel === channel)

  if (active) {
    return (
      <main>
        <h1>steno-personal</h1>
        <section className="card">
          <h2>Connected</h2>
          <p>
            {CHANNEL_LABELS[active.channel]}{active.displayName ? `: ${active.displayName}` : ''} is paired and archiving
            has started. Your first access key comes next — it is what logs you in here and what your agents use.
          </p>
          <form action={finishSetupAction}>
            <button type="submit">Create my access key</button>
          </form>
        </section>
      </main>
    )
  }

  return (
    <main>
      <h1>steno-personal</h1>
      <p>
        This instance has no owner yet. Connect Telegram or WhatsApp to claim it: the account you pair is what
        this archive reads, and it is also how you prove it is yours if you ever lose your access key.
      </p>
      <p className="muted">
        Read what connecting does before you scan. You can connect the other channel afterwards, from Connections.
      </p>
      <SetupChannelCard channel="telegram" live={liveOf('telegram')} />
      <SetupChannelCard channel="whatsapp" live={liveOf('whatsapp')} />
    </main>
  )
}
