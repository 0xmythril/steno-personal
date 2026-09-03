import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

describe('connections page', () => {
  it('every server action re-runs the session guard', () => {
    // A layout protects rendering, not the actions its pages post to — those
    // are directly callable. Checked per function, never as a total: a count
    // passes when a guardless new action is offset by a redundant guard.
    const src = readFileSync('app/connections/actions.ts', 'utf8')
    const blocks = src.split(/export async function /).slice(1)
    expect(blocks.length).toBeGreaterThan(0)
    const unguarded = blocks
      .map(b => ({ name: b.slice(0, b.indexOf('(')), body: b.slice(0, b.indexOf('\n}')) }))
      .filter(b => !b.body.includes('requireSession()'))
      .map(b => b.name)
    expect(unguarded).toEqual([])
  })

  it('the connect panel never copies the QR token into client state', () => {
    // The panel learns a fresh code was published from a TIMESTAMP and asks
    // the server to re-render. The token itself never enters the browser's
    // JavaScript state, only the finished image.
    const src = readFileSync('app/connections/connect-panel.tsx', 'utf8')
    expect(src).not.toMatch(/\.qr\b(?!At)/)
    expect(src).toMatch(/qrAt/)
  })

  it('the consent copy makes every promise the system actually keeps', () => {
    const src = readFileSync('app/connections/consent.tsx', 'utf8')
    for (const claim of [/read-only/i, /never marks/i, /never shows/i, /never sends/i, /Devices/, /Disconnect/, /train/i]) {
      expect(src, `consent copy must cover ${claim}`).toMatch(claim)
    }
    // It names the device entry the reader will see in Telegram, by reading
    // the same constant the worker passes to mtcute.
    expect(src).toContain('DEVICE_MODEL')
  })
})
