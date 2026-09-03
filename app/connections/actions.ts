'use server'

import { revalidatePath } from 'next/cache'
import { requireSession } from '@/lib/auth'
import {
  createConnection, submitLoginPassword, revokeConnection, deleteConnection,
} from '@/lib/services/connections'
import type { Channel } from '@/lib/channels/port'

// Every action re-runs the guard. A layout protects rendering, not the server
// actions its pages post to, which are directly callable.

const CHANNELS: Channel[] = ['telegram', 'whatsapp']
const asChannel = (v: unknown): Channel | null => (CHANNELS as string[]).includes(String(v)) ? String(v) as Channel : null

export type ConnectResult = { ok: true; id: string } | { ok: false; message: string }

// useActionState's (prevState, formData) shape — see connect-panel.tsx — so a
// failed attempt reports itself instead of appearing to do nothing. The
// realistic failure is a second tab racing a connection that went live
// elsewhere: this page reads its state once per server render.
export async function connectAction(_prev: ConnectResult | null, formData: FormData): Promise<ConnectResult> {
  await requireSession()
  const channel = asChannel(formData.get('channel'))
  if (!channel) return { ok: false, message: 'Unknown channel.' }
  const res = await createConnection(channel)
  if (!res.ok) return { ok: false, message: 'An account is already connected on this channel. Disconnect it first.' }
  revalidatePath('/connections')
  return { ok: true, id: res.id }
}

export type PasswordResult = { ok: true } | { ok: false; message: string }

export async function submitPasswordAction(_prev: PasswordResult | null, formData: FormData): Promise<PasswordResult> {
  await requireSession()
  const id = String(formData.get('connectionId') ?? '')
  const password = String(formData.get('password') ?? '')
  if (!id || password.length === 0) return { ok: false, message: 'Enter your Telegram password.' }
  const ok = await submitLoginPassword(id, password)
  if (!ok) return { ok: false, message: 'This connection is no longer waiting for a password.' }
  revalidatePath('/connections')
  return { ok: true }
}

// Ends the session and KEEPS the archive: past messages stay readable. Routes
// through the single revoke authority, like every other retirement path.
export async function disconnectAction(formData: FormData): Promise<void> {
  await requireSession()
  const id = String(formData.get('connectionId') ?? '')
  if (id) await revokeConnection(id, 'You disconnected this account.')
  revalidatePath('/connections')
  revalidatePath('/')
}

// Also abandons a pending login that never completed. Same authority, separate
// button: "Disconnect" would misdescribe an account that was never connected.
export async function cancelConnectionAction(formData: FormData): Promise<void> {
  await requireSession()
  const id = String(formData.get('connectionId') ?? '')
  if (id) await revokeConnection(id, 'You cancelled this connection attempt.')
  revalidatePath('/connections')
}

export async function deleteEverythingAction(formData: FormData): Promise<void> {
  await requireSession()
  const id = String(formData.get('connectionId') ?? '')
  if (id) await deleteConnection(id)
  revalidatePath('/connections')
  revalidatePath('/')
}
