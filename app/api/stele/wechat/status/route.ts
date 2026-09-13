import { requireCookieAuth } from '@/lib/auth'
import { withErrorBoundary } from '@/lib/api'
import { SteleClient, steleError } from '@/lib/channels/stele-client'
import { steleConfigured, steleLoginConfigured } from '@/lib/channels/stele-config'
import { steleState } from '@/lib/services/stele'
import { listConnections } from '@/lib/services/connections'
import { updaterRequest, upgradesConfigured, type SidecarStatus } from '@/lib/services/upgrades'

export const GET = withErrorBoundary(async (req: Request) => {
  const denied = await requireCookieAuth(req); if (denied) return denied
  const headers = { 'Cache-Control': 'no-store' }
  if (!steleConfigured()) {
    // Not configured. Say whether the companion can install the sidecar from
    // here, so the card can offer a button instead of a shell command.
    if (!upgradesConfigured()) return Response.json({ configured: false, installer: { available: false } }, { headers })
    try { return Response.json({ configured: false, installer: { available: true, ...await updaterRequest<SidecarStatus>('wechat-status') } }, { headers }) }
    catch { return Response.json({ configured: false, installer: { available: false, unreachable: true } }, { headers }) }
  }
  const client = new SteleClient()
  const connection = (await listConnections()).find(c => c.channel === 'wechat' && c.purpose === 'archive' && !c.revokedAt)
  const local = { id: connection?.id ?? null, connected: connection?.status === 'active', lastSyncAt: connection?.lastSyncAt ?? null }
  try {
    const status = await client.status()
    if (local.connected && connection && status.sourceId !== steleState(connection.id).sourceId) { status.readable = false; status.reason = 'account_mismatch' }
    return Response.json({ configured: true, loginConfigured: steleLoginConfigured(), ...local, session: status.session, capture: status.capture, readable: status.readable, reason: status.reason, recalls: status.capabilities.recalls }, { headers })
  } catch (error) { return Response.json({ configured: true, loginConfigured: steleLoginConfigured(), ...local, readable: false, reason: steleError(error) }, { headers }) }
  finally { client.close() }
})
