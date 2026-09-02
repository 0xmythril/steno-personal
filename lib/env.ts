import { z } from 'zod'
import 'dotenv/config'

// Railway clears a variable to '' rather than removing it, and .env.example
// ships bare keys. Every optional var goes through this so '' means unset.
const blank = <T extends z.ZodTypeAny>(inner: T) => z.preprocess(v => (v === '' ? undefined : v), inner)

export const envSchema = z.object({
  DATA_DIR: blank(z.string().min(1).optional()).default('./data'),
  PORT: blank(z.coerce.number().int().positive().optional()).default(3000),
  SECRET_KEY: blank(z.string().min(32, 'SECRET_KEY must be at least 32 characters').optional()),
  LOG_LEVEL: blank(z.enum(['trace', 'debug', 'info', 'warn', 'error']).optional()).default('info'),
})

export type Env = z.infer<typeof envSchema>
let cached: Env | null = null

function load(): Env {
  return envSchema.parse({ ...process.env })
}

// Parsed lazily on first access so importing this module during `next build`
// (an env-less Docker build) does not fail.
export const env: Env = new Proxy({} as Env, {
  get(_t, prop) { cached ??= load(); return cached[prop as keyof Env] },
  has(_t, prop) { cached ??= load(); return prop in cached },
  ownKeys() { cached ??= load(); return Reflect.ownKeys(cached) },
  getOwnPropertyDescriptor(_t, prop) { cached ??= load(); return Object.getOwnPropertyDescriptor(cached, prop) },
})

// Tests set DATA_DIR per file before first access; this lets a test that
// changes process.env re-parse. Never called in production code.
export function _resetEnvCacheForTests() { cached = null }
