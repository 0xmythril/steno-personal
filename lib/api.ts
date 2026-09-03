// Shared by every JSON route. Deliberately free of imports from lib/auth.ts
// so a test can mock that module without also mocking this one.
export function unauthorized(): Response {
  return Response.json({ error: 'unauthorized' }, {
    status: 401,
    headers: { 'WWW-Authenticate': 'Bearer' },
  })
}

export function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 })
}

export function notFound(): Response {
  return Response.json({ error: 'not_found' }, { status: 404 })
}

export const MAX_LIMIT = 200

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

export function parseLimit(raw: string | null): Parsed<number | undefined> {
  if (raw === null || raw === '') return { ok: true, value: undefined }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) return { ok: false, error: 'invalid_limit' }
  return { ok: true, value: n }
}

export function parseDate(raw: string | null, field: string): Parsed<Date | undefined> {
  if (raw === null || raw === '') return { ok: true, value: undefined }
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return { ok: false, error: `invalid_${field}` }
  return { ok: true, value: d }
}
