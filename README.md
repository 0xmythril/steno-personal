# steno-personal

Your own Telegram and WhatsApp chats, archived read-only into one SQLite file
on a machine you control, and readable by your agents over MCP.

It connects to **your** accounts — your Telegram account, your number as a
linked WhatsApp device — reads what is already there, and writes nothing back.
No bot, no second number, no accounts to create, no server of ours involved.
One container, one volume, one file.

- **Read-only by construction.** The code has no way to send a message, mark a
  chat read, set your presence, or change your profile. See [PRIVACY.md](PRIVACY.md).
- **Yours only.** No sign-up, no telemetry, no analytics, no third party — one
  optional exception you switch on yourself (see Configuration).
- **Agent-ready.** An MCP endpoint with four read tools: list chats, read a
  chat, search, and ask which accounts are connected.

Licensed under the GNU Affero General Public License v3.0.

## The WhatsApp risk, in one paragraph

WhatsApp connects here as a linked device on your own number, through an
unofficial client library, because WhatsApp publishes no personal-archive API.

**WhatsApp does not permit unofficial clients.
Your number can be restricted or banned, and your phone will show an unofficial-client notice under Linked devices.
The risk is higher when this runs on a cloud host than on a machine at home.**

You are shown these same sentences on the consent screen before the QR
code, you accept the risk yourself, and nothing in this project can remove it.
There is no flag that makes it safe. Telegram carries no comparable risk: it
connects through Telegram's own published user API, the same one every
third-party Telegram client uses.

## Quick start

You need Docker and about two minutes.

```bash
git clone https://github.com/0xmythril/steno-personal.git
cd steno-personal
docker compose up
```

The first boot creates the volume, applies migrations, and prints your first
access key:

```
==========================================================
  steno-personal: your first access key
  sp_9f2c8a1e4b7d0356af91c2e8d4b607135e0ac6d2f8
  Paste it at /login, then mint a named key in Settings
  and revoke this one.
==========================================================
```

Then:

1. Open <http://localhost:3000> and paste that key.
2. Go to **Settings**, create a key with a name (one per device or agent), and
   **revoke the printed one** — it is sitting in your shell history and your
   container log.
3. Go to **Connections** and connect Telegram, WhatsApp, or both. Each shows a
   consent screen, then a QR code you scan with the phone.
4. Wait. Backfill runs in the background; the Chats page fills in as it lands.

To stop: `docker compose down`. Your data stays in the `data` volume. To throw
everything away: `docker compose down -v`.

## Deploy on Railway

