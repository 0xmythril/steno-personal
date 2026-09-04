import { z } from 'zod'
import 'dotenv/config'
import { TELEGRAM_DEFAULT_API_ID, TELEGRAM_DEFAULT_API_HASH } from '@/lib/channels/telegram-defaults'
import { POSTHOG_DEFAULT_KEY, POSTHOG_DEFAULT_HOST } from '@/lib/telemetry-defaults'

// Railway clears a variable to '' rather than removing it, and .env.example
// ships bare keys. Every optional var goes through this so '' means unset.
const blank = <T extends z.ZodTypeAny>(inner: T) => z.preprocess(v => (v === '' ? undefined : v), inner)

export const envSchema = z.object({
  DATA_DIR: blank(z.string().min(1).optional()).default('./data'),
  PORT: blank(z.coerce.number().int().positive().optional()).default(3000),
  SECRET_KEY: blank(z.string().min(32, 'SECRET_KEY must be at least 32 characters').optional()),
  // 'silent' is pino's own off switch. It exists so the test run is readable:
  // hundreds of JSON lines per run bury a real failure.
  LOG_LEVEL: blank(z.enum(['trace', 'debug', 'info', 'warn', 'error', 'silent']).optional()).default('info'),
  // Backstop against runaway provider spend: billed analyses in the trailing
  // 24 h. 0 disables the drain entirely, which is why the bound is nonnegative
  // rather than positive.
  //
  // A CEILING, not an exact quota: the count is taken once per pass, before
  // either medium runs, so a pass that starts just under the limit can still
  // drain a full batch of each medium. Worst case overshoot is
  // 2 x ANALYSIS_BACKFILL_BATCH - 1 rows.
  ANALYSIS_DAILY_LIMIT: blank(z.coerce.number().int().nonnegative().optional()).default(500),
  // Rows enqueued and drained per medium per pass. Meters a backfill out over
  // many passes instead of one open-ended one.
  ANALYSIS_BACKFILL_BATCH: blank(z.coerce.number().int().positive().optional()).default(20),
  // The project defaults are empty until the owner registers the app; an
  // api_id of 0 and an empty hash both read as "unset" to the worker.
  TELEGRAM_API_ID: blank(z.coerce.number().int().nonnegative().optional()).default(TELEGRAM_DEFAULT_API_ID),
  TELEGRAM_API_HASH: blank(z.string().optional()).default(TELEGRAM_DEFAULT_API_HASH),
  // Host-operator operations, each performed by scripts/boot.ts once per value
  // (lib/services/boot-ops.ts). Whoever can set these already owns the volume.
  // STENO_RESET empties DATA_DIR; STENO_MINT_KEY mints a key with that label
  // and prints it to the log — the only place a key is ever printed.
  STENO_RESET: blank(z.string().optional()),
  STENO_MINT_KEY: blank(z.string().optional()),
  // Anonymous usage events go to PostHog (lib/services/telemetry.ts). The
  // key is the write-only project token every PostHog client embeds, shipped
  // as a default so an instance reports from day one; a fork points it at
  // its own project. Blank on Railway reads as unset and so falls back to the
  // default — turning reporting OFF is the Settings toggle or DO_NOT_TRACK,
  // which lib/services/telemetry.ts reads straight from process.env.
  STENO_POSTHOG_KEY: blank(z.string().optional()).default(POSTHOG_DEFAULT_KEY),
  STENO_POSTHOG_HOST: blank(z.url().optional()).default(POSTHOG_DEFAULT_HOST),
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
