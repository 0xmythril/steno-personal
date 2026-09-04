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
// The suite runs as a deploy that has a Telegram pair: placeholders, not a
// registered application. tests/telegram-credentials.test.ts unsets them to
// exercise the deploy that has none.
process.env.TELEGRAM_API_ID ??= '1'
process.env.TELEGRAM_API_HASH ??= 'test-placeholder-hash'
const { runMigrations } = await import('@/lib/db/migrate')
runMigrations()
