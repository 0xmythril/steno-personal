import { formatDateHeading } from '@/lib/format'
import type { MessageView } from '@/lib/services/queries'

export type Run = {
  senderKey: string
  senderLabel: string
  // The name the channel stored for this sender, when the address book calls
  // them something else. Null when there is nothing extra to say — including
  // for the owner, who is always "You".
  rawLabel: string | null
  isMe: boolean
  messages: MessageView[]
}

// Consecutive messages from one sender collapse into a run, so the transcript
// shows the name once per burst instead of once per line. The owner's own
// messages never merge with anyone else's, because the key carries fromOwner.
//
// When the address book knows the sender, it wins: its name is what the run is
// labelled with, and its id — this instance's own uuid — is what the run is
// keyed by. That id is the only stable sender identity a MessageView carries,
// so one person writing under two spellings (a rename, or the two channels
// disagreeing) is correctly one run, and two people sharing a display name are
// correctly two.
//
// Without a person there is still no sender id to key on, so the key falls
// back to the display name: two strangers sharing one name in a group chat
// merge into a single run. The name above it is right for both, so the cost is
// a missing visual break, not a misattribution — and linking either of them on
// /people fixes it.
//
// The owner is never relabelled: their messages key on 'me' whether or not an
// identity of theirs has been linked to a person.
export function groupRuns(items: MessageView[]): Run[] {
  const runs: Run[] = []
  for (const m of items) {
    const stored = m.senderName ?? 'Unknown'
    const person = m.fromOwner ? null : m.person
    const key = m.fromOwner ? 'me' : person ? `person:${person.id}` : `them:${stored}`
    const senderLabel = person ? person.name : stored
    // Only worth showing when it says something the label does not.
    const rawLabel = person && m.senderName && m.senderName !== person.name ? m.senderName : null
    const last = runs[runs.length - 1]
    if (last && last.senderKey === key) { last.messages.push(m); continue }
    runs.push({ senderKey: key, senderLabel, rawLabel, isMe: m.fromOwner, messages: [m] })
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

export type TextSegment = { kind: 'text'; value: string } | { kind: 'link'; value: string; href: string }

// Splits message text into plain runs and links. Only http(s) URLs and bare
// www. hosts become links, and www. is always sent to https; anything else a
// message contains (javascript:, data:, custom schemes) stays text, because
// the text is whatever a stranger typed. Trailing punctuation that is almost
// never part of a URL is left outside the link.
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi
const TRAILING = /^[.,;:!?\]}'"]$/

export function linkify(text: string): TextSegment[] {
  const out: TextSegment[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    let raw = m[0]
    // Peel trailing punctuation one character at a time. A ")" comes off only
    // when unbalanced: "(see https://x.y/a)" keeps ")" out, while
    // "https://en.wikipedia.org/wiki/A_(b)" keeps it in.
    for (;;) {
      const ch = raw[raw.length - 1]
      if (ch === ')') {
        const opens = (raw.match(/\(/g) ?? []).length
        const closes = (raw.match(/\)/g) ?? []).length
        if (closes <= opens) break
      } else if (!TRAILING.test(ch ?? '')) break
      raw = raw.slice(0, -1)
    }
    if (!raw) continue
    const start = m.index ?? 0
    if (start > last) out.push({ kind: 'text', value: text.slice(last, start) })
    out.push({ kind: 'link', value: raw, href: /^https?:\/\//i.test(raw) ? raw : `https://${raw}` })
    last = start + raw.length
  }
  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) })
  return out
}
