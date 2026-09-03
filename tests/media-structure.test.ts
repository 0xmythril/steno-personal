import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const ANALYZER_DIR = 'lib/services/analyzers'
const analyzerFiles = readdirSync(ANALYZER_DIR).filter(f => f.endsWith('.ts'))

describe('M4 structure', () => {
  it('the media route authenticates every request', () => {
    const src = readFileSync('app/media/[id]/route.ts', 'utf8')
    expect(src).toMatch(/withErrorBoundary\(/)
    expect(src).toMatch(/authenticateRequest\(req\)/)
    // The check must come before anything is read off disk. Matched as a call
    // (`readFileSync(`), not the bare import name, so the `node:fs` import
    // line — which necessarily precedes everything — cannot false-fail this.
    expect(src.indexOf('authenticateRequest(')).toBeLessThan(src.indexOf('readFileSync('))
  })

  it('no analyzer imports a vendor SDK', () => {
    expect(analyzerFiles.length).toBeGreaterThan(0)
    const banned = /from ['"](@anthropic-ai\/|openai|@google\/|@aws-sdk\/|@mistralai\/|groq-sdk|cohere-ai)/
    for (const f of analyzerFiles) {
      expect(readFileSync(path.join(ANALYZER_DIR, f), 'utf8'), f).not.toMatch(banned)
    }
  })

  it('analyzers reach exactly one host, through fetch', () => {
    const urls = new Set<string>()
    for (const f of analyzerFiles) {
      const src = readFileSync(path.join(ANALYZER_DIR, f), 'utf8')
      for (const m of src.matchAll(/https?:\/\/[^\s'"`]+/g)) urls.add(m[0])
      // Every call site is a template on the catalog constant, never a literal.
      for (const m of src.matchAll(/fetch\(([^,]+),/g)) {
        expect(m[1], `${f}: ${m[1]}`).toMatch(/OPENROUTER_BASE_URL/)
      }
    }
    expect([...urls]).toEqual([])
    const catalog = readFileSync('lib/services/analysis-catalog.ts', 'utf8')
    expect(catalog).toMatch(/OPENROUTER_BASE_URL = 'https:\/\/openrouter\.ai\/api\/v1'/)
  })

  it('the transcript and its attachment stay read-only', () => {
    for (const f of ['app/chats/[id]/page.tsx', 'app/chats/[id]/media-attachment.tsx']) {
      const src = readFileSync(f, 'utf8')
      expect(src, f).not.toMatch(/<form|<textarea|type=["']submit["']/)
    }
  })

  it('no service surfaces the OpenRouter key', () => {
    const settings = readFileSync('lib/services/settings.ts', 'utf8')
    // getSettings must report a boolean, never the value.
    const block = settings.split('export async function getSettings')[1].split('\n}')[0]
    expect(block).toMatch(/hasOpenrouterKey: !!/)
    expect(block).not.toMatch(/decryptSecret/)
  })
})
