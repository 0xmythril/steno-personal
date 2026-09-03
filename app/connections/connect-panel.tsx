'use client'

import { useActionState, useEffect, useState } from 'react'
import { submitPasswordAction, cancelConnectionAction, type PasswordResult } from './actions'

// Login state is written into the database by the worker, so the browser polls
// the status route and re-renders as the state machine advances. Polling stops
// at a terminal state.
//
// This component never holds the login token. The QR arrives once, already
// rendered to SVG on the server, as `qrSvg`. To learn that a FRESH code was
// published it compares `qrAt` — a timestamp, not a secret — and asks for a
// fresh server render rather than encoding a token in the browser.
type Status = {
  status: 'pending' | 'active' | 'revoked' | 'error'
  qrAt: string | null
  needsPassword: boolean
  passwordRejected: boolean
  lastError: string | null
}

const TERMINAL = ['active', 'revoked', 'error']
const POLL_MS = 2000

// The same panel drives three handshakes that differ only in who may drive
// them: the owner's Connections page (session cookie), the fresh-instance
// setup page, and lost-key recovery (recovery cookie). Each passes the status
// route and the actions that carry its own guard; the defaults are the
// Connections page's.
type PanelActions = {
  submitPassword: (prev: PasswordResult | null, formData: FormData) => Promise<PasswordResult>
  cancel: (formData: FormData) => Promise<void>
}

export function ConnectPanel({ connectionId, channel, initial, qrSvg, statusUrl, actions }: {
  connectionId: string
  channel: 'telegram' | 'whatsapp'
  initial: Status
  qrSvg: string | null
  statusUrl?: string
  actions?: PanelActions
}) {
  const pollUrl = statusUrl ?? `/api/connections/${connectionId}`
  const submitAction = actions?.submitPassword ?? submitPasswordAction
  const cancelAction = actions?.cancel ?? cancelConnectionAction
  const [status, setStatus] = useState<Status>(initial)
  const [pwState, submitPassword] = useActionState<PasswordResult | null, FormData>(submitAction, null)

  useEffect(() => {
    if (TERMINAL.includes(status.status)) return
    const timer = setInterval(async () => {
      try {
        const res = await fetch(pollUrl)
        if (!res.ok) return
        const body = await res.json()
        // Narrow to exactly the fields this panel may hold — in particular,
        // never copy the login token field (body.login's qr) into state.
        const next: Status = {
          status: body.status,
          qrAt: body.login?.qrAt ?? null,
          needsPassword: body.login?.needsPassword ?? false,
          passwordRejected: body.login?.passwordRejected ?? false,
          lastError: body.lastError ?? null,
        }
        setStatus(next)
        if (next.qrAt && next.qrAt !== status.qrAt) window.location.reload()
        if (TERMINAL.includes(next.status)) window.location.reload()
      } catch {
        // A network blip just means we try again on the next tick.
      }
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [pollUrl, status])

  if (status.needsPassword) {
    // A successful submit does not itself clear needsPassword: the worker
    // consumes the stored secret on its own cycle and only then advances the
    // connection, which is what this poll picks up. So `pwState` only ever
    // says the password was STORED; whether it was CORRECT arrives later, as
    // `passwordRejected` from the poll. Deriving the error from the polled
    // status rather than a locally latched flag is what lets a later correct
    // submit clear the rejected appearance with no state to reset by hand.
    const error = pwState?.ok === false
      ? pwState.message
      : status.passwordRejected ? 'That password was not right — please try again.' : null
    if (pwState?.ok === true && !error) return <p className="muted">Checking your password…</p>
    return (
      <form action={submitPassword} className="field" style={{ maxWidth: 360 }}>
        <input type="hidden" name="connectionId" value={connectionId} />
        <label htmlFor="tg-password">Your Telegram two-step verification password</label>
        <input id="tg-password" name="password" type="password" autoComplete="off" required />
        {error && <p className="danger" role="alert">{error}</p>}
        <div className="actions"><button type="submit" className="primary">Continue</button></div>
      </form>
    )
  }

  if (qrSvg) {
    return (
      <div className="connect">
        {/* Finished SVG from the server: the component receives an image, not
            a token, and polls only a timestamp to learn when a fresh code was
            published. */}
        <div className="qr" dangerouslySetInnerHTML={{ __html: qrSvg }} />
        {channel === 'whatsapp' ? (
          <ol>
            <li>Open WhatsApp on your phone.</li>
            <li>Go to <strong>Settings &rarr; Linked devices &rarr; Link a device</strong>.</li>
            <li>Scan this code.</li>
          </ol>
        ) : (
          <ol>
            <li>Open Telegram.</li>
            <li>Go to <strong>Settings &rarr; Devices &rarr; Link Desktop Device</strong>.</li>
            <li>Scan this code.</li>
          </ol>
        )}
      </div>
    )
  }

  // The QR is published by the worker, not by this app: the page only writes a
  // pending row and waits. With no worker running (or, for Telegram, no API
  // credentials) this is where the reader sits, so say what is being waited on
  // and let them leave — without Cancel a stuck row survives a refresh.
  return (
    <>
      <p className="muted">
        {channel === 'whatsapp'
          ? 'Waiting for a login code. This needs the worker to be running; if it is not, no code will appear.'
          : 'Waiting for a login code. This needs the worker to be running with Telegram API credentials set; if it is not, no code will appear.'}
      </p>
      <form action={cancelAction} className="actions">
        <input type="hidden" name="connectionId" value={connectionId} />
        <button type="submit" className="small">Cancel</button>
      </form>
    </>
  )
}
