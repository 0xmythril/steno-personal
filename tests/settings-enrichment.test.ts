import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// The enrichment UI is server-rendered from getSettings, so its contract is
// structural: the key is never re-rendered, the section is wired to the
// catalog, and the new actions obey both M0 invariants for this file.
describe('settings enrichment section', () => {
  const section = readFileSync('app/settings/enrichment.tsx', 'utf8')
  const modelField = readFileSync('app/settings/model-field.tsx', 'utf8')
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
    // The pickers moved into <ModelField>; the catalogs still drive them, and
    // the name= lives there now, so both files are the contract.
    expect(section).toMatch(/name="visionModel"/)
    expect(section).toMatch(/name="transcriptionModel"/)
    expect(section).toMatch(/options=\{VISION_CATALOG\}/)
    expect(section).toMatch(/options=\{TRANSCRIPTION_CATALOG\}/)
    expect(modelField).toMatch(/options\.map/)
  })

  // Was asserted on the option text (`{e.label} — {e.provider}`). A closed
  // select truncates its own tail, so at 375px the provider — the half that
  // matters — was the half that vanished. It now has its own line, which no
  // width can cut off, and the option carries the model name alone.
  it('names the provider that receives the files, outside the option text', () => {
    expect(modelField).toMatch(/\{chosen\.provider\}/)
    expect(modelField).toMatch(/className="help"/)
    expect(modelField).not.toMatch(/<option[^>]*>[^<]*\{o\.provider\}/)
  })

  it('adds three guarded actions and no new flash cookie', () => {
    for (const name of ['saveOpenrouterKeyAction', 'clearOpenrouterKeyAction', 'updateEnrichmentAction']) {
      const block = actions.split(`export async function ${name}`)[1]
      expect(block, name).toBeDefined()
      expect(block.slice(0, block.indexOf('\n}'))).toMatch(/requireSession\(\)/)
    }
    // The enrichment actions must not set any flash cookie of their own: the
    // OpenRouter key is write-only from the portal's side. Checked per
    // action body rather than by a file-wide count, which would break every
    // time an unrelated flash (minted, revealed, instructions) is added.
    for (const name of ['saveOpenrouterKeyAction', 'clearOpenrouterKeyAction', 'updateEnrichmentAction']) {
      const block = actions.split(`export async function ${name}`)[1]
      expect(block.slice(0, block.indexOf('\n}')), name).not.toMatch(/jar\.set\(/)
    }
  })
})
