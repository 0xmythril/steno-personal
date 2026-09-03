// Short-lived httpOnly flash cookies that carry a raw key from an action to
// exactly one render of /settings, so a secret never sits in a URL, a log,
// or a Referer header. Not in actions.ts because a 'use server' module may
// only export async functions.
export const MINTED_KEY_COOKIE = 'sp_minted_key'
export const REVEALED_KEY_COOKIE = 'sp_revealed_key'
// The key the user chose to fill into the "Connect your agent" snippets.
export const INSTRUCTIONS_KEY_COOKIE = 'sp_instructions_key'
// The first key an instance hands out — after the setup pairing, or a
// recovery — rides to /welcome the same way, path-scoped to that page.
export const FIRST_KEY_COOKIE = 'sp_first_key'
