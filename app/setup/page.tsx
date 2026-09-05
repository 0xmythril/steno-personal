import { redirect } from 'next/navigation'
import { currentSetupAttempt, isFreshInstance } from '@/lib/auth'
import { listConnections, otherSetupClaimExists, PASSWORD_REJECTED, type ConnectionStatus } from '@/lib/services/connections'
import { renderQrSvg } from '@/lib/qrcode'
import { CHANNEL_LABELS } from '@/lib/format'
import type { Channel } from '@/lib/channels/port'
import { BrandLogo, Wordmark } from '@/app/brand-logo'
import { Consent } from '@/app/connections/consent'
import { WhatsAppConsent } from '@/app/connections/whatsapp-consent'
import { ConnectPanel } from '@/app/connections/connect-panel'
import { ConnectButton } from '@/app/connections/connect-button'
import { TelegramUnavailable } from '@/app/connections/telegram-unavailable'
import { telegramConfigured } from '@/lib/channels/telegram-credentials'
import { HOSTED_URL } from '@/app/links'
import { setupConnectAction, setupPasswordAction, setupCancelAction, finishSetupAction } from './actions'

// First run. Open to whoever reaches a fresh instance first — exactly the
// exposure the old log-printed key had, minus the log — and closed for good
// the moment a key exists. Pairing an account is what makes the visitor the
// owner: that account becomes the proof recovery checks against later, and
// the pairing is bound to the browser that started it (SETUP_COOKIE). From
// the moment someone has started pairing, every other visitor sees only that
// the instance is being claimed: no QR, no poll, no "create my key".

// Reads the database (is the instance fresh?) before any request API, so
// Next must be told not to prerender this at build time — an env-less Docker
// build has no database to ask.
export const dynamic = 'force-dynamic'

function errorText(c: ConnectionStatus): string | null {
  if (!c.lastError || c.lastError === PASSWORD_REJECTED) return null
  return c.lastError
}

function SetupChannelCard({ channel, live }: { channel: Channel; live: ConnectionStatus | undefined }) {
  if (channel === 'telegram' && !telegramConfigured()) return <TelegramUnavailable />
  const consent = channel === 'whatsapp' ? <WhatsAppConsent /> : <Consent channel={channel} />
  if (live?.status === 'pending') {
    return (
      <section className="card">
        <div className="card-head"><h2>{CHANNEL_LABELS[channel]}</h2><span className="chip warn">Waiting for scan</span></div>
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
      <div className="card-head"><h2>{CHANNEL_LABELS[channel]}</h2><span className="chip off">Not connected</span></div>
      {live && errorText(live) && <p className="danger" role="alert">{errorText(live)}</p>}
      {consent}
      <ConnectButton channel={channel} action={setupConnectAction} />
      {channel === 'whatsapp' && (
        <p className="muted">
          Rather not link your own number? <a href={HOSTED_URL}>Steno Team</a> records with a number it provides.
        </p>
      )}
    </section>
  )
}

function ClaimInProgress() {
  return (
    <main>
      <div className="onboard">
        <span className="brand"><BrandLogo size={28} /><Wordmark /></span>
        <h1>Being claimed</h1>
        <section className="card">
          <p>
            Another browser has started pairing an account with this instance. A pairing belongs to the browser that
            began it, so it can only be finished there.
          </p>
          <p className="muted">
            If that was you, go back to the tab you scanned from. If it was not, this instance was reached by someone
            else first; the host can empty it with <code>STENO_RESET</code> and start again.
          </p>
        </section>
      </div>
    </main>
  )
}

export default async function SetupPage() {
  if (!(await isFreshInstance())) redirect('/login')
  const mine = await currentSetupAttempt()
  const all = await listConnections()
  const archive = all.filter(c => c.purpose === 'archive' && c.revokedAt === null)
  // Same predicate the Connect and Finish actions refuse on: the render is a
  // courtesy, the actions are the guard.
  if (await otherSetupClaimExists(mine)) return <ClaimInProgress />
  const active = archive.find(c => c.status === 'active' && c.id === mine)
  const liveOf = (channel: Channel) => archive.find(c => c.channel === channel)

  if (active) {
    return (
      <main>
        <div className="onboard">
          <span className="brand"><BrandLogo size={28} /><Wordmark /></span>
          <h1>Connected</h1>
          <section className="card">
            <div className="card-head">
              <h2>{CHANNEL_LABELS[active.channel]}{active.displayName ? `: ${active.displayName}` : ''}</h2>
              <span className="chip ok">Live</span>
            </div>
            <p>
              This account is paired and archiving has started. Your first access key comes next — it is what logs
              you in here and what your agents use.
            </p>
            <form action={finishSetupAction} className="actions">
              <button type="submit" className="primary">Create my access key</button>
            </form>
          </section>
        </div>
      </main>
    )
  }

  return (
    <main>
      <div className="page-head">
        <div className="brand-head">
          <span className="brand"><BrandLogo size={24} /><Wordmark /></span>
          <h1>This instance has no owner yet</h1>
        </div>
      </div>
      <p className="lede">
        Connect Telegram or WhatsApp to claim it: the account you pair is what this archive reads, and it is also
        how you prove it is yours if you ever lose your access key.
      </p>
      <p className="muted">
        Read what connecting does before you scan. You can connect the other channel afterwards, from Connections.
      </p>
      <div className="two-up">
        <SetupChannelCard channel="telegram" live={liveOf('telegram')} />
        <SetupChannelCard channel="whatsapp" live={liveOf('whatsapp')} />
      </div>
    </main>
  )
}
