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
    expect(editableLabel).toMatch(/<button ref=\{pencilRef\} type="button" className="icon-btn"/)
    expect(editableLabel).toMatch(/aria-label=\{`Rename \$\{label\}`\}/)
    expect(editableLabel).not.toMatch(/:hover/)
    // The component itself carries no hover rule, but a `tr:hover .icon-btn`
    // or `.icon-btn:hover` added to the stylesheet would slip past the check
    // above and reintroduce a hover-only affordance. Every selector line that
    // names .icon-btn must be free of :hover too.
    const css = readFileSync('app/globals.css', 'utf8')
    const iconBtnSelectors = css.split('\n')
      .filter(line => line.includes('.icon-btn') && line.includes('{'))
      .map(line => line.slice(0, line.indexOf('{')))
    expect(iconBtnSelectors.length).toBeGreaterThan(0)
    for (const selector of iconBtnSelectors) expect(selector).not.toMatch(/:hover/)
  })
  // Review round 2 (2026-09-07): the focused element unmounts on both Cancel
  // and Escape, so without this a keyboard user landed on <body> and their
  // next Tab restarted at the top of the document.
  it('cancelling the edit — by the Cancel button or by Escape — returns focus to the pencil', () => {
    const editableLabel = readFileSync('app/settings/editable-label.tsx', 'utf8')
    expect(editableLabel).toMatch(/useRef<HTMLButtonElement>/)
    expect(editableLabel).toMatch(/ref=\{pencilRef\}/)
    // Exactly one focus call: both Escape and Cancel route through the same
    // `cancel` function rather than duplicating the focus-return logic.
    const focusCalls = editableLabel.match(/pencilRef\.current\?\.focus\(\)/g) ?? []
    expect(focusCalls.length).toBe(1)
    expect(editableLabel).toMatch(/if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); cancel\(\) \}/)
    expect(editableLabel).toMatch(/onClick=\{cancel\}/)
  })
  // A no-op save (open the pencil, submit the same text back) changes
  // neither the label nor the error, so the row's key is stable and the
  // component never remounts to close itself. onSubmit must close the
  // editing state directly, without calling preventDefault — the submit
  // still has to reach renameKeyAction.
  it('submitting the rename form closes the editing state without swallowing the submit', () => {
    const editableLabel = readFileSync('app/settings/editable-label.tsx', 'utf8')
    expect(editableLabel).toMatch(/onSubmit=\{onSubmit\}/)
    const start = editableLabel.indexOf('const onSubmit = ()')
    expect(start).toBeGreaterThan(-1)
    const end = editableLabel.indexOf('\n  }', start)
    const body = editableLabel.slice(start, end)
    expect(body).toMatch(/setEditing\(false\)/)
    expect(body).not.toMatch(/preventDefault/)
  })
})
