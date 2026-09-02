'use server'

import { redirect } from 'next/navigation'
import { verifyAccessKey } from '@/lib/services/access-keys'
import { requireSession, startSession, endSession } from '@/lib/auth'

export async function loginAction(formData: FormData) {
  const raw = String(formData.get('key') ?? '').trim()
  const key = raw ? await verifyAccessKey(raw) : null
  if (!key) redirect('/login?error=1')
  await startSession(key.id)
  redirect('/')
}

export async function logoutAction() {
  await requireSession()
  await endSession()
  redirect('/login')
}
