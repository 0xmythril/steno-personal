'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { requireSession, endSession, isHttps } from '@/lib/auth'
import { mintAccessKey, revealAccessKey, revokeAccessKey, revokeAllAccessKeys, listActiveAccessKeys } from '@/lib/services/access-keys'
import { MINTED_KEY_COOKIE, REVEALED_KEY_COOKIE, INSTRUCTIONS_KEY_COOKIE } from '@/lib/services/keys-flash'
import { updateSettings } from '@/lib/services/settings'
import { revokePasskey, revokeAllPasskeys } from '@/lib/services/passkeys'

export async function mintKeyAction(formData: FormData) {
  await requireSession()
  const label = String(formData.get('label') ?? '').trim() || 'Agent key'
  const result = await mintAccessKey(label)
  if (!result.ok) redirect(`/settings?mintError=${result.reason}`)
  const jar = await cookies()
  jar.set(MINTED_KEY_COOKIE, JSON.stringify({ id: result.id, rawKey: result.rawKey }), {
    httpOnly: true, sameSite: 'lax', secure: await isHttps(), maxAge: 5 * 60, path: '/settings',
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
    httpOnly: true, sameSite: 'lax', secure: await isHttps(), maxAge: 2 * 60, path: '/settings',
  })
  redirect('/settings')
}

export async function hideRevealedKeyAction() {
  await requireSession()
  const jar = await cookies()
  jar.delete({ name: REVEALED_KEY_COOKIE, path: '/settings' })
  revalidatePath('/settings')
}

// Fill an existing key into the "Connect your agent" snippets. Same shape as
// reveal: the raw key rides an httpOnly flash to the next render, never a URL.
export async function useKeyForInstructionsAction(formData: FormData) {
  await requireSession()
  const keyId = String(formData.get('keyId') ?? '')
  const rawKey = await revealAccessKey(keyId)
  if (!rawKey) {
    const stillActive = (await listActiveAccessKeys()).some(k => k.id === keyId)
    redirect(stillActive ? `/settings?instructionsError=${encodeURIComponent(keyId)}` : '/settings')
  }
  const jar = await cookies()
  jar.set(INSTRUCTIONS_KEY_COOKIE, JSON.stringify({ id: keyId, rawKey }), {
    httpOnly: true, sameSite: 'lax', secure: await isHttps(), maxAge: 5 * 60, path: '/settings',
  })
  redirect('/settings')
}

export async function clearInstructionsKeyAction() {
  await requireSession()
  const jar = await cookies()
  jar.delete({ name: INSTRUCTIONS_KEY_COOKIE, path: '/settings' })
  redirect('/settings')
}

export async function revokeKeyAction(formData: FormData) {
  const session = await requireSession()
  const keyId = String(formData.get('keyId') ?? '')
  await revokeAccessKey(keyId)
  const jar = await cookies()
  jar.delete({ name: REVEALED_KEY_COOKIE, path: '/settings' })
  jar.delete({ name: MINTED_KEY_COOKIE, path: '/settings' })
  jar.delete({ name: INSTRUCTIONS_KEY_COOKIE, path: '/settings' })
  // Revoking the key this browser logged in with ends this session too.
  if (keyId === session.keyId) { await endSession(); redirect('/login') }
  revalidatePath('/settings')
}

export async function revokeAllKeysAction() {
  await requireSession()
  await revokeAllAccessKeys()
  // Clear the flashes before the session ends, or a just-minted raw key sits
  // in the browser jar for up to five minutes after logout.
  const jar = await cookies()
  jar.delete({ name: REVEALED_KEY_COOKIE, path: '/settings' })
  jar.delete({ name: MINTED_KEY_COOKIE, path: '/settings' })
  jar.delete({ name: INSTRUCTIONS_KEY_COOKIE, path: '/settings' })
  await endSession()
  redirect('/login')
}

// Passkeys. No flash cookies here: nothing about a passkey is a secret the
// page has to show once.

export async function revokePasskeyAction(formData: FormData) {
  const session = await requireSession()
  const passkeyId = String(formData.get('passkeyId') ?? '')
  await revokePasskey(passkeyId)
  // Removing the passkey this browser logged in with ends this session too.
  if (passkeyId === session.passkeyId) { await endSession(); redirect('/login') }
  revalidatePath('/settings')
}

// Ends the current session only when a passkey opened it: a key session
// that removes every passkey has nothing to lose.
export async function revokeAllPasskeysAction() {
  const session = await requireSession()
  await revokeAllPasskeys()
  if (session.via === 'passkey') { await endSession(); redirect('/login') }
  revalidatePath('/settings')
}

// Enrichment (M4). Every one of these re-runs the guard, and none of them
// touches a flash cookie: the OpenRouter key is write-only from the portal's
// side — it goes in, and after that only "key saved" ever comes back out.

export async function saveOpenrouterKeyAction(formData: FormData) {
  await requireSession()
  const key = String(formData.get('openrouterKey') ?? '').trim()
  if (key) await updateSettings({ openrouterKey: key })
  redirect('/settings')
}

export async function clearOpenrouterKeyAction() {
  await requireSession()
  // Clearing the key turns enrichment off with it: leaving the toggles on
  // would show an enabled feature that silently cannot run.
  await updateSettings({ openrouterKey: null, analyzeImages: false, analyzeAudio: false })
  redirect('/settings')
}

export async function updateEnrichmentAction(formData: FormData) {
  await requireSession()
  await updateSettings({
    // An unchecked box submits nothing at all, which is exactly `false`.
    analyzeImages: formData.get('analyzeImages') === 'on',
    analyzeAudio: formData.get('analyzeAudio') === 'on',
    // A value outside the catalog is ignored by updateSettings.
    visionModel: String(formData.get('visionModel') ?? ''),
    transcriptionModel: String(formData.get('transcriptionModel') ?? ''),
  })
  redirect('/settings')
}
