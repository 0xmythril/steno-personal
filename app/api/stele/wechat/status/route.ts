import { requireCookieAuth } from '@/lib/auth'
import { withErrorBoundary } from '@/lib/api'
import { SteleClient, steleError } from '@/lib/channels/stele-client'
import { steleConfigured, steleLoginConfigured } from '@/lib/channels/stele-config'
import { steleState } from '@/lib/services/stele'
import { listConnections } from '@/lib/services/connections'

export const GET = withErrorBoundary(async (req: Request) => {
  const denied = await requireCookieAuth(req); if (denied) return denied
  const headers = { 'Cache-Control': 'no-store' }
  if (!steleConfigured()) return Response.json({ configured: false }, { headers })
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
