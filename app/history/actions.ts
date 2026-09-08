'use server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireSession } from '@/lib/auth'
import { purgeRevokedKey, resolveDispute } from '@/lib/services/disputes'
export async function resolveAction(form: FormData) {
  const session = await requireSession()
  const id = String(form.get('id') ?? ''), token = String(form.get('token') ?? ''), action = form.get('action')
  if (!['keep', 'accept', 'delete'].includes(String(action))) redirect('/history/disputes')
  const result = resolveDispute({ messageId: id, token, action: action as 'keep' | 'accept' | 'delete', candidateId: String(form.get('candidate') ?? '') }, { id: session.keyId ?? session.passkeyId, label: session.label })
  revalidatePath('/history', 'layout'); revalidatePath('/', 'layout')
  if (!result.ok) redirect(`/history/disputes/${encodeURIComponent(id)}?changed=1`)
  redirect('/history/disputes?resolved=1')
}
export async function purgeAction(form: FormData) {
  const session = await requireSession()
  const id = String(form.get('id') ?? ''), token = String(form.get('token') ?? '')
  if (!token) redirect('/history/keys')
  const result = purgeRevokedKey(id, { id: session.keyId ?? session.passkeyId, label: session.label }, token)
  revalidatePath('/', 'layout')
  if (!result.ok) redirect(`/history/keys/${encodeURIComponent(id)}?changed=1`)
  redirect('/history/keys?removed=1')
}
