import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// The image has to build on every host the docs promise: Docker at home and
// Railway. Railway's builder rejects a Dockerfile that declares a VOLUME
// ("docker VOLUME ... is not supported, use Railway Volumes"), and the
// declaration buys nothing elsewhere: compose and the Railway template both
// mount /data explicitly, and the app creates DATA_DIR itself at boot.
describe('Dockerfile', () => {
  const lines = readFileSync('Dockerfile', 'utf8').split('\n')
  const instructions = lines.map(l => l.trim()).filter(l => l && !l.startsWith('#'))

  it('declares no VOLUME — Railway refuses to build one', () => {
    expect(instructions.filter(l => /^VOLUME\b/i.test(l))).toEqual([])
  })

  it('still exposes the portal port and starts through the supervisor', () => {
    expect(instructions).toContain('EXPOSE 3000')
    expect(instructions.some(l => /^CMD\b.*scripts\/start\.mjs/.test(l))).toBe(true)
  })
})
