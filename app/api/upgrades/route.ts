import { requireCookieAuth } from '@/lib/auth'
import { updaterRequest, upgradesConfigured, type UpgradeStatus } from '@/lib/services/upgrades'

export async function GET(req: Request) {
  const denied = await requireCookieAuth(req)
  if (denied) return denied
  const headers = { 'Cache-Control': 'no-store' }
  if (!upgradesConfigured()) return Response.json({ phase: 'unconfigured' }, { headers })
  try { return Response.json(await updaterRequest<UpgradeStatus>('status'), { headers }) }
  catch { return Response.json({ phase: 'unavailable' }, { status: 503, headers }) }
}
