'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireFreshInstance, setFirstKeyFlash, startSession } from '@/lib/auth'
import { createConnection, submitLoginPassword, revokeConnection, hasActiveConnection } from '@/lib/services/connections'
import { mintAccessKey } from '@/lib/services/access-keys'
import type { Channel } from '@/lib/channels/port'
import type { ConnectResult, PasswordResult } from '@/app/connections/actions'

// First-run setup. There is no session to require — no key exists yet — so
// every action re-runs requireFreshInstance() instead: the moment any key
// exists these actions are closed, and the visitor is sent to /login.

const CHANNELS: Channel[] = ['telegram', 'whatsapp']
const asChannel = (v: unknown): Channel | null => (CHANNELS as string[]).includes(String(v)) ? String(v) as Channel : null

export async function setupConnectAction(_prev: ConnectResult | null, formData: FormData): Promise<ConnectResult> {
  await requireFreshInstance()
  const channel = asChannel(formData.get('channel'))
  if (!channel) return { ok: false, message: 'Unknown channel.' }
  const res = await createConnection(channel)
  if (!res.ok) return { ok: false, message: 'An account is already connected on this channel.' }
  revalidatePath('/setup')
  return { ok: true, id: res.id }
}

export async function setupPasswordAction(_prev: PasswordResult | null, formData: FormData): Promise<PasswordResult> {
  await requireFreshInstance()
  const id = String(formData.get('connectionId') ?? '')
  const password = String(formData.get('password') ?? '')
  if (!id || password.length === 0) return { ok: false, message: 'Enter your Telegram password.' }
  const ok = await submitLoginPassword(id, password)
  if (!ok) return { ok: false, message: 'This connection is no longer waiting for a password.' }
  revalidatePath('/setup')
  return { ok: true }
}

export async function setupCancelAction(formData: FormData): Promise<void> {
  await requireFreshInstance()
  const id = String(formData.get('connectionId') ?? '')
  if (id) await revokeConnection(id, 'You cancelled this connection attempt.')
  revalidatePath('/setup')
}

// The pairing succeeded: this browser becomes the owner. The first key is
// minted, shown once on /welcome out of an httpOnly flash, and a session is
// started with it so the owner lands logged in. After this the instance is no
// longer fresh and /setup is closed for good.
export async function finishSetupAction(): Promise<void> {
  await requireFreshInstance()
  if (!(await hasActiveConnection())) redirect('/setup')
  const minted = await mintAccessKey('First key')
  if (!minted.ok) throw new Error(`first key mint failed: ${minted.reason}`)
  await setFirstKeyFlash(minted.id, minted.rawKey)
  await startSession({ keyId: minted.id })
  redirect('/welcome')
}
