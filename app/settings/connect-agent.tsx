import { headers } from 'next/headers'
import { CopyButton } from '@/app/copy-button'
import { KEY_PLACEHOLDER, agentSetupPrompt, claudeCodeCommand, mcpServersJson, mcpUrlFrom } from '@/lib/mcp/client-config'
import { useKeyForInstructionsAction, clearInstructionsKeyAction } from './actions'
import { AutoSubmit } from './auto-submit'

// `rawKey` is either the key that was just minted or the one the user picked
// from the list below; both arrive through an httpOnly flash cookie the
// settings page reads. Nothing here fetches or stores a secret: the render
// after the action is the one chance to hand the user a filled-in config.
export async function ConnectAgent({ rawKey, selectedId, keys, error }: {
  rawKey: string | null
  selectedId: string | null
  keys: { id: string; label: string }[]
  error: string | null
}) {
  const h = await headers()
  const mcpUrl = mcpUrlFrom({
    host: h.get('host'),
    forwardedHost: h.get('x-forwarded-host'),
    forwardedProto: h.get('x-forwarded-proto'),
  })
  const key = rawKey ?? KEY_PLACEHOLDER
  const command = claudeCodeCommand(mcpUrl, key)
  const json = mcpServersJson(mcpUrl, key)
  const prompt = agentSetupPrompt(mcpUrl, key)
  const hint = rawKey ? 'key filled in' : 'placeholder key'

  return (
    <section className="card">
      <h2>Connect your agent</h2>
      <p className="muted">
        Your agent reads this archive over MCP with an access key as its bearer token. It can list your
        chats, read a transcript, and search — nothing else; the archive is read-only.
      </p>
      <span className="token"><code>{mcpUrl}</code> <CopyButton value={mcpUrl} label="Copy URL" /></span>
      {keys.length > 0 && (
        <form action={useKeyForInstructionsAction} className="row">
          <AutoSubmit>
            <label className="field">
              <span>Key to fill in</span>
              <select name="keyId" defaultValue={selectedId ?? ''}>
                <option value="" disabled>Choose a key</option>
                {keys.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
              </select>
            </label>
          </AutoSubmit>
          <button type="submit">Fill in</button>
          {rawKey && (
            <button type="submit" formAction={clearInstructionsKeyAction}>Clear</button>
          )}
          {error && <span className="danger">Cannot decrypt that key: SECRET_KEY changed since it was made.</span>}
        </form>
      )}
      {rawKey
        ? <p className="help">The snippets below carry the selected key. They are filled in for a few minutes only; use Clear to blank them sooner.</p>
        : <p className="help">Create a key above, or choose one, and these snippets come back with it already in place. Until then, replace <code>{KEY_PLACEHOLDER}</code> yourself.</p>}

      <details className="snippet">
        <summary><span className="sum">Let the agent set itself up</span><span className="hint">{hint}</span><CopyButton value={prompt} label="Copy instructions" /></summary>
        <div className="snippet-body">
          <p className="muted">Paste this into any agent that can edit its own MCP config. It names the server, gives it the URL and key, and tells it how to verify.</p>
          <pre>{prompt}</pre>
        </div>
      </details>

      <details className="snippet">
        <summary><span className="sum">Claude Code</span><span className="hint">{hint}</span><CopyButton value={command} label="Copy command" /></summary>
        <div className="snippet-body">
          <p className="muted">One command, run in a terminal.</p>
          <pre>{command}</pre>
        </div>
      </details>

      <details className="snippet">
        <summary><span className="sum">Claude Desktop</span><span className="hint">{hint}</span><CopyButton value={json} label="Copy config" /></summary>
        <div className="snippet-body">
          <p className="muted">Add this to <code>claude_desktop_config.json</code> and restart the app.</p>
          <pre>{json}</pre>
        </div>
      </details>

      <details className="snippet">
        <summary><span className="sum">Cursor</span><span className="hint">{hint}</span><CopyButton value={json} label="Copy config" /></summary>
        <div className="snippet-body">
          <p className="muted">The same block goes in <code>~/.cursor/mcp.json</code> (or <code>.cursor/mcp.json</code> in a project).</p>
          <pre>{json}</pre>
        </div>
      </details>

      <p className="help">
        Revoking the key above disconnects every agent using it, immediately.
      </p>
    </section>
  )
}
