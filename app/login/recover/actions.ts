'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import {
  requireRecoveryOpen, requireRecoveryAttempt, setRecoveryCookie, clearRecoveryCookie,
  setFirstKeyFlash, startSession,
} from '@/lib/auth'
import { submitLoginPassword } from '@/lib/services/connections'
import { startRecovery, cancelRecovery, claimRecoveryKey } from '@/lib/services/recovery'
import { revealAccessKey } from '@/lib/services/access-keys'
import type { Channel } from '@/lib/channels/port'
import type { ConnectResult, PasswordResult } from '@/app/connections/actions'

// Lost-key recovery. No session exists to require; the guard is the
// recovery cookie set by Start, so only the browser that began an attempt can
// drive or claim it. Start itself carries the open-check alone.

const CHANNELS: Channel[] = ['telegram', 'whatsapp']
const asChannel = (v: unknown): Channel | null => (CHANNELS as string[]).includes(String(v)) ? String(v) as Channel : null

export async function recoverStartAction(_prev: ConnectResult | null, formData: FormData): Promise<ConnectResult> {
  await requireRecoveryOpen()
  const channel = asChannel(formData.get('channel'))
  if (!channel) return { ok: false, message: 'Unknown channel.' }
  const res = await startRecovery(channel)
  if (!res.ok) {
    return res.reason === 'telegram_unconfigured'
      ? { ok: false, message: 'This deploy has no Telegram credentials, so Telegram cannot be paired here.' }
      : { ok: false, message: 'No account has ever been connected on this channel, so it cannot prove anything.' }
  }
  await setRecoveryCookie(res.id)
  revalidatePath('/login/recover')
  return { ok: true, id: res.id }
}

// The attempt id comes from the cookie, never from the form.
export async function recoverPasswordAction(_prev: PasswordResult | null, formData: FormData): Promise<PasswordResult> {
  const id = await requireRecoveryAttempt()
  const password = String(formData.get('password') ?? '')
  if (password.length === 0) return { ok: false, message: 'Enter your Telegram password.' }
  const ok = await submitLoginPassword(id, password)
  if (!ok) return { ok: false, message: 'This attempt is no longer waiting for a password.' }
  revalidatePath('/login/recover')
  return { ok: true }
}

// Cancel a pending attempt, or dismiss a finished one; either way the cookie
// goes and the page returns to the channel list.
export async function recoverCancelAction(): Promise<void> {
  const id = await requireRecoveryAttempt()
  await cancelRecovery(id)
  await clearRecoveryCookie()
  revalidatePath('/login/recover')
}

// A matched attempt hands its key over exactly once (claimRecoveryKey is the
// atomic claim), then this browser is logged in with it and shown the key on
// /welcome, the same way a first key is.
export async function recoverClaimAction(): Promise<void> {
  const id = await requireRecoveryAttempt()
  const keyId = await claimRecoveryKey(id)
  if (!keyId) redirect('/login/recover')
  const rawKey = await revealAccessKey(keyId)
  await clearRecoveryCookie()
  // Undecryptable would mean SECRET_KEY changed between the worker minting
  // and this request — not a state a running instance can be in.
  if (!rawKey) redirect('/login')
  await setFirstKeyFlash(keyId, rawKey)
  await startSession({ keyId })
  redirect('/welcome')
}