[![Deploy on Railway](https://railway.com/button.svg)](<RAILWAY_TEMPLATE_URL>)

One click gives you a service built from this repo's `Dockerfile`, a 5 GB
volume mounted at `/data`, and a generated `SECRET_KEY`. Watch the deploy log:
your bootstrap access key is printed there exactly as above. Open the generated
`*.up.railway.app` URL, log in with it, and mint your own key.

Two things to know before you click. First, a Railway deploy has a public URL,
and the only thing standing between the internet and your archive is an access
key — so revoke the bootstrap key as soon as you have minted your own, and read
[docs/threat-model.md](docs/threat-model.md). Second, re-read the WhatsApp
paragraph above: cloud hosting is where account restrictions are most likely.
A laptop, a Mac mini, or a Raspberry Pi at home is the safer place to run this.

Publishing the template yourself, or self-hosting on Railway without it, is in
[docs/self-hosting.md](docs/self-hosting.md).

## Connect your agent

Everything an agent sees goes through the MCP endpoint at
`https://<your-host>/mcp`, authenticated with an access key as a bearer
token. Mint a separate key per agent in **Settings** so you can revoke one
without disturbing the others.

The tools are `list_chats`, `get_messages`, `search_messages`, and `whoami`.
They only read. There is no tool that sends anything.

**Claude Code**

```bash
claude mcp add --transport http steno https://<your-host>/mcp \
  --header "Authorization: Bearer sp_your_key_here"
```

**Claude Desktop** — add to `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`), then restart
the app:

```json
{
  "mcpServers": {
    "steno": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://<your-host>/mcp",
        "--header", "Authorization: Bearer sp_your_key_here"
      ]
    }
  }
}
```

**Cursor** — add to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json`
(this project only):

```json
{
  "mcpServers": {
    "steno": {
      "url": "https://<your-host>/mcp",
      "headers": { "Authorization": "Bearer sp_your_key_here" }
    }
  }
}
```

Running on your laptop rather than a host with TLS? Use
`http://localhost:3000/mcp`.

Ask your agent *"which chat accounts are connected?"* to check the wiring — that
is `whoami`, and it answers with channels and display names, never a phone
number.

## Connecting Telegram

The worker needs Telegram API credentials of its own. Until this project ships
its own registered pair, get one from <https://my.telegram.org> and set
`TELEGRAM_API_ID` and `TELEGRAM_API_HASH` before you connect — including on a
one-click Railway deploy. Without them the app still runs: the worker logs one
warning, skips Telegram entirely, and no login code ever appears.

With them set, open **Connections**, read the consent screen, and press Connect.
Scan the QR code with Telegram &rarr; Settings &rarr; Devices &rarr; Link
Desktop Device; if your account has two-step verification, the page asks for
that password and stores it encrypted just long enough for the worker to use it
once.

The connection is read-only: it never marks anything read, never shows you as
online, and never sends. It appears in Telegram's own device list as
**steno-personal**, and removing it there revokes it here within a few seconds.
Disconnect does the same from this side and keeps everything already archived.

## Configuration

Every variable is optional except `DATA_DIR`, which Docker already sets. Empty
means unset.

| Variable | Default | What it does |
|---|---|---|
| `DATA_DIR` | `/data` in Docker, none otherwise | Where everything lives: the SQLite file, downloaded media, WhatsApp auth state, and the generated secret key. |
| `PORT` | `3000` | Port the portal and MCP endpoint listen on. |
| `SECRET_KEY` | generated | Encrypts your OpenRouter key, your revealable access keys, and the Telegram session at rest. If unset, one is generated into `$DATA_DIR/secret.key` on first boot. Set it yourself and the file is not used. **Changing or losing it makes those encrypted values unreadable** — you re-pair the channels and re-enter the OpenRouter key; your messages are unaffected. |
| `TELEGRAM_API_ID` | none — set your own | Telegram application id, from <https://my.telegram.org>. Until this project ships its own registered pair, Telegram needs yours: without it the worker logs one warning, skips Telegram, and no QR code ever appears. |
| `TELEGRAM_API_HASH` | none — set your own | Telegram application hash, from the same page. Both are required together. |
| `ANALYSIS_DAILY_LIMIT` | `500` | Images plus voice notes sent for enrichment per day. A ceiling, not an exact quota: the count is taken once per pass, before either medium runs, so a pass starting just under the limit can still drain a full batch of each — worst case `2 × ANALYSIS_BACKFILL_BATCH − 1` rows beyond it. `0` disables enrichment entirely. |
| `ANALYSIS_BACKFILL_BATCH` | `20` | How many old attachments are enriched per pass, so a backfill does not spend the day's budget at once. |
| `LOG_LEVEL` | `info` | Exactly one of `trace`, `debug`, `info`, `warn`, `error`, `silent` — any other value fails validation at boot and the container will not start. Logs carry counts and kinds, never chat text, names, numbers, or your search queries — at any level. |
| `RUN_WEB` | on | Set to exactly `false` to run only the worker in this container. |
| `RUN_WORKER` | on | Set to exactly `false` to run only the portal in this container. |

**The one optional third party.** Image text extraction and voice-note
transcription are off until you save an OpenRouter key in **Settings**. Once you
do, the attachments you enabled are sent to OpenRouter to be read, and the text
comes back into your search index. Leave the key blank and nothing ever leaves
your machine. Per-item cost is recorded so you can see what it spent.

## Backups

Everything is under `DATA_DIR`. Back it up by copying that directory — there is
nothing else, no external database, no object store.

```bash
docker compose stop app
docker run --rm -v steno-personal_data:/data -v "$PWD:/backup" \
  busybox tar czf /backup/steno-backup.tar.gz -C /data .
docker compose start app
```

Stopping first is the honest way: SQLite in WAL mode leaves a `-wal` file, and a
copy taken mid-write can be a moment behind. A few seconds of downtime buys you
a backup you can trust. Restore by extracting the tarball back into an empty
volume and starting the container.

On Railway, pull the volume down with `railway volume browse /` or
`railway volume files download`, and turn on Railway's own volume backups.

## Lost every key?

Mint a new one from inside the container. This is the recovery path; it needs
shell access to the machine, which is exactly the bar it should be.

```bash
docker compose exec app npm run mint-key -- recovery
```

It prints one `sp_…` key. Log in with it, mint a named key in Settings, and
revoke `recovery`.

## Documentation

| | |
|---|---|
| [PRIVACY.md](PRIVACY.md) | What is read, what is stored, what leaves the box. |
| [SECURITY.md](SECURITY.md) | The security model, and how to report a problem. |
| [docs/self-hosting.md](docs/self-hosting.md) | Docker, bare Node, Railway, reverse proxies, backups, upgrades. |
| [docs/architecture.md](docs/architecture.md) | How the two processes and the channel port fit together. |
| [docs/threat-model.md](docs/threat-model.md) | What this protects against, and what it does not. |
| [CHANGELOG.md](CHANGELOG.md) | Releases. |

## Licence

This project is licensed under the GNU Affero General Public License v3.0; see
[LICENSE](LICENSE) for the full text. Because it is the AGPL, if you modify it
and let other people use your modified version over a network, you have to offer
them your source too.
