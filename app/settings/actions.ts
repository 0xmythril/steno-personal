'use server'

import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireSession, endSession } from '@/lib/auth'
import { mintAccessKey, revealAccessKey, revokeAccessKey, revokeAllAccessKeys, listActiveAccessKeys } from '@/lib/services/access-keys'
import { MINTED_KEY_COOKIE, REVEALED_KEY_COOKIE } from '@/lib/services/keys-flash'

async function secure(): Promise<boolean> {
  return (await headers()).get('x-forwarded-proto') === 'https'
}

export async function mintKeyAction(formData: FormData) {
  await requireSession()
  const label = String(formData.get('label') ?? '').trim() || 'Agent key'
  const result = await mintAccessKey(label)
  if (!result.ok) redirect(`/settings?mintError=${result.reason}`)
  const jar = await cookies()
  jar.set(MINTED_KEY_COOKIE, JSON.stringify({ id: result.id, rawKey: result.rawKey }), {
    httpOnly: true, sameSite: 'lax', secure: await secure(), maxAge: 5 * 60, path: '/settings',
  })
  redirect('/settings')
}

export async function dismissMintedKeyAction() {
  await requireSession()
  const jar = await cookies()
  jar.delete({ name: MINTED_KEY_COOKIE, path: '/settings' })
  redirect('/settings')
}

export async function revealKeyAction(formData: FormData) {
  await requireSession()
  const keyId = String(formData.get('keyId') ?? '')
  const rawKey = await revealAccessKey(keyId)
  if (!rawKey) {
    // Still listed but undecryptable means SECRET_KEY changed since minting;
    // say so instead of a button that silently does nothing.
    const stillActive = (await listActiveAccessKeys()).some(k => k.id === keyId)
    redirect(stillActive ? `/settings?revealError=${encodeURIComponent(keyId)}` : '/settings')
  }
  const jar = await cookies()
  jar.set(REVEALED_KEY_COOKIE, JSON.stringify({ id: keyId, rawKey }), {
    httpOnly: true, sameSite: 'lax', secure: await secure(), maxAge: 2 * 60, path: '/settings',
  })
  redirect('/settings')
}

export async function hideRevealedKeyAction() {
  await requireSession()
  const jar = await cookies()
  jar.delete({ name: REVEALED_KEY_COOKIE, path: '/settings' })
  revalidatePath('/settings')
}

export async function revokeKeyAction(formData: FormData) {
  const session = await requireSession()
  const keyId = String(formData.get('keyId') ?? '')
  await revokeAccessKey(keyId)
  const jar = await cookies()
  jar.delete({ name: REVEALED_KEY_COOKIE, path: '/settings' })
  jar.delete({ name: MINTED_KEY_COOKIE, path: '/settings' })
  // Revoking the key this browser logged in with ends this session too.
  if (keyId === session.keyId) { await endSession(); redirect('/login') }
  revalidatePath('/settings')
}

export async function revokeAllKeysAction() {
  await requireSession()
  await revokeAllAccessKeys()
  await endSession()
  redirect('/login')
}
