import { formatDateHeading } from '@/lib/format'
import type { MessageView } from '@/lib/services/queries'

export type Run = {
  senderKey: string
  senderLabel: string
  isMe: boolean
  messages: MessageView[]
}

// Consecutive messages from one sender collapse into a run, so the transcript
// shows the name once per burst instead of once per line. The owner's own
// messages never merge with anyone else's, because the key carries fromOwner.
//
// The key is the display name, not a sender identity: MessageView deliberately
// carries no sender id (the shared interface for M1–M5 fixes its shape, and no
// read path exposes one). Two different people sharing a display name in a
// group chat therefore merge into one run — the name shown above it is still
// correct for both, so the cost is a missing visual break, not a
// misattribution. Widening MessageView is the fix if that ever matters.
export function groupRuns(items: MessageView[]): Run[] {
  const runs: Run[] = []
  for (const m of items) {
    const label = m.senderName ?? 'Unknown'
    const key = m.fromOwner ? 'me' : `them:${label}`
    const last = runs[runs.length - 1]
    if (last && last.senderKey === key) { last.messages.push(m); continue }
    runs.push({ senderKey: key, senderLabel: label, isMe: m.fromOwner, messages: [m] })
  }
  return runs
}

// Callers group by date first; a run never spans a date boundary.
export function groupByDate(items: MessageView[], tz?: string): Array<{ dateLabel: string; messages: MessageView[] }> {
  const groups: Array<{ dateLabel: string; messages: MessageView[] }> = []
  for (const m of items) {
    const dateLabel = formatDateHeading(m.sentAt, tz)
    const last = groups[groups.length - 1]
    if (last && last.dateLabel === dateLabel) last.messages.push(m)
    else groups.push({ dateLabel, messages: [m] })
  }
  return groups
}
