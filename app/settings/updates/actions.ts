'use server'

import { requireSession } from '@/lib/auth'
import { updaterRequest, type AvailableRelease, type UpgradeStatus } from '@/lib/services/upgrades'

export async function checkUpdateAction() {
  await requireSession()
  try { return { release: await updaterRequest<AvailableRelease>('check') } }
  catch { return { error: 'Could not check for updates. Check that the updater is running and try again.' } }
}

export async function startUpgradeAction(version: string) {
  await requireSession()
  if (!/^\d+\.\d+\.\d+$/.test(version)) return { error: 'Select a stable release.' }
  try { return { status: await updaterRequest<UpgradeStatus>('upgrade', version) } }
  catch { return { error: 'The upgrade could not be confirmed. Check its status before trying again.' } }
}
