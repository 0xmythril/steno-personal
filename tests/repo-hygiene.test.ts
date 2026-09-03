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
