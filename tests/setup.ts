import { useTempDataDir } from './helpers/db'

useTempDataDir()
const { runMigrations } = await import('@/lib/db/migrate')
runMigrations()
