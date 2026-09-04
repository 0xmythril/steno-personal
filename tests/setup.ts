import { useTempDataDir } from './helpers/db'

useTempDataDir()
// Set before anything reads env: lib/log builds the root pino logger at import
// time, and hundreds of JSON lines per run bury a real failure. A test that
// wants to assert on a log line can still override it for itself.
process.env.LOG_LEVEL = 'silent'
// The build ships a real PostHog token. Every mintAccessKey() in the suite
// would otherwise post a real event; the host gate is the honest way to stop
// that, and tests/telemetry.test.ts lifts it for itself.
process.env.DO_NOT_TRACK = '1'
const { runMigrations } = await import('@/lib/db/migrate')
runMigrations()
