import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { EVENTS } from '@/lib/services/telemetry'

// Experimental features: one switch per unfinished feature, at the very
// bottom of Settings and separate from Advanced mode, gating everything the
// feature adds. Today that is WeChat through Stele.
describe('the Experimental features card', () => {
  const page = readFileSync('app/settings/page.tsx', 'utf8')
  const card = readFileSync('app/settings/experimental.tsx', 'utf8')

  it('is the last card on Settings, after updates and apart from Advanced mode', () => {
    const experimental = page.indexOf('<ExperimentalFeatures')
    expect(experimental).toBeGreaterThan(page.indexOf('<UpdatesSection'))
    expect(experimental).toBeGreaterThan(page.indexOf('<TelemetrySection'))
    expect(page.slice(experimental)).not.toMatch(/<(Enrichment|Telemetry|Updates)Section|<AdvancedMode/)
    expect(card).not.toContain('AdvancedMode')
  })

  it('confirms before turning WeChat on, in the words the card and the guide use', () => {
    expect(card).toContain('Turn on WeChat through Stele?')
    expect(card).toContain('WeChat is not built in')
    expect(card).toContain('Only link your own')
    expect(card).toContain('Linux amd64 Docker only')
    expect(card).toMatch(/if \(wechat\) save\(false\)/)
  })

  it('reports the switch as a usage event that names only the feature and the direction', () => {
    expect(EVENTS).toContain('experimental_toggled')
    const actions = readFileSync('app/settings/actions.ts', 'utf8')
    expect(actions).toContain("track('experimental_toggled', { feature, enabled })")
    expect(readFileSync('PRIVACY.md', 'utf8')).toContain('`experimental_toggled`')
  })
})

describe('the WeChat switch gates everything WeChat adds', () => {
  it('the Connections card', () => {
    expect(readFileSync('app/connections/page.tsx', 'utf8')).toContain('{experimentalWechat && <WechatConnection />}')
  })
  it('both routes, before any contact with Stele', () => {
    for (const file of ['app/api/stele/wechat/status/route.ts', 'app/api/stele/wechat/login/route.ts']) {
      const src = readFileSync(file, 'utf8')
      const gate = src.indexOf('experimentalWechat')
      expect(gate, file).toBeGreaterThan(0)
      expect(gate, `${file}: gate before the first Stele client`).toBeLessThan(src.indexOf('new SteleClient()'))
    }
  })
  it('the companion action and the worker', () => {
    expect(readFileSync('app/connections/actions.ts', 'utf8')).toContain('Turn on WeChat under Experimental features')
    const manager = readFileSync('lib/channels/session-manager.ts', 'utf8')
    expect(manager).toContain('await this.experimentalOnly(await activeConnections())')
  })
})
