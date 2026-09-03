// Dates are rendered on the server in the instance's own timezone (the TZ the
// container runs with), because one self-hosted instance has exactly one
// reader. `tz` exists so tests can pin a zone; no cookie, no client hydration,
// no per-request negotiation.

const HEADING = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })

const headingIn = (tz?: string) => (tz ? new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: tz }) : HEADING)
const timeIn = (tz?: string) => (tz ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }) : TIME)

export function formatDateHeading(d: Date, tz?: string): string {
  return headingIn(tz).format(d)
}

export function formatTime(d: Date, tz?: string): string {
  return timeIn(tz).format(d)
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`

// "never" rather than an empty string: a connection that has not synced yet is
// a state worth naming, and a blank cell reads as a rendering bug.
export function formatRelativeTime(d: Date | null, now: Date = new Date()): string {
  if (!d) return 'never'
  const delta = now.getTime() - d.getTime()
  if (delta < MINUTE) return 'just now'
  if (delta < HOUR) return plural(Math.floor(delta / MINUTE), 'minute')
  if (delta < DAY) return plural(Math.floor(delta / HOUR), 'hour')
  if (delta < 7 * DAY) return plural(Math.floor(delta / DAY), 'day')
  return formatDateHeading(d)
}
