import pino from 'pino'
import { env } from '@/lib/env'

// One root logger. Rule (spec invariant 6): log counts and kinds, never
// names, phone numbers, JIDs, text, queries, or secrets.
export const log = pino({ level: env.LOG_LEVEL })
