import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// The enrichment UI is server-rendered from getSettings, so its contract is
// structural: the key is never re-rendered, the section is wired to the
// catalog, and the new actions obey both M0 invariants for this file.
describe('settings enrichment section', () => {
  const section = readFileSync('app/settings/enrichment.tsx', 'utf8')
  const actions = readFileSync('app/settings/actions.ts', 'utf8')
  const page = readFileSync('app/settings/page.tsx', 'utf8')

  it('is rendered by the settings page', () => {
    expect(page).toMatch(/EnrichmentSection/)
  })

  it('shows a saved key as a state, never as a value', () => {
    expect(section).toMatch(/key saved/)
    expect(section).toMatch(/hasOpenrouterKey/)
    // getSettings has no key value to render, and nothing here may reach for one.
    expect(section).not.toMatch(/getOpenrouterKey/)
    expect(section).not.toMatch(/openrouterKeyCiphertext/)
    expect(section).not.toMatch(/defaultValue=\{s\.openrouterKey/)
  })

  it('offers both toggles and both catalog-driven pickers', () => {
    expect(section).toMatch(/name="analyzeImages"/)
    expect(section).toMatch(/name="analyzeAudio"/)
    expect(section).toMatch(/name="visionModel"/)
    expect(section).toMatch(/name="transcriptionModel"/)
    expect(section).toMatch(/VISION_CATALOG\.map/)
    expect(section).toMatch(/TRANSCRIPTION_CATALOG\.map/)
    // The provider is the data-destination disclosure; it must be on screen.
    expect(section).toMatch(/e\.provider/)
  })

  it('adds three guarded actions and no new flash cookie', () => {
    for (const name of ['saveOpenrouterKeyAction', 'clearOpenrouterKeyAction', 'updateEnrichmentAction']) {
      const block = actions.split(`export async function ${name}`)[1]
      expect(block, name).toBeDefined()
      expect(block.slice(0, block.indexOf('\n}'))).toMatch(/requireSession\(\)/)
    }
    // M0's settings-structure test asserts exactly two jar.set calls in this
    // file; the enrichment actions must not add a third.
    expect((actions.match(/jar\.set\(/g) ?? []).length).toBe(2)
  })
})
