import { requireSession } from '@/lib/auth'
import { Nav } from '@/app/nav'
import { HostedCta } from '@/app/hosted-cta'
import { listConnections, PASSWORD_REJECTED, type ConnectionStatus } from '@/lib/services/connections'
import { renderQrSvg } from '@/lib/qrcode'
import { CHANNEL_LABELS, formatRelativeTime } from '@/lib/format'
import type { Channel } from '@/lib/channels/port'
import { Consent } from './consent'
import { WhatsAppConsent } from './whatsapp-consent'
import { ConnectPanel } from './connect-panel'
import { ConnectButton } from './connect-button'
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
        <h2>{CHANNEL_LABELS[channel]}{live.displayName ? `: ${live.displayName}` : ''}</h2>
        <p className="muted">
          Connected, read-only. Last synced {formatRelativeTime(live.lastSyncAt)}.
        </p>
        <form action={disconnectAction} className="inline">
          <input type="hidden" name="connectionId" value={live.id} />
          <button type="submit">Disconnect</button>
        </form>{' '}
        <form action={deleteEverythingAction} className="inline">
          <input type="hidden" name="connectionId" value={live.id} />
          <button type="submit" className="danger">Delete this account and everything it archived</button>
        </form>
      </section>
    )
  }

  if (live?.status === 'pending') {
    return (
      <section className="card">
        <h2>{CHANNEL_LABELS[channel]}</h2>
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

  return (
    <section className="card">
      <h2>{CHANNEL_LABELS[channel]}</h2>
      {live && errorText(live) && <p className="danger" role="alert">{errorText(live)}</p>}
      <>
        {channel === 'whatsapp' ? <WhatsAppConsent /> : <Consent channel={channel} />}
        <ConnectButton channel={channel} />
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
    <main>
      <Nav label={session.label} />
      <h1>Connections</h1>
      <HostedCta />
      <ChannelCard channel="telegram" live={liveOf('telegram')} />
      <ChannelCard channel="whatsapp" live={liveOf('whatsapp')} />

      {history.length > 0 && (
        <section className="card">
          <h2>Past connections</h2>
          <p className="muted">Ended, but whatever they archived is still readable. Recovery attempts — someone pairing a phone on the login page to prove this archive is theirs — are listed too.</p>
          <table>
            <thead><tr><th>Channel</th><th>Account</th><th>Ended</th><th>Reason</th></tr></thead>
            <tbody>
              {history.map(c => (
                <tr key={c.id}>
                  <td>{CHANNEL_LABELS[c.channel]}</td>
                  <td>{c.purpose === 'recovery' ? <em>Recovery attempt</em> : (c.displayName ?? '—')}</td>
                  <td>{formatRelativeTime(c.revokedAt)}</td>
                  <td>{errorText(c) ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  )
}
