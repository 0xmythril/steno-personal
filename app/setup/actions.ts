'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import {
  clearSetupCookie, requireFreshInstance, requireSetupAttempt, setFirstKeyFlash, setSetupCookie, startSession,
} from '@/lib/auth'
import { createConnection, getConnection, submitLoginPassword, revokeConnection } from '@/lib/services/connections'
import { mintFirstAccessKey } from '@/lib/services/access-keys'
import type { Channel } from '@/lib/channels/port'
import type { ConnectResult, PasswordResult } from '@/app/connections/actions'

// First-run setup. There is no session to require — no key exists yet — so
// Connect re-runs requireFreshInstance() instead: the moment any key exists
// these actions are closed, and the visitor is sent to /login. Connect also
// binds the pairing to this browser with an httpOnly cookie (lib/auth.ts,
// SETUP_COOKIE); every later step requires that cookie, so the account being
// paired — and the first key minted against it — belong to the browser that
// scanned, not to whoever reaches the URL next.

const CHANNELS: Channel[] = ['telegram', 'whatsapp']
const asChannel = (v: unknown): Channel | null => (CHANNELS as string[]).includes(String(v)) ? String(v) as Channel : null

export async function setupConnectAction(_prev: ConnectResult | null, formData: FormData): Promise<ConnectResult> {
  await requireFreshInstance()
  const channel = asChannel(formData.get('channel'))
  if (!channel) return { ok: false, message: 'Unknown channel.' }
  const res = await createConnection(channel)
  if (!res.ok) return { ok: false, message: 'An account is already connected on this channel.' }
  await setSetupCookie(res.id)
  revalidatePath('/setup')
  return { ok: true, id: res.id }
}

export async function setupPasswordAction(_prev: PasswordResult | null, formData: FormData): Promise<PasswordResult> {
  const mine = await requireSetupAttempt()
  const id = String(formData.get('connectionId') ?? '')
  if (id !== mine) redirect('/setup')
  const password = String(formData.get('password') ?? '')
  if (password.length === 0) return { ok: false, message: 'Enter your Telegram password.' }
  const ok = await submitLoginPassword(id, password)
  if (!ok) return { ok: false, message: 'This connection is no longer waiting for a password.' }
  revalidatePath('/setup')
  return { ok: true }
}

export async function setupCancelAction(formData: FormData): Promise<void> {
  const mine = await requireSetupAttempt()
  const id = String(formData.get('connectionId') ?? '')
  if (id !== mine) redirect('/setup')
  await revokeConnection(id, 'You cancelled this connection attempt.')
  await clearSetupCookie()
  revalidatePath('/setup')
}

// The pairing succeeded: the browser that started it becomes the owner. The
// first key is minted, shown once on /welcome out of an httpOnly flash, and a
// session is started with it so the owner lands logged in. After this the
// instance is no longer fresh and /setup is closed for good.
//
// The mint is the atomic "first key" mint: two requests racing through the
// guards cannot both succeed, and the loser is simply no longer on a fresh
// instance, so it goes where every other visitor now goes.
export async function finishSetupAction(): Promise<void> {
  const mine = await requireSetupAttempt()
  const conn = await getConnection(mine)
  if (!conn || conn.purpose !== 'archive' || conn.status !== 'active' || conn.revokedAt) redirect('/setup')
  const minted = await mintFirstAccessKey('First key')
  if (!minted.ok) {
    if (minted.reason === 'not_first') redirect('/login')
    throw new Error(`first key mint failed: ${minted.reason}`)
  }
  await setFirstKeyFlash(minted.id, minted.rawKey)
  await startSession(minted.id)
  await clearSetupCookie()
  redirect('/welcome')
}
