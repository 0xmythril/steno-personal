import { describe, it, expect } from 'vitest'
import { formatDateHeading, formatTime, formatRelativeTime } from '@/lib/format'
import { linkify, groupRuns, groupByDate } from '@/lib/transcript'
import type { MessageView } from '@/lib/services/queries'

const msg = (over: Partial<MessageView> & { id: string }): MessageView => ({
  externalMessageId: over.id, sentAt: new Date('2026-08-01T10:00:00Z'),
  type: 'text', text: 'hi', senderName: 'Alice', fromOwner: false, editedAt: null,
  person: null, media: null, replyTo: null, channelName: null,
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

  it('labels a run with the person, not the name the channel stored', () => {
    const person = { id: 'p1', name: 'Ada' }
    const runs = groupRuns([
      msg({ id: '1', senderName: 'Ada', channelName: 'ada@work', person }),
      msg({ id: '2', senderName: 'Ada', channelName: 'Ada Lovelace', person }),
    ])
    // One person under two spellings is one run: the key is the person's id,
    // which is the only stable sender identity a MessageView carries.
    expect(runs).toHaveLength(1)
    expect(runs[0].senderKey).toBe('person:p1')
    expect(runs[0].senderLabel).toBe('Ada')
    // …and the channel's own name is still shown, muted, beside it.
    expect(runs[0].rawLabel).toBe('ada@work')
  })

  it('says nothing extra when the stored name already is the person name', () => {
    const runs = groupRuns([msg({ id: '1', senderName: 'Ada', person: { id: 'p1', name: 'Ada' } })])
    expect(runs[0].senderLabel).toBe('Ada')
    expect(runs[0].rawLabel).toBeNull()
    // An unlinked sender has nothing to disagree with.
    expect(groupRuns([msg({ id: '2', senderName: 'Bob' })])[0].rawLabel).toBeNull()
  })

  it('keeps two people apart even when the channel calls them the same thing', () => {
    const runs = groupRuns([
      msg({ id: '1', senderName: 'A', person: { id: 'p1', name: 'Ada' } }),
      msg({ id: '2', senderName: 'A', person: { id: 'p2', name: 'Alan' } }),
    ])
    expect(runs).toHaveLength(2)
    expect(runs.map(r => r.senderKey)).toEqual(['person:p1', 'person:p2'])
  })

  it('never lets the address book relabel the owner', () => {
    // Linking one's own identity to a person must not turn "You" into a name
    // or merge the owner's run with the other side's.
    const person = { id: 'p1', name: 'Ada' }
    const runs = groupRuns([
      msg({ id: '1', fromOwner: true, senderName: 'Ada', person }),
      msg({ id: '2', fromOwner: false, senderName: 'Ada', person }),
    ])
    expect(runs).toHaveLength(2)
    expect(runs[0].senderKey).toBe('me')
    expect(runs[0].rawLabel).toBeNull()
    expect(runs[1].senderKey).toBe('person:p1')
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

describe('linkify', () => {
  it('turns http(s) URLs and www. hosts into links and leaves everything else as text', () => {
    expect(linkify('see https://example.org/a?b=1 and www.steno.chat now')).toEqual([
      { kind: 'text', value: 'see ' },
      { kind: 'link', value: 'https://example.org/a?b=1', href: 'https://example.org/a?b=1' },
      { kind: 'text', value: ' and ' },
      { kind: 'link', value: 'www.steno.chat', href: 'https://www.steno.chat' },
      { kind: 'text', value: ' now' },
    ])
  })

  it('keeps trailing punctuation and an unbalanced paren out of the link', () => {
    expect(linkify('(docs: https://x.y/a).')).toEqual([
      { kind: 'text', value: '(docs: ' },
      { kind: 'link', value: 'https://x.y/a', href: 'https://x.y/a' },
      { kind: 'text', value: ').' },
    ])
    expect(linkify('https://en.wikipedia.org/wiki/A_(b)')).toEqual([
      { kind: 'link', value: 'https://en.wikipedia.org/wiki/A_(b)', href: 'https://en.wikipedia.org/wiki/A_(b)' },
    ])
  })

  it('never links a non-http scheme, because the text is untrusted', () => {
    expect(linkify('javascript:alert(1) data:text/html,x mailto:a@b.c')).toEqual([
      { kind: 'text', value: 'javascript:alert(1) data:text/html,x mailto:a@b.c' },
    ])
    expect(linkify('')).toEqual([])
  })
})

describe('the channel-name hint beside a linked person', () => {
  it('shows the name the channel used when it differs from the address book, and nothing otherwise', () => {
    const [run] = groupRuns([msg({ id: 'a', senderName: 'Mum', channelName: 'Kim Smith', person: { id: 'p1', name: 'Mum' } })])
    expect(run.rawLabel).toBe('Kim Smith')
    const [same] = groupRuns([msg({ id: 'b', senderName: 'Mum', channelName: 'Mum', person: { id: 'p1', name: 'Mum' } })])
    expect(same.rawLabel).toBeNull()
  })
})
