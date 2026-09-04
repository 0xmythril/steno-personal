import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// The pages that stand in front of a session. Their shape is the promise:
// a QR only behind the right gate, a raw key only in an httpOnly flash, the
// WhatsApp sentences wherever a WhatsApp QR can appear, and no reset anywhere
// the network can reach.
describe('setup page', () => {
  const page = readFileSync('app/setup/page.tsx', 'utf8')
  it('closes itself once a key exists and polls the fresh-only route', () => {
    expect(page).toMatch(/isFreshInstance\(\)/)
    expect(page).toContain("redirect('/login')")
    expect(page).toContain('/api/setup/connections/')
  })
  it('shows the full consent copy, WhatsApp sentences included, before a QR', () => {
    expect(page).toContain('<WhatsAppConsent />')
    expect(page).toContain('<Consent channel={channel} />')
  })
  // Pairing binds the instance to the browser that started it (an httpOnly
  // cookie, like recovery). The finish card, the QR, and the poll are shown to
  // that browser and nobody else, so the window between "paired" and "key
  // minted" cannot be claimed by another visitor.
  it('shows the pairing and the finish step only to the browser that started them', () => {
    expect(page).toContain('currentSetupAttempt()')
  })
  it('the setup status route is gated on freshness, archive rows, and the setup cookie', () => {
    const route = readFileSync('app/api/setup/connections/[id]/route.ts', 'utf8')
    expect(route).toMatch(/isFreshInstance\(\)/)
    expect(route).toContain("purpose !== 'archive'")
    expect(route).toContain('currentSetupAttempt()')
  })
})

describe('welcome page', () => {
  it('reads the key from the flash, ties it to the session, and never redirects with it', () => {
    const page = readFileSync('app/welcome/page.tsx', 'utf8')
    expect(page).toContain('FIRST_KEY_COOKIE')
    expect(page).toContain('flash.id !== session.keyId')
    expect(page).not.toMatch(/redirect\([^)]*rawKey/)
    const actions = readFileSync('app/welcome/actions.ts', 'utf8')
    expect(actions).not.toMatch(/rawKey/)
  })
  it('gates Continue on the key having been copied or written down', () => {
    const gate = readFileSync('app/welcome/save-key-gate.tsx', 'utf8')
    // Copying alone does not open the gate; the tick is the confirmation.
    expect(gate).toMatch(/disabled=\{!written\}/)
    expect(gate).not.toMatch(/disabled=\{!copied/)
    expect(gate).toContain('clipboard.writeText(rawKey)')
  })
  it('the first-key flash is httpOnly, path-scoped, and minutes long', () => {
    const auth = readFileSync('lib/auth.ts', 'utf8')
    const set = auth.slice(auth.indexOf('export async function setFirstKeyFlash'))
    expect(set).toMatch(/httpOnly:\s*true/)
    expect(set).toMatch(/path:\s*'\/welcome'/)
    expect(set).toMatch(/maxAge:\s*5 \* 60/)
  })
})

describe('recovery page', () => {
  const page = readFileSync('app/login/recover/page.tsx', 'utf8')
  it('polls the cookie-scoped status route and never puts the attempt id in a URL', () => {
    expect(page).toContain('statusUrl="/api/recovery/status"')
    expect(page).not.toMatch(/\/api\/recovery\/\$\{/)
    const route = readFileSync('app/api/recovery/status/route.ts', 'utf8')
    expect(route).toContain('currentRecoveryAttempt()')
    expect(route).not.toMatch(/params/)
  })
  it('shows the WhatsApp sentences before a WhatsApp QR, and points a mismatch at the host procedure', () => {
    expect(page).toContain('<WhatsAppRisk />')
    expect(page).toContain('self-hosting.md#lost-access')
    expect(page).toMatch(/need one of your access keys/)
  })
  it('the recovery cookie is httpOnly and the attempt id never rides a URL', () => {
    const auth = readFileSync('lib/auth.ts', 'utf8')
    const set = auth.slice(auth.indexOf('export async function setRecoveryCookie'), auth.indexOf('export async function clearRecoveryCookie'))
    expect(set).toMatch(/httpOnly:\s*true/)
    const actions = readFileSync('app/login/recover/actions.ts', 'utf8')
    expect(actions).not.toMatch(/redirect\([^)]*(id|rawKey)\b/)
  })
})

describe('login page', () => {
  it('sends a fresh instance to setup and offers recovery, not the container log', () => {
    const page = readFileSync('app/login/page.tsx', 'utf8')
    expect(page).toContain("redirect('/setup')")
    expect(page).toContain('/login/recover')
    expect(page).not.toMatch(/container log/i)
  })
})

describe('no reset from the network', () => {
  it('no route, page or action wipes the data directory; only boot does', () => {
    const offenders = ['app/setup/actions.ts', 'app/login/recover/actions.ts', 'app/settings/actions.ts', 'app/connections/actions.ts']
      .filter(f => /resetDataDir|STENO_RESET|rmSync\(env\.DATA_DIR/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
    expect(readFileSync('scripts/boot.ts', 'utf8')).toContain('resetDataDir(')
  })
  it('the log prints a key only on request', () => {
    const boot = readFileSync('scripts/boot.ts', 'utf8')
    expect(boot).not.toMatch(/ensureBootstrapKey|bootstrap/)
    expect(boot).toContain('STENO_MINT_KEY')
  })
})
