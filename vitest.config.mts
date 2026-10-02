import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup.ts'],
    pool: 'forks', // one process per file: each gets its own DATA_DIR and its own better-sqlite3 handle
    env: { NODE_ENV: 'test' },
    // Behaviour tests run against a real SQLite file and the real services,
    // and the slowest take about 4 s on an idle laptop. Under a busy CI runner
    // or a second gate on the same machine that stretches five-fold, and the
    // 5 s default then fails tests that pass alone. A hung test still fails;
    // it just takes half a minute to say so.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: { alias: {
    '@': path.resolve(import.meta.dirname),
    'server-only': path.resolve(import.meta.dirname, 'tests/helpers/server-only.ts'),
    'next/font/google': path.resolve(import.meta.dirname, 'tests/helpers/next-font-google.ts'),
  } },
})
