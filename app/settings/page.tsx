import { cookies } from 'next/headers'
import { requireSession } from '@/lib/auth'
import { listActiveAccessKeys, MAX_LABEL_LENGTH, KEY_PREFIX } from '@/lib/services/access-keys'
import { MINTED_KEY_COOKIE, REVEALED_KEY_COOKIE } from '@/lib/services/keys-flash'
import { Nav } from '@/app/nav'
import { CopyButton } from '@/app/copy-button'
import { ConnectAgent } from './connect-agent'
import { EnrichmentSection } from './enrichment'
import { mintKeyAction, dismissMintedKeyAction, revealKeyAction, hideRevealedKeyAction, revokeKeyAction, revokeAllKeysAction } from './actions'

type Flash = { id: string; rawKey: string } | null
function parseFlash(raw: string | undefined): Flash {
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

const fmt = (d: Date | null) => (d ? d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'never')

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession()
  const keys = await listActiveAccessKeys()
  const sp = await searchParams
  const mintError = typeof sp.mintError === 'string' ? sp.mintError : null
  const revealError = typeof sp.revealError === 'string' ? sp.revealError : null

  const jar = await cookies()
  let minted = parseFlash(jar.get(MINTED_KEY_COOKIE)?.value)
  let revealed = parseFlash(jar.get(REVEALED_KEY_COOKIE)?.value)
  // A flash must never outlive its key.
  if (minted && !keys.some(k => k.id === minted!.id)) minted = null
  if (revealed && !keys.some(k => k.id === revealed!.id)) revealed = null

  return (
    <main>
      <Nav label={session.label} />
      <h1>Settings</h1>

      <section className="card">
        <h2>Access keys</h2>
        <p className="muted">
          A key logs you into this portal and lets an agent read your archive over MCP. Make one per device or agent so you can revoke them one at a time.
        </p>

        {minted && (
          <div className="card">
            <strong>New key created.</strong> Copy it now; you can reveal it again later from this page.
            <p><code>{minted.rawKey}</code> <CopyButton value={minted.rawKey} /></p>
            <form action={dismissMintedKeyAction}><button type="submit">Done</button></form>
          </div>
        )}

        <form action={mintKeyAction}>
          <label>
            Label <input name="label" maxLength={MAX_LABEL_LENGTH} placeholder="e.g. Claude Code on laptop" />
          </label>{' '}
          <button type="submit">Create key</button>
          {mintError === 'label_too_long' && <p className="danger">Label is too long (max {MAX_LABEL_LENGTH}).</p>}
        </form>

        <table>
          <thead><tr><th>Label</th><th>Key</th><th>Created</th><th>Last used</th><th></th></tr></thead>
          <tbody>
            {keys.map(k => (
              <tr key={k.id}>
                <td>{k.label}{k.id === session.keyId && <span className="muted"> (this session)</span>}</td>
                <td>
                  {revealed?.id === k.id ? (
                    <>
                      <code>{revealed.rawKey}</code> <CopyButton value={revealed.rawKey} />
                      <form action={hideRevealedKeyAction} className="inline"><button type="submit">Hide</button></form>
                    </>
                  ) : (
                    <>
                      <code>{KEY_PREFIX}{k.prefix}…</code>
                      <form action={revealKeyAction} className="inline">
                        <input type="hidden" name="keyId" value={k.id} />
                        <button type="submit">Reveal</button>
                      </form>
                      {revealError === k.id && <span className="danger"> Cannot decrypt: SECRET_KEY changed since this key was made.</span>}
                    </>
                  )}
                </td>
                <td>{fmt(k.createdAt)}</td>
                <td>{fmt(k.lastUsedAt)}</td>
                <td>
                  <form action={revokeKeyAction} className="inline">
                    <input type="hidden" name="keyId" value={k.id} />
                    <button type="submit" className="danger">Revoke</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <form action={revokeAllKeysAction} style={{ marginTop: '1rem' }}>
          <button type="submit" className="danger">Revoke all keys and log out</button>
        </form>
      </section>

      <ConnectAgent rawKey={minted?.rawKey ?? null} />

      <EnrichmentSection />
    </main>
  )
}
