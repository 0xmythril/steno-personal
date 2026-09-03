import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const actions = () => readFileSync('app/people/actions.ts', 'utf8')

describe('people pages', () => {
  it('every server action re-runs the session guard', () => {
    // A layout protects rendering, not the actions its pages post to — those
    // are directly callable. Checked per function, never as a total: a count
    // passes when a guardless new action is offset by a redundant guard.
    const src = actions()
    const blocks = src.split(/export async function /).slice(1)
    expect(blocks.length).toBeGreaterThan(0)
    const unguarded = blocks
      .map(b => ({ name: b.slice(0, b.indexOf('(')), body: b.slice(0, b.indexOf('\n}')) }))
      .filter(b => !b.body.includes('requireSession()'))
      .map(b => b.name)
    expect(unguarded).toEqual([])
  })

  it('never puts a name or a channel identity in a URL', () => {
    // A person's name is the thing this archive exists to keep local, and a
    // WhatsApp identity IS a phone number. Every proxy and access log between
    // here and the browser records a URL, so a redirect may carry only this
    // instance's own uuid — which names nobody — and a short error code.
    const src = actions()
    const args = [...src.matchAll(/redirect\(\s*(['"`])([\s\S]*?)\1\s*\)/g)].map(m => m[2])
    // Every redirect in the file must be one of those literals, or the sweep
    // below would silently skip the one that is not.
    expect(args.length).toBe((src.match(/\bredirect\(/g) ?? []).length)
    expect(args.length).toBeGreaterThan(0)
    for (const arg of args) {
      expect(arg, `redirect(${arg}): only /people, /people/<id> and ?error=<code>`)
        .toMatch(/^\/people(\/\$\{[A-Za-z][\w.]*\})?(\?error=[a-z_]+)?$/)
      expect(arg, `redirect(${arg}) names somebody`).not.toMatch(/name|phone|display/i)
    }
    // …and nothing hand-builds a query string out of one either.
    expect(src).not.toMatch(/redirect\([^)]*\b(name|phone|displayName|externalId)\b/)
  })

  it('the transcript page still offers no way to send anything', () => {
    // Person labels arrived on this page with the address book; linking did
    // not. Read-only stays a property of the page, not a promise in its copy.
    const src = readFileSync('app/chats/[id]/page.tsx', 'utf8')
    expect(src).not.toMatch(/<textarea|<form|type=["']submit["']|<input/)
    // It reaches the address book with a link, which is the whole allowance.
    expect(src).toMatch(/href="\/people"/)
  })

  it('shows the channel name muted when the address book disagrees', () => {
    const src = readFileSync('app/chats/[id]/page.tsx', 'utf8')
    expect(src).toMatch(/run\.rawLabel && <span className="muted">/)
    expect(src).toMatch(/run\.senderLabel/)
  })

  it('is reachable from the nav', () => {
    const src = readFileSync('app/nav.tsx', 'utf8')
    expect(src).toMatch(/href="\/people"/)
  })
})
