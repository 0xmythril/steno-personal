import { headers } from 'next/headers'
import { CopyButton } from '@/app/copy-button'
import { KEY_PLACEHOLDER, claudeCodeCommand, mcpServersJson, mcpUrlFrom } from '@/lib/mcp/client-config'

// `rawKey` is the key that was just minted, carried here by the httpOnly
// flash cookie the settings page already reads. It is not fetched, revealed,
// or stored: the one render after minting is the one chance to hand the user
// a config with the secret already in it.
export async function ConnectAgent({ rawKey }: { rawKey: string | null }) {
  const h = await headers()
  const mcpUrl = mcpUrlFrom({
    host: h.get('host'),
    forwardedHost: h.get('x-forwarded-host'),
    forwardedProto: h.get('x-forwarded-proto'),
  })
  const key = rawKey ?? KEY_PLACEHOLDER
  const command = claudeCodeCommand(mcpUrl, key)
  const json = mcpServersJson(mcpUrl, key)

  return (
    <section className="card">
      <h2>Connect your agent</h2>
      <p className="muted">
        Your agent reads this archive over MCP with an access key as its bearer token. It can list your
        chats, read a transcript, and search — nothing else; the archive is read-only.
      </p>
      <p>
        MCP endpoint: <code>{mcpUrl}</code> <CopyButton value={mcpUrl} label="Copy URL" />
      </p>
      {rawKey
        ? <p className="muted">The key you just created is filled in below. It is shown on this page only once.</p>
        : <p className="muted">Create a key above and these snippets will come back with it already filled in. Until then, replace <code>{KEY_PLACEHOLDER}</code> yourself.</p>}

      <h3>Claude Code</h3>
      <pre>{command}</pre>
      <CopyButton value={command} label="Copy command" />

      <h3>Claude Desktop</h3>
      <p className="muted">Add this to <code>claude_desktop_config.json</code> and restart the app.</p>
      <pre>{json}</pre>
      <CopyButton value={json} label="Copy config" />

      <h3>Cursor</h3>
      <p className="muted">The same block goes in <code>~/.cursor/mcp.json</code> (or <code>.cursor/mcp.json</code> in a project).</p>
      <pre>{json}</pre>
      <CopyButton value={json} label="Copy config" />

      <p className="muted">
        Revoking the key above disconnects every agent using it, immediately.
      </p>
    </section>
  )
}
