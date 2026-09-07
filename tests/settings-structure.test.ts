import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

describe('settings keys page', () => {
  it('never puts a raw key in a URL', () => {
    const actions = readFileSync('app/settings/actions.ts', 'utf8')
    // Raw keys travel only through the httpOnly flash cookies.
    expect(actions).not.toMatch(/redirect\([^)]*rawKey/)
    expect(actions).toMatch(/MINTED_KEY_COOKIE/)
    expect(actions).toMatch(/REVEALED_KEY_COOKIE/)
  })
  it('flash cookies are httpOnly and short-lived', () => {
    const actions = readFileSync('app/settings/actions.ts', 'utf8')
    const sets = actions.match(/jar\.set\([\s\S]*?\)\n/g) ?? []
    expect(sets.length).toBe(3)
    for (const s of sets) {
      expect(s).toMatch(/httpOnly:\s*true/)
      expect(s).toMatch(/maxAge:\s*(2|5) \* 60/)
    }
  })
  it('revoking every key clears the flashes before the session ends', () => {
    const actions = readFileSync('app/settings/actions.ts', 'utf8')
    const start = actions.indexOf('export async function revokeAllKeysAction')
    expect(start).toBeGreaterThan(-1)
    const next = actions.indexOf('export async function ', start + 1)
    const body = next === -1 ? actions.slice(start) : actions.slice(start, next)
    expect(body).toMatch(/MINTED_KEY_COOKIE/)
    expect(body).toMatch(/REVEALED_KEY_COOKIE/)
    expect(body).toMatch(/INSTRUCTIONS_KEY_COOKIE/)
    // A raw key must not outlive the logout that revoked it.
    expect(body.indexOf('jar.delete')).toBeLessThan(body.indexOf('endSession()'))
  })
  it('reads the request scheme from lib/auth, not a second copy', () => {
    const actions = readFileSync('app/settings/actions.ts', 'utf8')
    expect(actions).not.toMatch(/x-forwarded-proto/)
    expect(actions).toMatch(/isHttps\(\)/)
  })
  it('offers the two key capabilities and passes the choice through, defaulting to read', () => {
    const page = readFileSync('app/settings/page.tsx', 'utf8')
    const actions = readFileSync('app/settings/actions.ts', 'utf8')
    expect(page).toMatch(/name="canRead" defaultChecked/)
    expect(page).toMatch(/name="canPush"/)
    expect(page).toMatch(/<th>Can<\/th>/)
    expect(actions).toMatch(/formData\.get\('canRead'\) === 'on'/)
    expect(actions).toMatch(/mintAccessKey\(label, caps\)/)
  })
  it('offers every readable or pushable key to the connect-an-agent snippets, each carrying its own canRead and canPush', () => {
    // A push-only key used to be left off this list entirely; now it needs to
    // be, so its own push snippet can show — ConnectAgent decides per key,
    // per snippet, using the canRead and canPush this passes through.
    const page = readFileSync('app/settings/page.tsx', 'utf8')
    expect(page).toMatch(/keys=\{keys\.filter\(k => k\.canRead \|\| k\.canPush\)\.map\(k => \(\{ id: k\.id, label: k\.label, canRead: k\.canRead, canPush: k\.canPush \}\)\)\}/)
  })
  it('renaming a key is guarded and posts through renameKeyAction', () => {
    const actions = readFileSync('app/settings/actions.ts', 'utf8')
    const start = actions.indexOf('export async function renameKeyAction')
    expect(start).toBeGreaterThan(-1)
    const next = actions.indexOf('export async function ', start + 1)
    const body = next === -1 ? actions.slice(start) : actions.slice(start, next)
    expect(body).toMatch(/requireSession\(\)/)
    expect(body).toMatch(/renameAccessKey\(/)
    // The rename form itself lives behind the pencil, in EditableLabel, not
    // inline in the page — see the pencil-affordance test below.
    const editableLabel = readFileSync('app/settings/editable-label.tsx', 'utf8')
    expect(editableLabel).toMatch(/action=\{renameKeyAction\}/)
  })
  it('the rename input is bounded by MAX_LABEL_LENGTH', () => {
    // EditableLabel is a client component; it cannot import MAX_LABEL_LENGTH
    // directly, because lib/services/access-keys.ts pulls in the SQLite
    // client at module scope and that fails the browser build. The constant
    // instead flows in as the `maxLength` prop from page.tsx.
    const page = readFileSync('app/settings/page.tsx', 'utf8')
    const start = page.indexOf('<EditableLabel')
    expect(start).toBeGreaterThan(-1)
    const tagEnd = page.indexOf('/>', start)
    expect(page.slice(start, tagEnd)).toMatch(/maxLength=\{MAX_LABEL_LENGTH\}/)

    const editableLabel = readFileSync('app/settings/editable-label.tsx', 'utf8')
    expect(editableLabel).not.toMatch(/from '@\/lib\/services\/access-keys'/)
    const formStart = editableLabel.indexOf('action={renameKeyAction}')
    expect(formStart).toBeGreaterThan(-1)
    const formEnd = editableLabel.indexOf('</form>', formStart)
    const form = editableLabel.slice(formStart, formEnd)
    expect(form).toMatch(/name="label"/)
    expect(form).toMatch(/maxLength=\{maxLength\}/)
  })
  // A pencil replaced the always-open rename box (owner review, 2026-09-07):
  // five stacked "Label" inputs in a dense table read as five open boxes
  // before this. The label cell now renders EditableLabel, which is the only
  // place the rename form itself is allowed to live.
  it('the Label cell renders EditableLabel, not an inline rename form', () => {
    const page = readFileSync('app/settings/page.tsx', 'utf8')
    expect(page).toMatch(/<EditableLabel/)
    // The old always-open form posted a bare `name="label" defaultValue={k.label}`
    // straight in the page; that pattern must now live only in the component.
    expect(page).not.toMatch(/name="label" defaultValue=\{k\.label\}/)
  })
  it('the pencil is a real button with an accessible name, not a hover reveal', () => {
    const editableLabel = readFileSync('app/settings/editable-label.tsx', 'utf8')
    expect(editableLabel).toMatch(/<button type="button" className="icon-btn"/)
    expect(editableLabel).toMatch(/aria-label=\{`Rename \$\{label\}`\}/)
    expect(editableLabel).not.toMatch(/:hover/)
  })
})
