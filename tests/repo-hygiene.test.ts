import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

// A worktree tool once symlinked node_modules to the main checkout and the
// symlink was committed (c31f398). Turbopack refuses a project whose
// node_modules points outside its root, so every other worktree and clone
// lost `next build` until the link was removed. The trailing slash in the
// old ignore rule only matched a directory, never a symlink.
describe('node_modules', () => {
  it('is ignored whether it is a directory or a symlink', () => {
    const lines = readFileSync('.gitignore', 'utf8').split('\n').map(l => l.trim())
    expect(lines).toContain('node_modules')
  })
  it('is not tracked', () => {
    expect(execSync('git ls-files node_modules', { encoding: 'utf8' }).trim()).toBe('')
  })
})

// lib/version.ts is what the usage ping reports, so a release that bumped
// package.json alone would silently attribute every ping to the old version.
describe('the shipped version', () => {
  it('lib/version.ts matches package.json', async () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    const { APP_VERSION } = await import('@/lib/version')
    expect(APP_VERSION).toBe(pkg.version)
  })
})

// The whole point of shipping the token is that an instance reports without
// anyone setting a variable. An empty or malformed default would silently
// turn every install's telemetry off and nothing else would notice.
describe('the shipped PostHog defaults', () => {
  it('point at a real project on a real ingest host', async () => {
    const { POSTHOG_DEFAULT_KEY, POSTHOG_DEFAULT_HOST } = await import('@/lib/telemetry-defaults')
    expect(POSTHOG_DEFAULT_KEY).toMatch(/^phc_[A-Za-z0-9]{20,}$/)
    expect(POSTHOG_DEFAULT_HOST).toMatch(/^https:\/\/(us|eu)\.i\.posthog\.com$/)
  })
})
