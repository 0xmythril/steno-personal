'use client'
import { useState, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser'

// Rendered on /login only when a passkey exists. Shows nothing until the
// browser has confirmed it can do WebAuthn in a secure context (HTTPS or
// localhost); on a plain-http LAN address the key form below is all there
// is. useSyncExternalStore rather than an effect: the server renders
// "unsupported", the client corrects it on hydration, no state churn.
const noop = () => () => {}
const supportedNow = () => window.isSecureContext && browserSupportsWebAuthn()
const supportedOnServer = () => false

export function PasskeyLogin() {
  const supported = useSyncExternalStore(noop, supportedNow, supportedOnServer)
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  if (!supported) return null

  const login = async () => {
    setBusy(true); setFailed(false)
    try {
      const opt = await fetch('/api/passkeys/login/options', { method: 'POST' })
      if (!opt.ok) throw new Error('options')
      let assertion
      try {
        assertion = await startAuthentication({ optionsJSON: await opt.json() })
      } catch (err) {
        // The person closed the prompt: not a failure worth a message.
        if ((err as Error).name === 'NotAllowedError') { setBusy(false); return }
        throw err
      }
      const res = await fetch('/api/passkeys/login', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ response: assertion }),
      })
      if (res.status !== 204) throw new Error('rejected')
      // A new session cookie: the server renders / afresh on this navigation.
      router.push('/')
    } catch {
      setFailed(true); setBusy(false)
    }
  }

  return (
    <div className="card stack" style={{ gap: 12 }}>
      <button type="button" className="primary" onClick={login} disabled={busy}>
        {busy ? 'Waiting for your passkey…' : 'Log in with a passkey'}
      </button>
      {failed && <p className="danger" role="alert">That passkey was not accepted. Use an access key below.</p>}
    </div>
  )
}
