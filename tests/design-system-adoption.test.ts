import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// DESIGN.md's Iteration Guide says a new screen starts from the shell and
// reuses the components. The People pages were written before that was true of
// them and drifted: bare <label>Name <input/></label>, five unwrapped tables,
// a rem margin off the 4px base. These sweep every page so the next one cannot
// drift the same way, rather than naming the two files that already did.

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full)
    return entry.endsWith('.tsx') ? [full] : []
  })
}
const views = walk('app').map(path => ({ path, src: readFileSync(path, 'utf8') }))

describe('every screen uses the design system', () => {
  it('has views to check', () => {
    expect(views.length).toBeGreaterThan(10)
  })

  it('wraps every table so it scrolls inside its own container, never the page', () => {
    // DESIGN.md, Responsive Behavior: "Tables and snippets scroll horizontally
    // inside their container. The page body never does."
    const offenders = views
      .filter(v => v.src.includes('<table'))
      .filter(v => {
        const opens = (v.src.match(/<table/g) ?? []).length
        const wrapped = (v.src.match(/className="tbl"><div className="scroll">/g) ?? []).length
        return wrapped < opens
      })
      .map(v => v.path)
    expect(offenders).toEqual([])
  })

  it('labels a control with .field, never a bare <label> wrapping an input', () => {
    // A bare <label> gets no rule at all: `.field > span, .field label` is
    // scoped inside .field, so the label renders as 15px body text inline
    // beside its own input.
    const offenders = views
      .filter(v => /<label>\s*[A-Z]/.test(v.src))
      .map(v => v.path)
    expect(offenders).toEqual([])
  })

  it('spaces siblings with gap, never an inline margin off the 4px base', () => {
    // DESIGN.md, Layout: per-element margins are avoided, and a rem value is
    // not on the 4px base at all.
    const offenders = views
      .filter(v => /style=\{\{[^}]*(margin|padding)[^}]*\}\}/.test(v.src))
      .map(v => v.path)
    expect(offenders).toEqual([])
  })

  it('uses the eyebrow as a section label, never as a badge on a row', () => {
    // .eyebrow is 11px mono uppercase — a heading kicker. As an inline badge it
    // carried its meaning in a title attribute, which no touch device shows.
    // .chip.note is the badge.
    const offenders = views
      .filter(v => /<span className="eyebrow"[^>]*title=/.test(v.src))
      .map(v => v.path)
    expect(offenders).toEqual([])
  })
})

describe('destructive actions', () => {
  // Every irreversible action opens its consequence first. Hide is absent on
  // purpose: its own copy says it can be undone from the People page.
  const IRREVERSIBLE = [
    ['app/connections/page.tsx', 'Delete this account and everything it archived'],
    ['app/settings/page.tsx', 'Revoke all keys and log out'],
    ['app/settings/page.tsx', 'Remove all passkeys'],
    ['app/people/[id]/page.tsx', 'Merge this person into another'],
  ] as const

  it.each(IRREVERSIBLE)('%s: "%s" is a confirm summary, not a bare submit', (path, label) => {
    const src = readFileSync(path, 'utf8')
    expect(src).toContain(`<summary>${label}</summary>`)
    const at = src.indexOf(`<summary>${label}</summary>`)
    const opensConfirm = src.lastIndexOf('<details className="confirm">', at)
    expect(opensConfirm, `${label} sits inside a details.confirm`).toBeGreaterThan(-1)
    expect(src.slice(opensConfirm, at)).not.toContain('</details>')
  })
})
