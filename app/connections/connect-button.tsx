'use client'

import { useActionState } from 'react'
import { connectAction, type ConnectResult } from './actions'

// A client boundary purely so a failed start reports itself. On success the
// action revalidates and the server re-renders this card into its pending
// branch, so there is no success state to render here.
//
// `action` lets the setup and recovery pages post to their own guarded action
// with the same button; `label` names what pressing it starts.
export function ConnectButton({ channel, action, label = 'Connect' }: {
  channel: 'telegram' | 'whatsapp'
  action?: (prev: ConnectResult | null, formData: FormData) => Promise<ConnectResult>
  label?: string
}) {
  const [state, formAction, pending] = useActionState<ConnectResult | null, FormData>(action ?? connectAction, null)
  return (
    <form action={formAction}>
      <input type="hidden" name="channel" value={channel} />
      <button type="submit" disabled={pending}>{pending ? 'Connecting…' : label}</button>
      {state?.ok === false && <p className="danger" role="alert">{state.message}</p>}
    </form>
  )
}
