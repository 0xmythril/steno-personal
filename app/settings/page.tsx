import { getSettings } from '@/lib/services/settings'
import { AdvancedMode } from './advanced-mode'
import { cookies } from 'next/headers'
import { requireSession } from '@/lib/auth'
import { listActiveAccessKeys, messagesPushedByKey, MAX_LABEL_LENGTH, KEY_PREFIX } from '@/lib/services/access-keys'
import { listActivePasskeys } from '@/lib/services/passkeys'
import { MINTED_KEY_COOKIE, REVEALED_KEY_COOKIE, INSTRUCTIONS_KEY_COOKIE } from '@/lib/services/keys-flash'
import { Nav } from '@/app/nav'
import { CopyButton } from '@/app/copy-button'
import { ConfirmDialog } from '@/app/confirm-dialog'
import { RegisterPasskey } from '@/app/register-passkey'
import { EditableLabel } from './editable-label'
import { ConnectAgent } from './connect-agent'
import { EnrichmentSection } from './enrichment'
import { TelemetrySection } from './telemetry'
import { UpdatesSection } from './updates'
import { upgradesConfigured } from '@/lib/services/upgrades'
import { version } from '@/package.json'
import {
  mintKeyAction, dismissMintedKeyAction, revealKeyAction, hideRevealedKeyAction, revokeKeyAction,
  revokeAllKeysAction, revokeAndPurgeKeyAction, revokePasskeyAction, revokeAllPasskeysAction,
} from './actions'

