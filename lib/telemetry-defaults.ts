// The PostHog project this build reports to: the `steno-personal` project in
// the Steno organisation, US region. The token is the write-only client key
// PostHog expects every client to embed — it can post events and read
// nothing — so it ships here, and a fresh instance reports from its first
// day. A fork sets STENO_POSTHOG_KEY / STENO_POSTHOG_HOST to its own.
// tests/repo-hygiene.test.ts checks this is a real token, not the empty
// placeholder the branch started with.
export const POSTHOG_DEFAULT_KEY = 'phc_xybJgkG7BMJiMrTdYFqxnHtLfGvNxKa58ErJQR9YMnLR'
export const POSTHOG_DEFAULT_HOST = 'https://us.i.posthog.com'
