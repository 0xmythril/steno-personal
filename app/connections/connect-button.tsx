'use client'

import { useActionState } from 'react'
import { connectAction, type ConnectResult } from './actions'

// A client boundary purely so a failed start reports itself. On success the
// action revalidates and the server re-renders this card into its pending
// branch, so there is no success state to render here.
//
// `action` lets the setup and recovery pages post to their own guarded action
// with the same button; `label` names what pressing it starts, and defaults
// to naming the channel.
export function ConnectButton({ channel, action, label }: {
  channel: 'telegram' | 'whatsapp'
  action?: (prev: ConnectResult | null, formData: FormData) => Promise<ConnectResult>
  label?: string
}) {
  const [state, formAction, pending] = useActionState<ConnectResult | null, FormData>(action ?? connectAction, null)
  const text = label ?? `Connect ${channel === 'telegram' ? 'Telegram' : 'WhatsApp'}`
  return (
    <form action={formAction} className="stack" style={{ gap: 8 }}>
      <input type="hidden" name="channel" value={channel} />
      <div className="actions"><button type="submit" className="primary" disabled={pending}>{pending ? 'Connecting…' : text}</button></div>
      {state?.ok === false && <p className="danger" role="alert">{state.message}</p>}
    </form>
  )
}
