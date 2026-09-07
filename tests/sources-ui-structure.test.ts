import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (f: string) => readFileSync(f, 'utf8')

// This file grows: later tasks in the sources-ui plan add describe blocks
// here for the connections page (Task 3) and the MCP push tool (Task 4).

describe('chats page', () => {
  it('imports listSources', () => {
    const src = read('app/page.tsx')
    expect(src).toMatch(/import\s*\{[^}]*\blistSources\b[^}]*\}\s*from\s*'@\/lib\/services\/connections'/)
  })

  it('renders a filter chip per source, linking to ?source=<id>', () => {
    const src = read('app/page.tsx')
    expect(src).toMatch(/sources\.map\(/)
    expect(src).toMatch(/href=\{`\/\?source=\$\{s\.id\}`\}/)
  })

  it('reads sp.source and passes sourceId to listChats', () => {
    const src = read('app/page.tsx')
    expect(src).toMatch(/sp\.source/)
    expect(src).toMatch(/listChats\(\{[^}]*sourceId[^}]*\}\)/)
  })

  it('marks a pushed chat with the note chip', () => {
    const src = read('app/page.tsx')
    expect(src).toMatch(/pushers\.length > 0/)
    expect(src).toMatch(/<span className="chip note">/)
  })

  it('source chips follow the filter rule: the current one plain, the rest filter, never off', () => {
    const src = read('app/page.tsx')
    // Anchor on the block itself: an assertion that only looks at the whole
    // file would pass on the channel row alone, feature deleted or not.
    const block = src.slice(src.indexOf('sources.map('))
    expect(block, 'the sources block exists').toContain('sources.map(')
    const chips = [...block.matchAll(/className="(chip[^"]*)"/g)].map(m => m[1])
    expect(chips).toContain('chip')
    expect(chips).toContain('chip filter')
    expect(chips.some(c => c.includes('off'))).toBe(false)
  })

  it('carries no colour literal', () => {
    const src = read('app/page.tsx')
    expect(src).not.toMatch(/#[0-9a-f]{3,6}\b/i)
  })

  it('divides live channels from pushed sources with a hidden separator, only when a source exists', () => {
    const src = read('app/page.tsx')
    // Anchor on the gap between the channel map and the source map: a
    // separator placed anywhere else in the file would pass a looser check.
    const channelsAt = src.indexOf('CHAT_CHANNELS.map(')
    const sourcesAt = src.indexOf('sources.map(')
    expect(channelsAt, 'the channel block exists').toBeGreaterThan(-1)
    expect(sourcesAt, 'the sources block exists').toBeGreaterThan(-1)
    const gap = src.slice(channelsAt, sourcesAt)
    expect(gap).toMatch(/\{sources\.length > 0 && <span className="chip-sep" aria-hidden="true" \/>\}/)
  })
})

