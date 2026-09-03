import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

describe('the transcript page', () => {
  it('offers no way to send anything', () => {
    // Read-only is a property of the page, not a promise in its copy: there is
    // no reply box because the connection physically cannot send. The absence
    // is the feature, so it is what the test checks.
    const src = readFileSync('app/chats/[id]/page.tsx', 'utf8')
    expect(src).not.toMatch(/<textarea|<form|type=["']submit["']|<input/)
  })

  it('pages with links, not with a submitted form', () => {
    const src = readFileSync('app/chats/[id]/page.tsx', 'utf8')
    expect(src).toMatch(/cursor=/)
    expect(src).toMatch(/<Link/)
  })

  it('lets the reader jump to the newest messages and back to the top, with links', () => {
    // Anchors, not scripts: a #bottom target after the transcript and a #top
    // target on the heading, both reachable from the pager at either end.
    const src = readFileSync('app/chats/[id]/page.tsx', 'utf8')
    expect(src).toMatch(/<h1 id="top"/)
    expect(src).toMatch(/id="bottom"/)
    expect(src).toMatch(/href=\{latestHref\}/)
    expect(src).toMatch(/href="#top"/)
    // From an older page "latest" is a navigation to the first page's foot.
    expect(src).toMatch(/cursor \? `\/chats\/\$\{page\.chat\.id\}#bottom` : '#bottom'/)
  })
})
