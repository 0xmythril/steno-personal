# Deploy and Host steno-personal on Railway

**Your Telegram and WhatsApp conversations, connected to your AI agents.**

One click gives you a running instance: a service built from the project's
Dockerfile, a 5 GB volume at `/data`, and a public URL. Open that URL as soon as
the deploy is green — it lands on **Setup**. Pair a channel, save the access key
it hands you (shown once), and point your agent at `https://your-app.up.railway.app/mcp` with
that key as a bearer token.

## About Hosting steno-personal

Your conversations from both apps live in a single SQLite file on the volume
and stay current as new messages arrive. Agents reach them over **MCP** and can
only read: the code has no path that sends a message, marks a chat read, sets
your presence, or changes your profile. No bot, no second phone number, no
account with anyone but Railway.

- **Read-only by construction.** Every MCP tool declares itself read-only;
  there is no send path to switch off.
- **Yours.** One container, one volume, one file. Two things can leave the
  machine and both are documented: enrichment (off until you add an OpenRouter
  key) and anonymous usage events (off with `DO_NOT_TRACK=1`).
- **Agent-ready.** Seven tools to list, search and read chats, fetch an
  attachment, list your address book, and ask which accounts are connected.
  Works with Claude Code, Claude Desktop, Cursor, and anything that speaks MCP.

**What it costs.** Railway's Hobby plan is $5 a month and includes $5 of usage,
which one instance sitting quietly should stay inside. The free trial and Free
plan cap a volume at 0.5 GB and this template asks for 5 GB, so plan on Hobby.

## Why Deploy steno-personal on Railway?

Agents have no way into your personal Telegram or WhatsApp. This gives them
one, on a machine you do not have to leave switched on: Railway supplies the
always-on host, the persistent volume and the public URL, and the template
generates a fresh `SECRET_KEY` for every deploy. Nothing of yours touches a
server of ours.

**Pair Telegram here.** WhatsApp connects through an unofficial client and
your number can be restricted or banned; a cloud host is where that is most
likely. Read the WhatsApp paragraph in the README before pairing it anywhere,
and prefer a machine at home for WhatsApp.

**Claim it promptly.** The URL is public. Until you finish Setup, whoever
reaches it first can pair an account; once you have your key, an access key (or
a passkey) is what stands between the internet and your archive.

## Common Use Cases

- Ask Claude or Cursor *"what did Ada and I agree on last week?"* and get an
  answer from what was actually said, not what you pasted into the prompt.
- Search across both apps at once — one person, one thread of context, whether
  they wrote from Telegram or WhatsApp.
- Give a work agent `channel: whatsapp` or `kind: group` in its instructions
  and keep it in its lane; the tools take those filters.
- Read an attachment: images come back as image content the agent can look at.

## Dependencies for steno-personal Hosting

- A Telegram account, and optionally a WhatsApp number, that you own and pair
  by scanning a QR code from your phone.
- An MCP-capable agent: Claude Code, Claude Desktop, Cursor, or any client that
  speaks Streamable HTTP with a bearer header.
- Optional: an OpenRouter key, added in Settings, if you want image text and
  voice-note transcription. Leave it out and nothing leaves the machine.

### Deployment Dependencies

- [Repository](https://github.com/0xmythril/steno-personal)
- [README](https://github.com/0xmythril/steno-personal#readme)
- [Privacy — what is read, stored, and what can leave](https://github.com/0xmythril/steno-personal/blob/main/PRIVACY.md)
- [Self-hosting, configuration, backups, lost access](https://github.com/0xmythril/steno-personal/blob/main/docs/self-hosting.md)
- [MCP tools and agent safety](https://github.com/0xmythril/steno-personal/blob/main/docs/mcp.md)
- [Threat model](https://github.com/0xmythril/steno-personal/blob/main/docs/threat-model.md)
- [Questions](https://github.com/0xmythril/steno-personal/discussions/categories/q-a)

steno-personal is not affiliated with Telegram, WhatsApp, or Meta. Licensed
AGPL-3.0.
