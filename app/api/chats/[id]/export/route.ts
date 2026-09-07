import { requireCookieAuth } from '@/lib/auth'
import { notFound, withErrorBoundary } from '@/lib/api'
import { exportChat } from '@/lib/services/chat-export'

const MAX_SLUG_LENGTH = 40

// Lowercased, non-alphanumerics collapsed to one '-', trimmed, capped — and
// the chat id itself when a title leaves nothing usable, so the file always
// has a name.
function slugify(title: string | null, chatId: string): string {
  const slug = (title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
  return slug || chatId
}

// Owner-only: the export carries the whole chat including provenance, so a
// bearer access key must never reach it — requireCookieAuth is the same
// cookie-or-nothing guard the mutating connection routes use.
export const GET = withErrorBoundary(async (
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const denied = await requireCookieAuth(request)
  if (denied) return denied

  const { id } = await params
  const exported = await exportChat(id)
  if (!exported) return notFound()

  const filename = `steno-${slugify(exported.chat.title, exported.chat.id)}-${exported.exportedAt.slice(0, 10)}.json`
  return new Response(JSON.stringify(exported, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
})