describe('transcript page', () => {
  const path = 'app/chats/[id]/page.tsx'

  it('imports listSources and formatRelativeTime for push provenance', () => {
    const src = read(path)
    expect(src).toMatch(/import\s*\{[^}]*\blistSources\b[^}]*\}\s*from\s*'@\/lib\/services\/connections'/)
    expect(src).toMatch(/import\s*\{[^}]*\bformatRelativeTime\b[^}]*\}\s*from\s*'@\/lib\/format'/)
  })

  it('marks a pushed chat with the note chip in the pad-head, naming who pushed it', () => {
    const src = read(path)
    // Anchor on the pad-head block itself, not the whole file: an assertion
    // that only looks at the whole file would pass on unrelated text alone,
    // feature deleted or not.
    const head = src.slice(src.indexOf('pad-head'), src.indexOf('{pager}'))
    expect(head, 'the pad-head block exists').toContain('pad-head')
    expect(head).toMatch(/pushers\.length > 0/)
    expect(head).toMatch(/<span className="chip note">/)
    expect(head).toMatch(/Pushed by/)
  })

  it('shows the last push time and conflict count from the source, in the pad-head', () => {
    const src = read(path)
    const head = src.slice(src.indexOf('pad-head'), src.indexOf('{pager}'))
    expect(head).toMatch(/last push/)
    expect(head).toMatch(/conflicts?/)
  })

  it('pluralises the message count instead of always saying "messages"', () => {
    // A one-message chat used to read "1 messages"; the chats page already
    // pluralises this way, this page now matches it.
    const src = read(path)
    const head = src.slice(src.indexOf('pad-head'), src.indexOf('{pager}'))
    expect(head).toContain("page.chat.messageCount === 1 ? 'message' : 'messages'")
  })

  it('renders the conflict count as a compact marker, not trailing prose, and only when there is one', () => {
    const src = read(path)
    expect(src, 'imports AlertIcon').toMatch(/import\s*\{\s*AlertIcon\s*\}\s*from\s*'@\/app\/icons'/)
    const head = src.slice(src.indexOf('pad-head'), src.indexOf('{pager}'))
    // Gated on a nonzero count: a chat with no conflicts shows no marker.
    expect(head).toContain('source.lastImportConflicts > 0')
    expect(head).toContain('className="conflict-marker"')
    // The full sentence lives in the aria-label; the visible text is just the count.
    expect(head).toContain("aria-label={`${source.lastImportConflicts} ${source.lastImportConflicts === 1 ? 'conflict' : 'conflicts'} in the last push`}")
    expect(head).toContain('<AlertIcon />')
    // Not a link yet — the History section it will point at does not exist.
    expect(head).not.toMatch(/<a\b/)
  })

  it('left-aligns the pad-head meta instead of ragging it against the right edge', () => {
    const css = read('app/globals.css')
    const headRule = css.slice(css.indexOf('.pad-head {'), css.indexOf('.pad-head h1'))
    expect(headRule, 'the .pad-head rule exists').not.toBe('')
    expect(headRule).not.toMatch(/flex-end/)
    const metaAt = css.indexOf('.pad-head-meta {')
    expect(metaAt, 'the .pad-head-meta rule exists').toBeGreaterThan(-1)
    const metaRule = css.slice(metaAt, css.indexOf('}', metaAt) + 1)
    expect(metaRule).not.toMatch(/flex-end/)
  })

  it('the conflict marker carries no border and no pointer cursor: it is not pressable yet', () => {
    const css = read('app/globals.css')
    const at = css.indexOf('.conflict-marker {')
    expect(at, 'the .conflict-marker rule exists').toBeGreaterThan(-1)
    const rule = css.slice(at, css.indexOf('}', at) + 1)
    expect(rule).not.toMatch(/border/)
    expect(rule).not.toMatch(/cursor:\s*pointer/)
    expect(rule).toMatch(/color:\s*var\(--warn\)/)
  })

  it('names the pushers from the messages alone — never gated on the source row, which a revocation removes', () => {
    // Pushers come from push_key_id on the messages themselves and outlive a
    // revoked source; the last-push time and conflict count live only on the
    // source row. If the chip is ever re-coupled to `source`, this fails.
    const src = read(path)
    const head = src.slice(src.indexOf('pad-head'), src.indexOf('{pager}'))
    const pushedByStart = head.indexOf('{page.chat.pushers.length > 0')
    expect(pushedByStart, 'the pushers-length guard exists').toBeGreaterThan(-1)
    const sourceStart = head.indexOf('{source &&', pushedByStart)
    expect(sourceStart, 'the source guard exists').toBeGreaterThan(-1)
    const pushedByBlock = head.slice(pushedByStart, sourceStart)
    expect(pushedByBlock, 'the Pushed by block exists').toContain('Pushed by')
    expect(pushedByBlock).not.toMatch(/\bsource\b/)

    const spanEnd = head.indexOf('</span>', sourceStart)
    const lastPushBlock = head.slice(sourceStart, spanEnd)
    expect(lastPushBlock, 'the last-push block exists').toContain('last push')
    expect(lastPushBlock).toContain('conflict')
  })

  it('keeps the 64px time margin free of per-message provenance', () => {
    // The time margin is sized for "09:05"; nothing pushed-related may live
    // there, one pusher or many.
    const src = read(path)
    const runTimeRegion = src.slice(src.indexOf('msg-time'), src.indexOf('msg-col'))
    expect(runTimeRegion).not.toMatch(/pushed-via/)
    expect(runTimeRegion).not.toMatch(/pushedBy/)
  })

  it('marks each sender line with who pushed it, only when more than one pusher delivered to this chat', () => {
    // Sliced to the sender-line paragraph itself, not the whole file: an
    // assertion that only looks at independent whole-file regexes would
    // still pass if the guard and the label were decoupled from one another.
    const src = read(path)
    const whoRegion = src.slice(src.indexOf('msg-who'), src.indexOf('msg-body'))
    expect(whoRegion, 'the msg-who block exists').toContain('msg-who')
    expect(whoRegion).toMatch(/pushers\.length > 1/)
    expect(whoRegion).toMatch(/&middot;\s*\{run\.messages\[0\]\.pushedBy\}/)
  })

  it('still offers no way to send anything', () => {
    const src = read(path)
    expect(src).not.toMatch(/<textarea|<form|type=["']submit["']|<input/)
  })

  it('carries no colour literal', () => {
    const src = read(path)
    expect(src).not.toMatch(/#[0-9a-f]{3,6}\b/i)
  })
})

describe('connections page', () => {
  it('renders a Sources card listing every pushed source', () => {
    const src = read('app/connections/page.tsx')
    expect(src).toMatch(/<h2>Sources<\/h2>/)
    expect(src).toMatch(/sources\.map\(/)
    expect(src).toMatch(/s\.createdBy/)
    expect(src).toMatch(/s\.pushedBy/)
    expect(src).toMatch(/s\.lastImportConflicts/)
  })

  it('deleting a source sits behind a confirm, posting deleteSourceAction with a hidden sourceId', () => {
    const src = read('app/connections/page.tsx')
    const block = src.slice(src.indexOf('sources.map('))
    expect(block, 'the Sources block exists').toContain('sources.map(')
    expect(block).toMatch(/<ConfirmDialog\b/)
    expect(block).toMatch(/action=\{deleteSourceAction\}/)
    expect(block).toMatch(/name="sourceId"/)
  })

  it('deleteSourceAction re-runs the session guard', () => {
    const src = read('app/connections/actions.ts')
    const start = src.indexOf('export async function deleteSourceAction')
    expect(start).toBeGreaterThan(-1)
    const next = src.indexOf('export async function ', start + 1)
    const body = next === -1 ? src.slice(start) : src.slice(start, next)
    expect(body).toMatch(/^export async function deleteSourceAction[\s\S]*?\{\s*\n\s*await requireSession\(\)/)
  })
})

describe('settings page', () => {
  it('a push-capable key offers revoke-and-purge behind a confirm', () => {
    const src = read('app/settings/page.tsx')
    const block = src.slice(src.indexOf('keys.map('))
    expect(block, 'the keys table body exists').toContain('keys.map(')
    expect(block).toMatch(/k\.canPush/)
    expect(block).toMatch(/<ConfirmDialog\b/)
    expect(block).toMatch(/action=\{revokeAndPurgeKeyAction\}/)
  })

  it('revokeAndPurgeKeyAction re-runs the session guard', () => {
    const src = read('app/settings/actions.ts')
    const start = src.indexOf('export async function revokeAndPurgeKeyAction')
    expect(start).toBeGreaterThan(-1)
    const next = src.indexOf('export async function ', start + 1)
    const body = next === -1 ? src.slice(start) : src.slice(start, next)
    expect(body).toMatch(/^export async function revokeAndPurgeKeyAction[\s\S]*?\{\s*\n\s*(?:const session = )?await requireSession\(\)/)
  })
})
