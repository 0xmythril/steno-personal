import { isReady } from '@/lib/services/readiness'
import { version } from '@/package.json'

export const dynamic = 'force-dynamic'

export function GET() {
  const ok = isReady()
  return Response.json({ ok, version }, { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } })
}
