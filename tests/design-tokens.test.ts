import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// DESIGN.md at the repo root is the design system. These tests keep the
// promises it makes that a reviewer's eye would miss: contrast on every
// palette, tokens-only theme blocks, and fonts that never leave the machine.

const css = readFileSync('app/globals.css', 'utf8')

function block(selector: string): string {
  const at = css.indexOf(selector)
  expect(at, `globals.css has a ${selector} block`).toBeGreaterThan(-1)
  const open = css.indexOf('{', at)
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i)
  }
  throw new Error(`unbalanced braces after ${selector}`)
}

function tokens(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/--([a-z-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)) out[m[1]] = m[2].toUpperCase()
  return out
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const LIGHT = ':root {'
const DARK_MEDIA = ':root:not([data-theme="light"])'
const DARK_FORCED = ':root[data-theme="dark"]'

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full)
    return /\.(tsx?|css)$/.test(entry) ? [full] : []
  })
}

describe('the palette', () => {
  const palettes = { light: tokens(block(LIGHT)), dark: tokens(block(DARK_FORCED)) }

  it.each(Object.entries(palettes))('%s: muted text holds 4.5:1 on paper and on card', (_name, t) => {
    expect(contrast(t.muted, t.paper)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(t.muted, t.card)).toBeGreaterThanOrEqual(4.5)
  })

  it.each(Object.entries(palettes))('%s: body and ink text hold 4.5:1 on card and well', (_name, t) => {
    for (const fg of [t.body, t.ink]) for (const bg of [t.card, t.well, t.paper]) {
      expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it.each(Object.entries(palettes))('%s: pine links hold 4.5:1 on card, and pine-ink on mint-soft', (_name, t) => {
    expect(contrast(t.pine, t.card)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(t['pine-ink'], t['mint-soft'])).toBeGreaterThanOrEqual(4.5)
  })

  it.each(Object.entries(palettes))('%s: the primary button text holds 4.5:1 on its fill', (_name, t) => {
    expect(contrast(t['btn-fg'], t['btn-bg'])).toBeGreaterThanOrEqual(4.5)
  })

  it.each(Object.entries(palettes))('%s: every status colour holds 4.5:1 on card', (_name, t) => {
    for (const k of ['ok', 'warn', 'bad']) expect(contrast(t[k], t.card), k).toBeGreaterThanOrEqual(4.5)
  })

  it('mint is the brand green the mark has always used', () => {
    expect(palettes.light.mint).toBe('#A7E1D3')
    expect(palettes.dark.mint).toBe('#A7E1D3')
  })
})

describe('theme mechanics', () => {
  it('the system-dark block and the forced-dark block carry identical tokens', () => {
    expect(tokens(block(DARK_MEDIA))).toEqual(tokens(block(DARK_FORCED)))
  })

  it('theme blocks redefine tokens only, never component rules', () => {
    for (const sel of [DARK_MEDIA, DARK_FORCED]) {
      const decls = block(sel).split(';').map(s => s.trim()).filter(Boolean)
      for (const d of decls) expect(d, `${sel}: ${d}`).toMatch(/^--/)
    }
  })

  it('no colour literal lives outside the token blocks', () => {
    let rest = css
    for (const sel of [LIGHT, DARK_MEDIA, DARK_FORCED]) rest = rest.replace(block(sel), '')
    expect(rest).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(rest).not.toMatch(/\brgba?\(/)
  })

  it('no pills', () => {
    expect(css).not.toMatch(/border-radius:\s*(999|9999)px/)
  })
})

describe('fonts', () => {
  it('are bundled at build time with next/font, so no page view fetches from Google', () => {
    expect(readFileSync('app/layout.tsx', 'utf8')).toMatch(/from 'next\/font\/google'/)
    const offenders = walk('app').filter(f => /fonts\.(googleapis|gstatic)\.com/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})

describe('DESIGN.md', () => {
  it('sits at the repo root and agrees with the stylesheet on every light token', () => {
    expect(existsSync('DESIGN.md')).toBe(true)
    const doc = readFileSync('DESIGN.md', 'utf8')
    const light = tokens(block(LIGHT))
    for (const [name, hex] of Object.entries(light)) {
      if (name.startsWith('font')) continue
      expect(doc.toUpperCase(), `DESIGN.md names ${name} ${hex}`).toContain(hex)
    }
  })
})
