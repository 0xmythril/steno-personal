// The project's own Telegram application credentials (spec decision 12), so a
// one-click deploy needs nothing from my.telegram.org — the same thing
// Telegram Desktop and every open-source client ships. They identify the
// software, not a user: every deployer still logs in with their own account.
//
// Registered on a number the project controls, not the maintainer's personal
// one, so any action Telegram ever takes against the application stays away
// from a personal account. A self-hoster overrides the pair through
// TELEGRAM_API_ID / TELEGRAM_API_HASH, and TELEGRAM_API_ID=0 opts out of
// Telegram entirely; both are read in lib/env.ts. The Railway staging
// instance runs under a separate pair set as environment variables, so a
// problem there is never a problem here.
export const TELEGRAM_DEFAULT_API_ID = 30494881
export const TELEGRAM_DEFAULT_API_HASH = '4f8725e68ed41290d1024b68b4f97f26'