type Flash = { id: string; rawKey: string } | null
function parseFlash(raw: string | undefined): Flash {
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

const fmt = (d: Date | null) => (d ? d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'never')

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession()
  const { advancedMode } = await getSettings()
  const keys = await listActiveAccessKeys()
  const passkeyRows = await listActivePasskeys()
  // Only push-capable keys need the count: it feeds the revoke-and-purge
  // confirm's body, which only that row offers.
  const pushedCounts = new Map<string, number>()
  for (const k of keys) if (advancedMode && k.canPush) pushedCounts.set(k.id, await messagesPushedByKey(k.id))
  const sp = await searchParams
  const mintError = typeof sp.mintError === 'string' ? sp.mintError : null
  const revealError = typeof sp.revealError === 'string' ? sp.revealError : null
  const instructionsError = typeof sp.instructionsError === 'string' ? sp.instructionsError : null
  const renameError = typeof sp.renameError === 'string' ? sp.renameError : null
  const renameKeyId = typeof sp.renameKeyId === 'string' ? sp.renameKeyId : null

  const jar = await cookies()
  let minted = parseFlash(jar.get(MINTED_KEY_COOKIE)?.value)
  let revealed = parseFlash(jar.get(REVEALED_KEY_COOKIE)?.value)
  let chosen = parseFlash(jar.get(INSTRUCTIONS_KEY_COOKIE)?.value)
  // A flash must never outlive its key.
  if (minted && !keys.some(k => k.id === minted!.id)) minted = null
  if (revealed && !keys.some(k => k.id === revealed!.id)) revealed = null
  if (chosen && !keys.some(k => k.id === chosen!.id)) chosen = null

  const instructionKeys = keys.filter(k => advancedMode ? (k.canRead || k.canPush) : k.canRead)
  const instructionKey = [chosen, minted].find(flash => flash && instructionKeys.some(k => k.id === flash.id)) ?? null

  return (
    <>
      <Nav label={session.label} via={session.via} current="settings" />
      <main>
        <div className="page-head"><div><p className="eyebrow">This instance</p><h1>Settings</h1></div></div>

        <AdvancedMode enabled={advancedMode} />

        <section className="card">
          <h2>Access keys</h2>
          <p className="muted">
            {advancedMode
              ? 'A key can read, push, or both. Read lets an agent search your archive and logs you into this portal. Push lets an agent store conversations here. A key with both permissions can read everything and change what other agents read. Make one per agent so you can revoke them separately.'
              : 'An access key logs you into this portal and lets an agent read and search your archive. Make one per device or agent so you can revoke them separately.'}
          </p>

          {minted && (
            <div className="banner">
              <div className="stack" style={{ gap: 8, flex: 1, minWidth: 0 }}>
                <span>
                  <strong>New key created.</strong> Copy it now; you can reveal it again later from this page.
                  {(() => {
                    const row = keys.find(k => k.id === minted!.id)
                    if (!row) return null
                    const can = row.canRead && row.canPush ? 'read and push' : row.canPush ? 'push' : 'read'
                    return ` This key can ${can}.`
                  })()}
                </span>
                <span className="token"><code>{minted.rawKey}</code> <CopyButton value={minted.rawKey} /></span>
                <form action={dismissMintedKeyAction}><button type="submit" className="small">Done</button></form>
              </div>
            </div>
          )}

          <form action={mintKeyAction} className="row">
            <label className="field">
              <span>Label</span>
              <input name="label" maxLength={MAX_LABEL_LENGTH} placeholder="e.g. Claude Code on laptop" />
              {mintError === 'label_too_long' && <p className="danger" role="alert">Label is too long (max {MAX_LABEL_LENGTH}).</p>}
              {mintError === 'no_capability' && <p className="danger" role="alert">Tick at least one of Read and Push.</p>}
            </label>
            {advancedMode ? <fieldset className="field">
              <span>What it may do</span>
              <label><input type="checkbox" name="canRead" defaultChecked /> Read: log in here and search over MCP</label>
              <label><input type="checkbox" name="canPush" /> Push: deliver conversations to /api/import</label>
            </fieldset> : <input type="hidden" name="canRead" value="on" />}
            <button type="submit" className="primary">Create key</button>
          </form>

          <div className="tbl"><div className="scroll">
            <table>
              <thead><tr><th>Label</th>{(advancedMode || keys.some(k => k.canPush)) && <th>Can</th>}<th>Key</th><th>Created</th><th>Last used</th><th></th></tr></thead>
              <tbody>
                {keys.map(k => {
                  const rowRenameError = renameKeyId === k.id ? renameError : null
                  return (
                  <tr key={k.id}>
                    <td className="name">
                      <EditableLabel
                        key={`${k.id}:${k.label}:${rowRenameError ?? ''}`}
                        keyId={k.id}
                        label={k.label}
                        maxLength={MAX_LABEL_LENGTH}
                        error={rowRenameError}
                      />
                      {k.id === session.keyId && <> <span className="chip">this session</span></>}
                    </td>
                    {(advancedMode || keys.some(key => key.canPush)) && <td className="muted">{k.canRead && k.canPush ? 'Read, push' : k.canPush ? 'Push' : 'Read'}</td>}
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
                          {revealError === k.id && <span className="danger" role="alert">Cannot decrypt: SECRET_KEY changed since this key was made.</span>}
                        </span>
                      )}
                    </td>
                    <td className="mono muted">{fmt(k.createdAt)}</td>
                    <td className="mono muted">{fmt(k.lastUsedAt)}</td>
                    <td className="end">
                      {advancedMode && k.canPush ? (
                        <ConfirmDialog
                          trigger="Revoke"
                          title={`Revoke "${k.label}"?`}
                          body={
                            <p>
                              <strong>Revoke</strong> stops this key immediately without touching anything it
                              already delivered. <strong>Revoke &amp; delete what it pushed</strong> does that, and
                              also erases the {pushedCounts.get(k.id) ?? 0} message{pushedCounts.get(k.id) === 1 ? '' : 's'} this
                              key delivered, along with any source that key fed alone.
                            </p>
                          }
                        >
                          <div className="stack">
                            <form action={revokeKeyAction}>
                              <input type="hidden" name="keyId" value={k.id} />
                              <button type="submit" className="danger">Revoke</button>
                            </form>
                            <form action={revokeAndPurgeKeyAction}>
                              <input type="hidden" name="keyId" value={k.id} />
                              <button type="submit" className="danger">Revoke &amp; delete what it pushed</button>
                            </form>
                          </div>
                        </ConfirmDialog>
                      ) : (
                        <ConfirmDialog
                          trigger="Revoke"
                          title={`Revoke "${k.label}"?`}
                          body={<p>This key stops working immediately. Any agent using it loses access.</p>}
                          confirm="Revoke"
                        >
                          <form action={revokeKeyAction}>
                            <input type="hidden" name="keyId" value={k.id} />
                          </form>
                        </ConfirmDialog>
                      )}
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div></div>

          <ConfirmDialog
            trigger="Revoke all keys and log out"
            title="Revoke all keys and log out?"
            body={
              <p>
                {keys.length === 1 ? 'Your only key stops' : `All ${keys.length} keys stop`} working at once. Every agent using
                one loses access immediately, this browser is logged out, and no key can be revealed again. Your archive is untouched.
              </p>
            }
            confirm={keys.length === 1 ? 'Yes, revoke it' : `Yes, revoke all ${keys.length} keys`}
          >
            <form action={revokeAllKeysAction} />
          </ConfirmDialog>
        </section>

        <section className="card">
          <h2>Passkeys</h2>
          <p className="muted">
            A passkey logs you into this portal with Touch ID, Windows Hello, or your phone. It cannot be used by an agent; agents use keys.
          </p>

          <RegisterPasskey />

          {passkeyRows.length > 0 && (
            <>
              <div className="tbl"><div className="scroll">
                <table>
                  <thead><tr><th>Label</th><th>Synced</th><th>Created</th><th>Last used</th><th></th></tr></thead>
                  <tbody>
                    {passkeyRows.map(p => (
                      <tr key={p.id}>
                        <td className="name">{p.label}{p.id === session.passkeyId && <> <span className="chip">this session</span></>}</td>
                        <td className="muted">{p.backedUp ? 'yes' : 'this device only'}</td>
                        <td className="mono muted">{fmt(p.createdAt)}</td>
                        <td className="mono muted">{fmt(p.lastUsedAt)}</td>
                        <td className="end">
                          <ConfirmDialog
                            trigger="Remove"
                            title={`Remove "${p.label}"?`}
                            body={
                              <p>
                                This passkey stops working. If this session signed in with it you are logged out,
                                and you will need an access key to get back in.
                              </p>
                            }
                            confirm="Remove"
                          >
                            <form action={revokePasskeyAction}>
                              <input type="hidden" name="passkeyId" value={p.id} />
                            </form>
                          </ConfirmDialog>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div></div>

              <ConfirmDialog
                trigger="Remove all passkeys"
                title="Remove all passkeys?"
                body={
                  <p>
                    {passkeyRows.length === 1 ? 'Your only passkey stops' : `All ${passkeyRows.length} passkeys stop`} working. If
                    this session signed in with one you are logged out, and you will need an access key to get back in.
                  </p>
                }
                confirm={passkeyRows.length === 1 ? 'Yes, remove it' : `Yes, remove all ${passkeyRows.length} passkeys`}
              >
                <form action={revokeAllPasskeysAction} />
              </ConfirmDialog>
            </>
          )}
        </section>

        {/* Not a .two-up. Both of these hold content that a half-width column
            truncates: an MCP URL and JSON snippets on one side, and on the other
            a model name plus the provider that receives your files. */}
        <ConnectAgent
          rawKey={instructionKey?.rawKey ?? null}
          selectedId={instructionKey?.id ?? null}
          advancedMode={advancedMode}
          keys={instructionKeys.map(k => ({ id: k.id, label: k.label, canRead: k.canRead, canPush: k.canPush }))}
          error={instructionsError}
        />

        <EnrichmentSection />

        <TelemetrySection />
        <UpdatesSection currentVersion={version} configured={upgradesConfigured()} />
      </main>
    </>
  )
}
