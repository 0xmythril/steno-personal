'use client'
import { useState, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser'
import { PasskeyIcon } from '@/app/passkey-icon'

// Enrols the current browser. Used on /welcome (under the first key) and in
// Settings. The label is the owner's name for the device; the server never
// guesses one. Same support check as PasskeyLogin, for the same reason.
const noop = () => () => {}
const supportedNow = () => window.isSecureContext && browserSupportsWebAuthn()
const supportedOnServer = () => false

type State = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; label: string } | { kind: 'failed'; message: string }

export function RegisterPasskey() {
  const supported = useSyncExternalStore(noop, supportedNow, supportedOnServer)
  const router = useRouter()
  const [label, setLabel] = useState('')
  const [state, setState] = useState<State>({ kind: 'idle' })

  if (!supported) {
    return <p className="muted">Passkeys need HTTPS or localhost. You can add one from Settings once this address has that.</p>
  }
  if (state.kind === 'done') return <p role="status">Passkey saved as <code>{state.label}</code>.</p>

  const register = async () => {
    const name = label.trim()
    if (!name) { setState({ kind: 'failed', message: 'Give this device a name first.' }); return }
    setState({ kind: 'busy' })
    try {
      const opt = await fetch('/api/passkeys/register/options', { method: 'POST' })
      if (!opt.ok) throw new Error('options')
      let attestation
      try {
        attestation = await startRegistration({ optionsJSON: await opt.json() })
      } catch (err) {
        const kind = (err as Error).name
        if (kind === 'NotAllowedError') { setState({ kind: 'idle' }); return }
        if (kind === 'InvalidStateError') { setState({ kind: 'failed', message: 'This device already has a passkey for this instance.' }); return }
        throw err
      }
      const res = await fetch('/api/passkeys/register', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: name, response: attestation }),
      })
      if (res.status !== 204) throw new Error('rejected')
      setState({ kind: 'done', label: name })
      router.refresh()
    } catch {
      setState({ kind: 'failed', message: 'Could not save a passkey. You can still log in with an access key, and try again from Settings.' })
    }
  }

  return (
    <div className="stack" style={{ gap: 12 }}>
      <label className="field">
        <span>Device name</span>
        <input value={label} onChange={e => setLabel(e.target.value)} placeholder="This laptop" maxLength={100} disabled={state.kind === 'busy'} />
      </label>
      <div className="actions">
        <button type="button" className="primary" onClick={register} disabled={state.kind === 'busy'}>
          <PasskeyIcon />
          {state.kind === 'busy' ? 'Waiting for your passkey…' : 'Register this device'}
        </button>
      </div>
      {state.kind === 'failed' && <p className="danger" role="alert">{state.message}</p>}
    </div>
  )
}
