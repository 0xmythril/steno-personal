import Link from 'next/link'
import { currentRecoveryAttempt, requireRecoveryOpen } from '@/lib/auth'
import { getRecoveryAttempt, knownAccountChannels, type RecoveryStatus } from '@/lib/services/recovery'
import { PASSWORD_REJECTED } from '@/lib/services/connections'
import { renderQrSvg } from '@/lib/qrcode'
import { CHANNEL_LABELS } from '@/lib/format'
import type { Channel } from '@/lib/channels/port'
import { BrandLogo, Wordmark } from '@/app/brand-logo'
import { WhatsAppRisk } from '@/app/connections/whatsapp-consent'
import { ConnectPanel } from '@/app/connections/connect-panel'
import { ConnectButton } from '@/app/connections/connect-button'
import { recoverStartAction, recoverPasswordAction, recoverCancelAction, recoverClaimAction } from './actions'

// Reads the database (is the instance fresh?) before any request API, so
// Next must be told not to prerender this at build time — an env-less Docker
// build has no database to ask.
export const dynamic = 'force-dynamic'

const LOST_ACCESS_DOCS = 'https://github.com/0xmythril/steno-personal/blob/main/docs/self-hosting.md#lost-access'

function StartCards({ channels }: { channels: Channel[] }) {
  if (channels.length === 0) {
    return (
      <section className="card">
        <p>
          No account has ever been connected to this instance, so nothing here can prove it is yours.
          Whoever runs it can mint a new key, or reset it, from the host — see{' '}
          <a href={LOST_ACCESS_DOCS}>Lost access</a> in the self-hosting notes.
        </p>
      </section>
    )
  }
  return (
    <>
      <p>
        If you still have the account this archive reads, pairing it again proves it is you and gives you a new
        access key. Nothing is read from the phone: the device is unlinked again as soon as the account is confirmed.
      </p>
      {channels.map(channel => (
        <section className="card" key={channel}>
          <h2>{CHANNEL_LABELS[channel]}</h2>
          {channel === 'whatsapp' && <WhatsAppRisk />}
          <ConnectButton channel={channel} action={recoverStartAction} label="Pair again" />
        </section>
      ))}
    </>
  )
}

function Attempt({ attempt }: { attempt: RecoveryStatus }) {
  const label = CHANNEL_LABELS[attempt.channel]
  if (attempt.status === 'pending') {
    return (
      <section className="card">
        <div className="card-head"><h2>{label}</h2><span className="chip warn">Waiting for scan</span></div>
        {attempt.channel === 'whatsapp' && <WhatsAppRisk />}
        <ConnectPanel
          connectionId={attempt.id}
          channel={attempt.channel}
          initial={{
            status: attempt.status,
            qrAt: attempt.login?.qrAt ? attempt.login.qrAt.toISOString() : null,
            needsPassword: attempt.login?.needsPassword ?? false,
            passwordRejected: attempt.login?.passwordRejected ?? false,
            lastError: attempt.lastError,
          }}
          qrSvg={attempt.login?.qr ? renderQrSvg(attempt.login.qr, `${label} login QR code`) : null}
          statusUrl="/api/recovery/status"
          actions={{ submitPassword: recoverPasswordAction, cancel: recoverCancelAction }}
        />
      </section>
    )
  }
  if (attempt.outcome === 'matched') {
    return (
      <section className="card">
        <div className="card-head"><h2>{label}</h2><span className="chip ok">Matched</span></div>
        {attempt.hasKey ? (
          <>
            <p>That is the account this archive belongs to. A new access key is ready for you.</p>
            <form action={recoverClaimAction} className="actions"><button type="submit" className="primary">Continue</button></form>
          </>
        ) : (
          <>
            <p>This attempt&apos;s key has already been collected.</p>
            <form action={recoverCancelAction} className="actions"><button type="submit" className="small">Start again</button></form>
          </>
        )}
      </section>
    )
  }
  if (attempt.outcome === 'mismatched') {
    return (
      <section className="card">
        <div className="card-head"><h2>{label}</h2><span className="chip bad">Not this archive</span></div>
        <p className="danger" role="alert">
          The account you paired is not the one this archive belongs to. It has been unlinked again.
        </p>
        <p>
          To get in you need one of your access keys. If every key is lost and you no longer have the account,
          the person running this instance can mint a new key, or reset it, from the host — see{' '}
          <a href={LOST_ACCESS_DOCS}>Lost access</a> in the self-hosting notes.
        </p>
        <form action={recoverCancelAction} className="actions"><button type="submit" className="small">Try another way</button></form>
      </section>
    )
  }
  // error (retryable), or cancelled with no verdict
  const reason = attempt.lastError && attempt.lastError !== PASSWORD_REJECTED ? attempt.lastError : null
  return (
    <section className="card">
      <div className="card-head"><h2>{label}</h2><span className="chip bad">Did not finish</span></div>
      {reason && <p className="danger" role="alert">{reason}</p>}
      <form action={recoverCancelAction} className="actions"><button type="submit" className="small">Start again</button></form>
    </section>
  )
}

export default async function RecoverPage() {
  await requireRecoveryOpen()
  const id = await currentRecoveryAttempt()
  const attempt = id ? await getRecoveryAttempt(id) : null
  const channels = attempt ? [] : await knownAccountChannels()
  return (
    <main>
      <div className="onboard">
        <span className="brand"><BrandLogo size={28} /><Wordmark /></span>
        <h1>Lost your access key?</h1>
        {attempt ? <Attempt attempt={attempt} /> : <StartCards channels={channels} />}
        <p className="help"><Link href="/login">Back to log in</Link></p>
      </div>
    </main>
  )
}
