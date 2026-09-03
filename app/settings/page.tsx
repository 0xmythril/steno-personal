import { cookies } from 'next/headers'
import { requireSession } from '@/lib/auth'
import { listActiveAccessKeys, MAX_LABEL_LENGTH, KEY_PREFIX } from '@/lib/services/access-keys'
import { MINTED_KEY_COOKIE, REVEALED_KEY_COOKIE, INSTRUCTIONS_KEY_COOKIE } from '@/lib/services/keys-flash'
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
  const instructionsError = typeof sp.instructionsError === 'string' ? sp.instructionsError : null

  const jar = await cookies()
  let minted = parseFlash(jar.get(MINTED_KEY_COOKIE)?.value)
  let revealed = parseFlash(jar.get(REVEALED_KEY_COOKIE)?.value)
  let chosen = parseFlash(jar.get(INSTRUCTIONS_KEY_COOKIE)?.value)
  // A flash must never outlive its key.
  if (minted && !keys.some(k => k.id === minted!.id)) minted = null
  if (revealed && !keys.some(k => k.id === revealed!.id)) revealed = null
  if (chosen && !keys.some(k => k.id === chosen!.id)) chosen = null

  return (
    <>
      <Nav label={session.label} current="settings" />
      <main>
        <div className="page-head"><div><p className="eyebrow">This instance</p><h1>Settings</h1></div></div>

        <section className="card">
          <h2>Access keys</h2>
          <p className="muted">
            A key logs you into this portal and lets an agent read your archive over MCP. Make one per device or agent so you can revoke them one at a time.
          </p>

          {minted && (
            <div className="banner">
              <div className="stack" style={{ gap: 8, flex: 1, minWidth: 0 }}>
                <span><strong>New key created.</strong> Copy it now; you can reveal it again later from this page.</span>
                <span className="token"><code>{minted.rawKey}</code> <CopyButton value={minted.rawKey} /></span>
                <form action={dismissMintedKeyAction}><button type="submit" className="small">Done</button></form>
              </div>
            </div>
          )}

          <form action={mintKeyAction} className="row">
            <label className="field">
              <span>Label</span>
              <input name="label" maxLength={MAX_LABEL_LENGTH} placeholder="e.g. Claude Code on laptop" />
            </label>
            <button type="submit" className="primary">Create key</button>
            {mintError === 'label_too_long' && <p className="danger" role="alert">Label is too long (max {MAX_LABEL_LENGTH}).</p>}
          </form>

          <div className="tbl"><div className="scroll">
            <table>
              <thead><tr><th>Label</th><th>Key</th><th>Created</th><th>Last used</th><th></th></tr></thead>
              <tbody>
                {keys.map(k => (
                  <tr key={k.id}>
                    <td className="name">{k.label}{k.id === session.keyId && <> <span className="chip">this session</span></>}</td>
                    <td>
                      {revealed?.id === k.id ? (
                        <span className="token">
                          <code>{revealed.rawKey}</code> <CopyButton value={revealed.rawKey} />
                          <form action={hideRevealedKeyAction} className="inline"><button type="submit">Hide</button></form>
                        </span>
                      ) : (
                        <span className="actions">
                          <code>{KEY_PREFIX}{k.prefix}…</code>
                          <form action={revealKeyAction} className="inline">
                            <input type="hidden" name="keyId" value={k.id} />
                            <button type="submit">Reveal</button>
                          </form>
                          {revealError === k.id && <span className="danger">Cannot decrypt: SECRET_KEY changed since this key was made.</span>}
                        </span>
                      )}
                    </td>
                    <td className="mono muted">{fmt(k.createdAt)}</td>
                    <td className="mono muted">{fmt(k.lastUsedAt)}</td>
                    <td className="end">
                      <form action={revokeKeyAction} className="inline">
                        <input type="hidden" name="keyId" value={k.id} />
                        <button type="submit" className="danger">Revoke</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div></div>

          <form action={revokeAllKeysAction} className="actions">
            <button type="submit" className="danger small">Revoke all keys and log out</button>
          </form>
        </section>

        <div className="two-up">
          <ConnectAgent
            rawKey={chosen?.rawKey ?? minted?.rawKey ?? null}
            selectedId={chosen?.id ?? minted?.id ?? null}
            keys={keys.map(k => ({ id: k.id, label: k.label }))}
            error={instructionsError}
          />

          <EnrichmentSection />
        </div>
      </main>
    </>
  )
}
