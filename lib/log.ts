import pino from 'pino'
import { env } from '@/lib/env'

// One root logger. Rule (spec invariant 6): log counts and kinds, never
// names, phone numbers, JIDs, text, queries, or secrets.
export const log = pino({ level: env.LOG_LEVEL })

// Never log an error object directly. drizzle-orm's DrizzleQueryError builds
// its message as `Failed query: ${query}\nparams: ${params}`, so the bound
// values ride along in the message — session ids, access-key hashes and
// ciphertexts today, message text and phone numbers from M1. This keeps the
// name, the code and the query text, and drops everything from `params:` on.
export function errorShape(err: unknown): { name: string; code: string | null; message: string } {
  const e = err as { name?: unknown; code?: unknown; message?: unknown } | null | undefined
  const name = typeof e?.name === 'string' ? e.name : 'Error'
  const code = typeof e?.code === 'string' || typeof e?.code === 'number' ? String(e.code) : null
  const message = typeof e?.message === 'string' ? e.message : String(err ?? '')
  return { name, code, message: message.replace(/\s*params:[\s\S]*$/, '') }
}
