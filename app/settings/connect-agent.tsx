import { headers } from 'next/headers'
import { CopyButton } from '@/app/copy-button'
import {
  KEY_PLACEHOLDER, PUSH_SERVER_NAME, agentSetupPrompt, claudeCodeCommand, mcpPushUrlFrom, mcpServersJson,
  mcpUrlFrom, pushServersJson,
} from '@/lib/mcp/client-config'
import { useKeyForInstructionsAction, clearInstructionsKeyAction } from './actions'
import { AutoSubmit } from './auto-submit'

// `rawKey` is either the key that was just minted or the one the user picked
// from the list below; both arrive through an httpOnly flash cookie the
// settings page reads. Nothing here fetches or stores a secret: the render
// after the action is the one chance to hand the user a filled-in config.
export async function ConnectAgent({ rawKey, selectedId, keys, error }: {
  rawKey: string | null
  selectedId: string | null
  keys: { id: string; label: string; canRead: boolean; canPush: boolean }[]
  error: string | null
}) {
  const h = await headers()
  const headerFields = {
    host: h.get('host'),
    forwardedHost: h.get('x-forwarded-host'),
    forwardedProto: h.get('x-forwarded-proto'),
  }
  const mcpUrl = mcpUrlFrom(headerFields)
  const key = rawKey ?? KEY_PLACEHOLDER
  // The selected key's own capabilities decide which snippets show: a
  // push-only key would only be handed a read prompt/config/command it gets
  // a 401 from on every tool, and a read-only key would only be handed a
  // push URL it gets a 401 from. Unknown until one is chosen, so the
  // placeholder view shows every block — nothing here calls
  // verifyAccessKey, and a person copying the placeholder needs to see the
  // full menu before they mint the key.
  const selected = keys.find(k => k.id === selectedId)
  const canRead = rawKey ? (selected?.canRead ?? false) : true
  const canPush = rawKey ? (selected?.canPush ?? false) : true
  const command = claudeCodeCommand(mcpUrl, key)
  const json = mcpServersJson(mcpUrl, key)
  const pushUrl = canPush ? mcpPushUrlFrom(headerFields) : null
  const prompt = agentSetupPrompt(mcpUrl, key, pushUrl ?? undefined)
  const pushCommand = pushUrl ? claudeCodeCommand(pushUrl, key, PUSH_SERVER_NAME) : null
  const pushJson = pushUrl ? pushServersJson(pushUrl, key) : null
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
          {error && <span className="danger" role="alert">Cannot decrypt that key: SECRET_KEY changed since it was made.</span>}
        </form>
      )}
      {rawKey
        ? <p className="help">The snippets below carry the selected key. They are filled in for a few minutes only; use Clear to blank them sooner.</p>
        : <p className="help">Create a key above, or choose one, and these snippets come back with it already in place. Until then, replace <code>{KEY_PLACEHOLDER}</code> yourself.</p>}

      {canRead && (
        <details className="snippet" open>
          <summary><span className="sum">Let the agent set itself up</span><span className="hint">{hint}</span><CopyButton value={prompt} label="Copy instructions" /></summary>
          <div className="snippet-body">
            <p className="muted">Paste this into any agent that can edit its own MCP config: Claude Code, Cursor, and most others. It names the server, gives it the URL and key, and tells it how to verify.</p>
            <pre>{prompt}</pre>
          </div>
        </details>
      )}

      {canRead && (
        <details className="snippet">
          <summary><span className="sum">Or paste the config yourself</span><span className="hint">{hint}</span><CopyButton value={json} label="Copy config" /></summary>
          <div className="snippet-body">
            <p className="muted">
              Standard MCP <code>mcpServers</code> JSON, for any client that reads one. Claude Desktop: add it to <code>claude_desktop_config.json</code> and restart the app. Cursor: <code>~/.cursor/mcp.json</code>, or <code>.cursor/mcp.json</code> in a project.
            </p>
            <pre>{json}</pre>
            <p className="muted">Claude Code, from a terminal:</p>
            <pre>{command}</pre>
            <div className="actions"><CopyButton value={command} label="Copy command" /></div>
          </div>
        </details>
      )}

      {pushUrl && pushCommand && pushJson && (
        <details className="snippet">
          <summary><span className="sum">Let this agent store conversations</span><span className="hint">{hint}</span><CopyButton value={pushJson} label="Copy config" /></summary>
          <div className="snippet-body">
            <p className="muted">
              This key can also push: a second server, at a different URL, with one tool — push_messages. Use it to
              deliver a conversation you are having elsewhere into this archive; it never reads anything back.
            </p>
            <span className="token"><code>{pushUrl}</code> <CopyButton value={pushUrl} label="Copy URL" /></span>
            <pre>{pushJson}</pre>
            <p className="muted">Claude Code, from a terminal:</p>
            <pre>{pushCommand}</pre>
            <div className="actions"><CopyButton value={pushCommand} label="Copy command" /></div>
          </div>
        </details>
      )}

      <p className="help">
        Revoking the key above disconnects every agent using it, immediately.
      </p>
    </section>
  )
}
