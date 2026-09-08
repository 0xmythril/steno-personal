import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { UpdatesSection } from '@/app/settings/updates'

describe('upgrade setup instructions', () => {
  it('provides the Docker-only command and a refresh step before setup', () => {
    const html = renderToStaticMarkup(<UpdatesSection currentVersion="0.2.0" configured={false} />)
    expect(html).toContain('sh scripts/enable-upgrades.sh')
    expect(html).toContain('Copy setup command')
    expect(html).toContain('Refresh after setup')
    expect(html).toContain('Running on Railway?')
    expect(html).toContain('companion with Docker control')
  })
  it('shows the update check instead of installation instructions once configured', () => {
    const html = renderToStaticMarkup(<UpdatesSection currentVersion="0.2.0" configured />)
    expect(html).toContain('Check for updates')
    expect(html).not.toContain('enable-upgrades.sh')
  })
})
