import { requireSession } from '@/lib/auth'
import { Nav } from '@/app/nav'
import { HostedCta } from '@/app/hosted-cta'
import { TelegramUnavailable } from './telegram-unavailable'
import { telegramConfigured } from '@/lib/channels/telegram-credentials'
import { listConnections, PASSWORD_REJECTED, type ConnectionStatus } from '@/lib/services/connections'
import { renderQrSvg } from '@/lib/qrcode'
import { CHANNEL_LABELS, formatRelativeTime } from '@/lib/format'
import type { Channel } from '@/lib/channels/port'
import { Consent } from './consent'
import { WhatsAppConsent } from './whatsapp-consent'
import { ConnectPanel } from './connect-panel'
import { ConnectButton } from './connect-button'
import { HOSTED_URL } from '@/app/links'
import { disconnectAction, deleteEverythingAction } from './actions'


// The panel's own error copy owns the password case; showing the raw sentinel
// anywhere else would put a machine token in front of a person.
function errorText(c: ConnectionStatus): string | null {
  if (!c.lastError || c.lastError === PASSWORD_REJECTED) return null
  return c.lastError
}

function ChannelCard({ channel, live }: { channel: Channel; live: ConnectionStatus | undefined }) {
  if (live?.status === 'active') {
    return (
      <section className="card">
        <div className="card-head">
          <h2>{CHANNEL_LABELS[channel]}{live.displayName ? `: ${live.displayName}` : ''}</h2>
          <span className="chip ok">Live</span>
        </div>
        <p className="muted">
          Connected, read-only. Last synced <span className="mono">{formatRelativeTime(live.lastSyncAt)}</span>.
        </p>
        <div className="actions">
          <form action={disconnectAction} className="inline">
            <input type="hidden" name="connectionId" value={live.id} />
            <button type="submit" className="small">Disconnect</button>
          </form>
          <details className="confirm">
            <summary>Delete this account and everything it archived</summary>
            <div className="confirm-body">
              <p>
                Every chat, message and downloaded file this {CHANNEL_LABELS[channel]} account produced is erased from
                this machine, and your agents stop seeing it. Deleted stays deleted: there is no undo and no export.
                Disconnect instead if you only want to stop archiving.
              </p>
              <form action={deleteEverythingAction}>
                <input type="hidden" name="connectionId" value={live.id} />
                <button type="submit" className="small danger">Yes, erase this {CHANNEL_LABELS[channel]} archive</button>
              </form>
            </div>
          </details>
        </div>
      </section>
    )
  }

  if (live?.status === 'pending') {
    return (
      <section className="card">
        <div className="card-head">
          <h2>{CHANNEL_LABELS[channel]}</h2>
          <span className="chip warn">Waiting for scan</span>
        </div>
        {channel === 'whatsapp' ? <WhatsAppConsent /> : <Consent channel={channel} />}
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
        />
      </section>
    )
  }

  // An active or pending row above still shows, so a pair removed after a
  // pairing can still be disconnected; only a fresh start is refused.
  if (channel === 'telegram' && !telegramConfigured()) return <TelegramUnavailable />
  return (
    <section className="card">
      <div className="card-head">
        <h2>{CHANNEL_LABELS[channel]}</h2>
        <span className="chip off">Not connected</span>
      </div>
      {live && errorText(live) && <p className="danger" role="alert">{errorText(live)}</p>}
      <>
        {channel === 'whatsapp' ? <WhatsAppConsent /> : <Consent channel={channel} />}
        <ConnectButton channel={channel} />
        {channel === 'whatsapp' && (
          <p className="muted">
            Rather not link your own number? <a href={HOSTED_URL}>Steno Cloud</a> records with a number it provides.
          </p>
        )}
      </>
    </section>
  )
}

export default async function ConnectionsPage() {
  const session = await requireSession()
  const all = await listConnections()
  // Newest first, so the first ARCHIVE row per channel with no revoked_at is
  // the live one; revoked rows stay in the list below as history. A live
  // recovery row is someone proving ownership on /login/recover — it is not a
  // connection and never shows as one; finished attempts are listed below so
  // the owner can see one happened.
  const liveOf = (channel: Channel) => all.find(c => c.channel === channel && c.purpose === 'archive' && c.revokedAt === null)
  const history = all.filter(c => c.revokedAt !== null)

  return (
    <>
      <Nav label={session.label} via={session.via} current="connections" />
      <main>
        <div className="page-head"><div><p className="eyebrow">Accounts</p><h1>Connections</h1></div></div>
        <HostedCta />
        <div className="two-up">
          <ChannelCard channel="telegram" live={liveOf('telegram')} />
          <ChannelCard channel="whatsapp" live={liveOf('whatsapp')} />
        </div>

        {history.length > 0 && (
          <section className="card">
            <h2>Past connections</h2>
            <p className="muted">Ended, but whatever they archived is still readable. Recovery attempts — someone pairing a phone on the login page to prove this archive is theirs — are listed too.</p>
            <div className="tbl"><div className="scroll">
              <table>
                <thead><tr><th>Channel</th><th>Account</th><th>Ended</th><th>Reason</th></tr></thead>
                <tbody>
                  {history.map(c => (
                    <tr key={c.id}>
                      <td>{CHANNEL_LABELS[c.channel]}</td>
                      <td className="name">{c.purpose === 'recovery' ? <span className="chip off">Recovery attempt</span> : (c.displayName ?? '—')}</td>
                      <td className="mono">{formatRelativeTime(c.revokedAt)}</td>
                      <td>{errorText(c) ? <span className="chip bad">{errorText(c)}</span> : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div></div>
          </section>
        )}
      </main>
    </>
  )
}
