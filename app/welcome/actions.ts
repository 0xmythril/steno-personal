'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { requireSession } from '@/lib/auth'
import { FIRST_KEY_COOKIE } from '@/lib/services/keys-flash'

// The owner confirmed they saved the key: drop the flash so it is not
// re-rendered on a later visit, and go to the archive.
export async function welcomeDoneAction(): Promise<void> {
  await requireSession()
  const jar = await cookies()
  jar.delete({ name: FIRST_KEY_COOKIE, path: '/welcome' })
  redirect('/')
}
