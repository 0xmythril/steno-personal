import { useTempDataDir } from './helpers/db'

useTempDataDir()
// Set before anything reads env: lib/log builds the root pino logger at import
// time, and hundreds of JSON lines per run bury a real failure. A test that
// wants to assert on a log line can still override it for itself.
process.env.LOG_LEVEL = 'silent'
const { runMigrations } = await import('@/lib/db/migrate')
runMigrations()
