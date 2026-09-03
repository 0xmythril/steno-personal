import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'

// Flat config. The Next presets carry the React, hooks and TypeScript rules.
// The project's real boundaries (read-only channels, one importer per chat
// library, no telemetry) are enforced by the structural tests in tests/, not
// by lint — lint is for the ordinary mistakes.
const config = [
  ...nextVitals,
  ...nextTs,
  {
    ignores: ['.next/**', 'node_modules/**', 'data/**', '.superpowers/**', 'docs/superpowers/**', '.claude/**', 'drizzle/**'],
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  {
    // Only app/ holds React. Elsewhere a function named use* (Baileys'
    // useMultiFileAuthState, the test helper useTempDataDir) is not a hook.
    files: ['lib/**', 'worker/**', 'scripts/**', 'tests/**'],
    rules: { 'react-hooks/rules-of-hooks': 'off' },
  },
]

export default config
