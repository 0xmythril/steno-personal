# steno-personal

[![CI](https://github.com/0xmythril/steno-personal/actions/workflows/ci.yml/badge.svg)](https://github.com/0xmythril/steno-personal/actions/workflows/ci.yml)
[![Licence: AGPL-3.0](https://img.shields.io/badge/licence-AGPL--3.0-blue.svg)](LICENSE)

**Your Telegram and WhatsApp conversations, connected to your AI agents.**

Agents have no way into your personal Telegram or WhatsApp. This gives them one,
and only ever a read: both apps reachable over **MCP**, on a computer you
control, staying current as new messages arrive. Context that was split across
two apps — what you agreed to, who said it, when — becomes one thing an agent
can search, so it works from what you actually said instead of what you can be
bothered to paste into a prompt.

It connects to **your** accounts — your Telegram account, your number as a
linked WhatsApp device — reads what is already there, and writes nothing back.
No bot, no second phone number, no account on our servers.

- **Read-only by construction** — the code has no way to send a message, mark a
  chat read, set your presence, or change your profile. See [PRIVACY.md](PRIVACY.md).
- **Yours** — one container, one volume, one SQLite file. No sign-up. Two
  things can leave the machine and both are listed in [PRIVACY.md](PRIVACY.md): enrichment,
  off until you turn it on, and anonymous usage events — that a feature was
  used, never what it was used on — which you can turn off.
- **One person, not two accounts** — the [address book](docs/people.md) links
  the same human across both apps, so a chat and a transcript say *Ada* whether
  she wrote from Telegram or from WhatsApp.
- **Agent-ready** — [MCP tools](docs/mcp.md) to list, search and read chats,
  fetch an attachment, and list the people in your address book.

[Quick start](#quick-start) · [Connect an agent](#connect-your-agent) · [Deploy on Railway](#deploy-on-railway) · [Teams → Steno.chat](https://steno.chat)

> [!WARNING]
> WhatsApp connects through an unofficial client and your number can be
> restricted or banned. Telegram carries no comparable risk.
> [Read this before you pair WhatsApp.](#the-whatsapp-risk-in-one-paragraph)

Licensed under the GNU Affero General Public License v3.0.

## Quick start

You need Docker and a couple of minutes. **Start with Telegram** — it carries
the lower risk. WhatsApp is optional; read [the WhatsApp risk](#the-whatsapp-risk-in-one-paragraph)
before you pair it.

```bash
git clone https://github.com/0xmythril/steno-personal.git
cd steno-personal
docker compose up
```

The first boot creates the volume and applies migrations. No key is printed to
the log; the first visit sets the instance up.

1. Open <http://localhost:3000> — a fresh instance lands on **Setup**.
2. Connect **Telegram**: consent screen, then a QR code you scan with the phone.
   The account you pair is what the archive reads, and it is also how you prove
   the archive is yours if you ever lose your key. Add WhatsApp later under
   **Connections**.
3. Press **Create my access key**. It is shown exactly once — save it. It logs
   you into the portal and authenticates your agents. Optionally register a
   **passkey** for the browser you are in, so that browser logs in with Touch
   ID, Windows Hello, or your phone.
4. Wait for backfill. Chats appear as they land. Mint more keys under
   **Settings** — one per agent or device.

**Lost your key?** Choose **Pair your phone again** on the login page: the same
account gets you a new one. Every other path — no phone, start over — is in
[Lost access](docs/self-hosting.md#lost-access).

Stop with `docker compose down`; your data stays in the `data` volume. Throw
everything away with `docker compose down -v`.

More ways to run it — bare Node, reverse proxy, upgrades, every environment
variable: [docs/self-hosting.md](docs/self-hosting.md).

## Connect your agent

Agents talk to `https://<your-host>/mcp` (or `http://localhost:3000/mcp` on your
laptop) with an access key as a bearer token.

There is no `--read-only` flag to remember, because there is nothing to switch
off: every tool declares itself read-only to the client, and the code has no
path that sends. Read-only is how it is built, not a mode it is in.

**Fastest path:** Settings → create a key → **Copy instructions** under "Let the
agent set itself up" → paste into an agent that can edit its own MCP config. It
verifies with `whoami`.

<details>
<summary><b>Cursor</b> — <code>~/.cursor/mcp.json</code> (all projects) or <code>.cursor/mcp.json</code> (this one)</summary>

```json
{
  "mcpServers": {
    "steno-personal": {
      "url": "https://<your-host>/mcp",
      "headers": { "Authorization": "Bearer sp_your_key_here" }
    }
  }
}
```

</details>

<details>
<summary><b>Claude Code</b> — one command</summary>

```bash
claude mcp add --transport http steno-personal https://<your-host>/mcp \
  --header "Authorization: Bearer sp_your_key_here"
```

</details>

<details>
<summary><b>Claude Desktop</b> — <code>claude_desktop_config.json</code>, then restart the app</summary>

```json
{
  "mcpServers": {
    "steno-personal": {
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

</details>

Ask it *"which chat accounts are connected?"* — that is `whoami`, and it answers
with channels and display names, never a phone number.

A key reads the **whole** archive. Mint one key per agent, put the scope in the
agent's own instructions (`channel`, `kind`, named chats), and revoke on any
doubt. All seven tools, their filters and the agent safety notes:
[docs/mcp.md](docs/mcp.md).

## Telegram

Nothing to set up. The project ships its own registered Telegram application —
the same thing Telegram Desktop and every open-source client does — so a fresh
deploy can pair Telegram straight away. You log in with your own account; the
application only names the software. To run under an application of your own,
register one at <https://my.telegram.org> and set `TELEGRAM_API_ID` and
`TELEGRAM_API_HASH`; `TELEGRAM_API_ID=0` runs without Telegram at all.

On **Connections**, read the consent screen and press Connect, then scan the QR
with Telegram → Settings → Devices → Link Desktop Device. If your account has
two-step verification, the page asks for that password and stores it encrypted
just long enough for the worker to use it once.

The connection is read-only: it never marks anything read, never shows you as
online, and never sends. It appears in Telegram's own device list as
**steno-personal**, and removing it there revokes it here within seconds.

## The WhatsApp risk, in one paragraph

WhatsApp publishes no personal-archive API, so this connects as a linked device
on your own number through an unofficial client library.

**This connects through an unofficial WhatsApp client.
Use it at your own risk.**

Your number can be restricted or banned. You are shown these same sentences on
the consent screen before the QR code, you accept the risk yourself, and nothing
in this project can remove it. There is no flag that makes it safe, and the risk
is higher on a public cloud host than on a machine at home.

Telegram carries no comparable risk: it connects through Telegram's own
published user API, the same one every third-party Telegram client uses.

## Need it for a team?

For teams, shared **group** archives, or if you would rather not link your own
account, use [Steno.chat](https://steno.chat). It records through its own number,
so your personal account stays unlinked.

## Deploy on Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/1Vhm3c?referralCode=45_zFw&utm_medium=integration&utm_source=button&utm_campaign=steno-personal)

One click gives you a service built from this repo's `Dockerfile`, a 5 GB volume
mounted at `/data`, and a generated `SECRET_KEY`. Open the generated
`*.up.railway.app` URL as soon as the deploy is green and finish **Setup**: pair
a channel, save your first key.

**Before you click**

1. A Railway deploy has a public URL. Until you have your first access key,
   **Setup** is open to whoever reaches that URL first (once you have started
   pairing, every other visitor is refused on both channels until you finish) —
   so claim the deploy promptly. Afterwards, an access key (or a passkey) is the
   only thing between the internet and your archive; read
   [docs/threat-model.md](docs/threat-model.md).
2. Re-read the WhatsApp paragraph above. Cloud hosting is where account
   restrictions are most likely; a laptop, a Mac mini, or a Raspberry Pi at home
   is the safer place to run this.

New to Railway? Signing up through <https://railway.com?referralCode=45_zFw>
gives you starter credits. It is the maintainer's referral link — Railway pays a
share of your first year's bills to this project — and it is entirely optional.

Publishing the template yourself, or self-hosting on Railway without it, is in
[docs/self-hosting.md](docs/self-hosting.md).

## People (address book)

The **People** page links the same human across Telegram and WhatsApp, so a chat
and a transcript can say *Ada* whether she wrote from Telegram or from WhatsApp.
It fills itself in from your contacts and direct chats; you merge, alias, hide,
and add notes. It is your own annotation over the archive — nothing is sent back
to either channel.

Matching rules, merges, and exactly what an agent sees:
[docs/people.md](docs/people.md).

## Configuration

Every variable is optional; empty means unset. These are the ones most people
touch — the full table is in
[docs/self-hosting.md](docs/self-hosting.md#configuration).

| Variable | Default | What it does |
|---|---|---|
| `DATA_DIR` | `./data`; `/data` in Docker | Where everything lives: the SQLite file, media, WhatsApp auth state, the generated secret. |
| `PORT` | `3000` | Port the portal and the MCP endpoint listen on. |
| `SECRET_KEY` | generated into `$DATA_DIR` | Encrypts the Telegram session, revealable access keys and your OpenRouter key at rest. **Changing or losing it** means re-pairing the channels and re-entering the OpenRouter key; your messages are unaffected. |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | the project's own | Optional: run under your own Telegram application. `TELEGRAM_API_ID=0` runs without Telegram. Set both together or neither. |
| `DO_NOT_TRACK` | unset | `1` and no anonymous usage event is ever sent, whatever Settings says. |
| `STENO_MINT_KEY` | unset | Emergency: mints a labelled key once into the boot log. See [Lost access](docs/self-hosting.md#lost-access). |

**The one optional third party.** Image text extraction and voice-note
transcription are off until you save an OpenRouter key in **Settings**. Leave it
blank and that traffic never leaves your machine.

## Backups

Everything is under `DATA_DIR`. Stop the app first — SQLite in WAL mode leaves a
`-wal` file, and a copy taken mid-write can be a moment behind — then copy the
directory.

```bash
docker compose stop app
docker run --rm -v steno-personal_data:/data -v "$PWD:/backup" \
  busybox tar czf /backup/steno-backup.tar.gz -C /data .
docker compose start app
```

Restoring, bare Node, and Railway volumes:
[docs/self-hosting.md](docs/self-hosting.md#backups).

## Documentation

| | |
|---|---|
| [PRIVACY.md](PRIVACY.md) | What is read, what is stored, what leaves the box. |
| [SECURITY.md](SECURITY.md) | The security model, and how to report a problem. |
| [docs/mcp.md](docs/mcp.md) | The MCP tools, their filters, and agent safety. |
| [docs/people.md](docs/people.md) | The address book, merges, what agents see. |
| [docs/self-hosting.md](docs/self-hosting.md) | Docker, bare Node, Railway, reverse proxies, configuration, backups, recovery. |
| [docs/architecture.md](docs/architecture.md) | How the two processes and the channel port fit together. |
| [docs/threat-model.md](docs/threat-model.md) | What this protects against, and what it does not. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Ground rules, development setup, what the project will not become. |
| [docs/releasing.md](docs/releasing.md) | How a release is cut. |
| [CHANGELOG.md](CHANGELOG.md) | Releases. |

## Contributing

Issues and pull requests are welcome; read [CONTRIBUTING.md](CONTRIBUTING.md)
first — it lists the promises the code keeps and what the project will not
become. Conduct is covered by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Licence

GNU Affero General Public License v3.0; see [LICENSE](LICENSE) for the full
text. Because it is the AGPL, if you modify it and let other people use your
modified version over a network, you have to offer them your source too.

## Follow along

- Source: <https://github.com/0xmythril/steno-personal> — watch the repository
  or its Releases page to hear about new versions.
- Maintainer: [0xmythril](https://github.com/0xmythril), who also posts about it
  on X at <https://x.com/0xmythril>.
- **Want the next version early?** Changes are integrated on `staging` and run
  on a private staging instance before they reach `main`. What is being tested
  is tagged as a pre-release — `vX.Y.Z-rc.N` on the
  [releases page](https://github.com/0xmythril/steno-personal/releases) — so you
  can check the tag out and run it yourself. There is no shared instance to log
  into: this is one archive for one person.
