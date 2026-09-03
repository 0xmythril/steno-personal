'use client'

import { useActionState } from 'react'
import { connectAction, type ConnectResult } from './actions'

// A client boundary purely so a failed start reports itself. On success the
// action revalidates and the server re-renders this card into its pending
// branch, so there is no success state to render here.
export function ConnectButton({ channel }: { channel: 'telegram' | 'whatsapp' }) {
  const [state, formAction, pending] = useActionState<ConnectResult | null, FormData>(connectAction, null)
  return (
    <form action={formAction}>
      <input type="hidden" name="channel" value={channel} />
      <button type="submit" className="primary" disabled={pending}>{pending ? 'Connecting…' : `Connect ${channel === 'telegram' ? 'Telegram' : 'WhatsApp'}`}</button>
      {state?.ok === false && <p className="danger" role="alert">{state.message}</p>}
    </form>
  )
}
