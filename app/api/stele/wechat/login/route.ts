import { requireCookieAuth } from '@/lib/auth'
import { withErrorBoundary } from '@/lib/api'
import { createConnection, listConnections, getConnection } from '@/lib/services/connections'
import { completeLogin } from '@/lib/services/login'
import { steleState } from '@/lib/services/stele'
import { SteleClient, steleError } from '@/lib/channels/stele-client'
import { steleLoginConfigured } from '@/lib/channels/stele-config'
import { loginSchema } from '@/lib/channels/stele-wire'

export const runtime = 'nodejs'
const streams = new Set<SteleClient>()
export const POST = withErrorBoundary(async (req: Request) => {
  const denied = await requireCookieAuth(req); if (denied) return denied
  try {
    const origin = new URL(req.headers.get('origin') ?? '')
    if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== (req.headers.get('host') ?? new URL(req.url).host)) throw new Error()
  } catch { return Response.json({ error: 'origin_required' }, { status: 403 }) }
  if (!steleLoginConfigured()) return Response.json({ error: 'stele_unconfigured' }, { status: 503 })
  if (streams.size >= 2) return Response.json({ error: 'rate_limited' }, { status: 429 })
  let connection = (await listConnections()).find(c => c.channel === 'wechat' && c.purpose === 'archive' && !c.revokedAt && ['active', 'pending'].includes(c.status))
  if (!connection) {
    const created = await createConnection('wechat')
    if (!created.ok) return Response.json({ error: created.reason }, { status: 409 })
    connection = (await getConnection(created.id))!
  }
  const connectionId = connection.id, client = new SteleClient(), encoder = new TextEncoder()
  streams.add(client)
  const cancel = () => client.close()
  req.signal.addEventListener('abort', cancel, { once: true })
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let alive = true, checking = false
      const send = (frame: unknown) => {
        if (!alive) return
        if ((controller.desiredSize ?? 0) <= 0) { alive = false; client.close(); return }
        try { controller.enqueue(encoder.encode(JSON.stringify(frame) + '\n')) } catch { client.close() }
      }
      const guard = setInterval(async () => {
        if (checking || !alive) return
        checking = true
        try {
          const [denied, row] = await Promise.all([requireCookieAuth(req), getConnection(connectionId)])
          if (denied || !row || row.revokedAt || !['pending', 'active'].includes(row.status)) { alive = false; client.close() }
        } catch { alive = false; client.close() }
        finally { checking = false }
      }, 1000)
      void (async () => {
        try {
          for await (const raw of client.stream('/v1/login?mode=qr', true)) {
            if (!alive || req.signal.aborted) break
            const event = loginSchema.parse(raw)
            if (event.type === 'login_success') {
              if (await requireCookieAuth(req)) break
              const row = await getConnection(connectionId)
              if (row?.status === 'active' && !row.revokedAt) {
                const state = steleState(connectionId)
                if (state.sourceId !== event.sourceId || state.accountId !== event.account.externalAccountId) { send({ type: 'error', error: 'account_mismatch' }); break }
              } else if (await completeLogin(connectionId, JSON.stringify({ sourceId: event.sourceId, accountId: event.account.externalAccountId, cursor: null }), { channel: 'wechat', ...event.account }) !== 'ok') break
              send({ type: 'login_success' }); break
            }
            if (event.type === 'qr') {
              const expiresAt = Math.min(Date.parse(event.expiresAt), Date.now() + 10_000)
              if (expiresAt <= Date.now()) send({ type: 'status' })
              else send({ type: 'qr', qrDataUrl: event.qrDataUrl, expiresAt: new Date(expiresAt).toISOString() })
            } else if (event.type === 'error') { send({ type: 'error', error: 'reader_unavailable' }); break }
            else { send({ type: event.type }); if (event.type === 'login_timeout') break }
          }
        } catch (error) { send({ type: 'error', error: steleError(error) }) }
        finally { alive = false; clearInterval(guard); client.close(); streams.delete(client); req.signal.removeEventListener('abort', cancel); try { controller.close() } catch { /* request cancelled */ } }
      })()
    },
    cancel() { client.close(); streams.delete(client); req.signal.removeEventListener('abort', cancel) },
  }, { highWaterMark: 4 })
  return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } })
})
