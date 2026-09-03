import { describe, it, expect } from 'vitest'
import { formatDateHeading, formatTime, formatRelativeTime } from '@/lib/format'
import { groupRuns, groupByDate } from '@/lib/transcript'
import type { MessageView } from '@/lib/services/queries'

const msg = (over: Partial<MessageView> & { id: string }): MessageView => ({
  externalMessageId: over.id, sentAt: new Date('2026-08-01T10:00:00Z'),
  type: 'text', text: 'hi', senderName: 'Alice', fromOwner: false, editedAt: null, media: null,
  ...over,
})

describe('formatting', () => {
  it('renders a stable date heading and time in a given zone', () => {
    const d = new Date('2026-08-01T23:30:00Z')
    // The comma is ICU's, not ours, and it has moved between ICU versions —
    // match the parts that carry meaning, not the separator.
    expect(formatDateHeading(d, 'UTC')).toMatch(/^Sat,? 1 Aug 2026$/)
    expect(formatTime(d, 'UTC')).toBe('23:30')
    // A zone change is a real day change, not a cosmetic one.
    expect(formatDateHeading(d, 'Asia/Tokyo')).toMatch(/^Sun,? 2 Aug 2026$/)
  })

  it('describes recency in words, and says so when there is nothing to describe', () => {
    const now = new Date('2026-08-01T12:00:00Z')
    expect(formatRelativeTime(null, now)).toBe('never')
    expect(formatRelativeTime(new Date('2026-08-01T11:59:30Z'), now)).toBe('just now')
    expect(formatRelativeTime(new Date('2026-08-01T11:30:00Z'), now)).toBe('30 minutes ago')
    expect(formatRelativeTime(new Date('2026-08-01T11:00:00Z'), now)).toBe('1 hour ago')
    expect(formatRelativeTime(new Date('2026-07-30T12:00:00Z'), now)).toBe('2 days ago')
    // Past a week, a date is more useful than a count of days.
    expect(formatRelativeTime(new Date('2026-01-01T12:00:00Z'), now)).toMatch(/^Thu,? 1 Jan 2026$/)
  })
})

describe('transcript grouping', () => {
  it('collapses consecutive messages from one sender into a run', () => {
    const runs = groupRuns([
      msg({ id: '1', senderName: 'Alice' }),
      msg({ id: '2', senderName: 'Alice' }),
      msg({ id: '3', senderName: 'Bob' }),
    ])
    expect(runs).toHaveLength(2)
    expect(runs[0].messages.map(m => m.externalMessageId)).toEqual(['1', '2'])
    expect(runs[0].senderLabel).toBe('Alice')
    expect(runs[1].senderLabel).toBe('Bob')
  })

  it('never merges the owner with anyone else, even under the same name', () => {
    const runs = groupRuns([
      msg({ id: '1', fromOwner: true, senderName: 'Me' }),
      msg({ id: '2', fromOwner: false, senderName: 'Me' }),
    ])
    expect(runs).toHaveLength(2)
    expect(runs[0].isMe).toBe(true)
    expect(runs[1].isMe).toBe(false)
  })

  it('falls back to a stable label when the sender name is missing', () => {
    const runs = groupRuns([msg({ id: '1', senderName: null })])
    expect(runs[0].senderLabel).toBe('Unknown')
    expect(runs[0].senderKey).toBe('them:Unknown')
  })

  it('groups by calendar day in the given zone', () => {
    const groups = groupByDate([
      msg({ id: '1', sentAt: new Date('2026-08-01T10:00:00Z') }),
      msg({ id: '2', sentAt: new Date('2026-08-01T18:00:00Z') }),
      msg({ id: '3', sentAt: new Date('2026-08-02T09:00:00Z') }),
    ], 'UTC')
    expect(groups.map(g => g.messages.map(m => m.externalMessageId))).toEqual([['1', '2'], ['3']])
    expect(groups[0].dateLabel).toMatch(/^Sat,? 1 Aug 2026$/)
  })
})
