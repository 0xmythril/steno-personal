import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['tests/setup.ts'],
    pool: 'forks', // one process per file: each gets its own DATA_DIR and its own better-sqlite3 handle
    env: { NODE_ENV: 'test' },
  },
  resolve: { alias: {
    '@': path.resolve(import.meta.dirname),
    'server-only': path.resolve(import.meta.dirname, 'tests/helpers/server-only.ts'),
    'next/font/google': path.resolve(import.meta.dirname, 'tests/helpers/next-font-google.ts'),
  } },
})
