# steno-personal

[![CI](https://github.com/0xmythril/steno-personal/actions/workflows/ci.yml/badge.svg)](https://github.com/0xmythril/steno-personal/actions/workflows/ci.yml)
[![Licence: AGPL-3.0](https://img.shields.io/badge/licence-AGPL--3.0-blue.svg)](LICENSE)

Your own Telegram and WhatsApp chats, archived read-only into one SQLite file
on a machine you control, and readable by your agents over MCP.

It connects to **your** accounts — your Telegram account, your number as a
linked WhatsApp device — reads what is already there, and writes nothing back.
No bot, no second number, no accounts to create, no server of ours involved.
One container, one volume, one file.

- **Read-only by construction.** The code has no way to send a message, mark a
  chat read, set your presence, or change your profile. See [PRIVACY.md](PRIVACY.md).
- **Yours only.** No sign-up, no accounts, no analytics SDK in the code. Two
  things can leave the machine and both are listed in [PRIVACY.md](PRIVACY.md):
  enrichment, off until you turn it on, and anonymous usage events — that a
  feature was used, never what it was used on — which you can turn off in
  Settings or with `DO_NOT_TRACK=1`.
- **Agent-ready.** An MCP endpoint with five read tools: list chats, read a
  chat, search, list the people in your address book, and ask which accounts
  are connected.

Licensed under the GNU Affero General Public License v3.0.

## Need it for a team?

For teams, or if you don't want to connect your own account, go to
[Steno.chat](https://steno.chat) for our hosted solution. It archives shared
group chats through its own number, so nothing of yours is linked.

## The WhatsApp risk, in one paragraph

WhatsApp connects here as a linked device on your own number, through an
unofficial client library, because WhatsApp publishes no personal-archive API.

**This connects through an unofficial WhatsApp client.
Use it at your own risk.**

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

The first boot creates the volume and applies migrations. Nothing is printed
to the log; the first visit sets the instance up:

1. Open <http://localhost:3000>. A fresh instance lands on **Setup**.
2. Connect Telegram or WhatsApp. Each shows a consent screen, then a QR code
   you scan with the phone. The account you pair is what the archive reads,
   and it is also how you prove the archive is yours if you ever lose your key.
3. Press **Create my access key**. Your first key is shown exactly once, with a
   Copy button; save it before you continue. It logs you in here and is what
   your agents use. Under it, optionally register a **passkey** for the browser
   you are in: from then on that browser logs in with Touch ID, Windows Hello,
   or your phone, and the key is for agents and other devices.
4. Wait. Backfill runs in the background; the Chats page fills in as it lands.
   Connect the other channel from **Connections** whenever you like, and make
   more keys under **Settings** — one per device or agent.

Lost the key? **Pair your phone again** on the login page: the same account
gets you a new key. Everything else — no phone, start over — is in
[Lost access](docs/self-hosting.md#lost-access).

To stop: `docker compose down`. Your data stays in the `data` volume. To throw
everything away: `docker compose down -v`.

## Deploy on Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/1Vhm3c?referralCode=45_zFw&utm_medium=integration&utm_source=button&utm_campaign=steno-personal)

One click gives you a service built from this repo's `Dockerfile`, a 5 GB
volume mounted at `/data`, and a generated `SECRET_KEY`. Open the generated
`*.up.railway.app` URL as soon as the deploy is green: it walks you through
pairing a channel and hands you your first access key.

Two things to know before you click. First, a Railway deploy has a public URL.
Until you have your first access key, **Setup** is open to whoever reaches that
URL first (a pairing you have started can only be finished from your own
browser), and afterwards the only thing standing between the internet and your
archive is an access key or a passkey — so claim the deploy promptly, and read
[docs/threat-model.md](docs/threat-model.md). Second, re-read the WhatsApp
paragraph above: cloud hosting is where account restrictions are most likely.
A laptop, a Mac mini, or a Raspberry Pi at home is the safer place to run this.

New to Railway? Signing up through <https://railway.com?referralCode=45_zFw> gives
you $20 in credits. It is the maintainer's referral link — Railway pays a share
of your first year's bills to this project — and it is entirely optional.

Publishing the template yourself, or self-hosting on Railway without it, is in
[docs/self-hosting.md](docs/self-hosting.md).

## Connect your agent

Everything an agent sees goes through the MCP endpoint at
`https://<your-host>/mcp`, authenticated with an access key as a bearer
token. Mint a separate key per agent in **Settings** so you can revoke one
without disturbing the others.

The tools are `list_chats`, `recent_messages`, `get_messages`,
`search_messages`, `get_media`, `list_people` and `whoami`. They only read,
and each declares itself read-only to the client. There is no tool that sends
anything.

- `list_chats` filters by channel, by kind (dm, group, channel) or by `q`, a
  substring of the title, and pages twenty at a time with a cursor; each chat
  carries a snippet of its latest message.
- `recent_messages` is the inbox: the newest messages across every chat, or
  one channel or kind, each naming the chat it came from.
- `search_messages` narrows by chat, channel, kind, sender and a date range.
- `get_media` returns one attachment by its `media.id`: a ready image up to
  3 MiB comes back as image content the agent can look at, anything else as
  metadata plus the `/media/<id>` path. Every message with an attachment says
  whether its bytes are ready, pending, failed or unavailable.
- `list_people` takes `q` and names the chats each person appears in.

**Shortest path:** open **Settings**, create a key, and press **Copy
instructions** under "Let the agent set itself up". Paste that block into any
agent that can edit its own MCP config; it names the server `steno-personal`,
carries the URL and the key, and tells the agent to verify with `whoami`. The
manual versions follow.

**Claude Code**

```bash
claude mcp add --transport http steno-personal https://<your-host>/mcp \
  --header "Authorization: Bearer sp_your_key_here"
```

**Claude Desktop** — add to `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`), then restart
the app:

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

**Cursor** — add to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json`
(this project only):

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

## People

One person, two apps. The archive stores channel identities — a Telegram user
id, a WhatsApp number — and **People** is the address book that groups them, so
a chat and a transcript can say *Ada* whether she wrote from Telegram or from
WhatsApp. It is your own annotation over the archive: nothing is sent back to
either channel, and nothing you write here changes a message.

**It fills itself in.** After every contact sync, everyone in your contact list
and the other side of every direct chat becomes a person, named the way that
channel names them, with that identity linked. Nothing is invented: a person who
has only ever written in a group is not one of them, and neither is an identity
with no name at all. The page tags those rows **Auto** and the link says *found
in your contacts*.

Two identities are joined into one person **only when their phone numbers are
equal**. That is the one match strong enough to act on by itself, and it needs a
number on both sides — a Telegram contact whose number Telegram will not show
you cannot be matched this way. An identical name is never enough: the two get a
row each, and the page offers to merge them and waits for you.

You can still open **People**, add a person, and link their identities yourself.
Everyone the archive knows about on a channel is offered — your contact list,
the other side of every direct chat, and anyone whose message it has archived —
under the name that channel knows them by, with their number where there is one.
An identity belongs to at most one person; move it by unlinking it first.

**Your name wins.** A name that came off a contact list follows it: rename the
contact on your phone and the archive follows on the next sync. Type a name here
and it becomes an **alias** — no sync overwrites it, ever. *Use channel name* on
their page hands it back and the name starts following the channel again.

**Merge into.** Two rows for one person is the normal state of an address book
that filled itself in. *Merge into* on a person's page moves all of their
identities to whoever you choose and removes the row you were on. The survivor
keeps its name, unless it only has a channel name and the row you merged carries
an alias you typed — a name a human chose outranks one copied off a phone.

**Suggestions.** Because the address book fills itself in, two people who match
already have a row each — so a suggestion is a question about those two rows:
*Merge Ada into Ada?* It never acts on one by itself; confirming is a button you
press.

- A pair is offered when one row has only Telegram identities, the other only
  WhatsApp, and the two names are the same once trimmed, ignoring
  capitalisation. "Ada L" and "Ada Lovelace" are not offered.
- Matching phone numbers never reach this list: those two are joined for you
  already. A name is all that is left when Telegram will not show you a
  contact's number — it hides one unless you have each other saved, or they let
  everyone see it — and a name is only ever a hint.
- **Confirm** moves every identity onto the older of the two rows and removes
  the other, exactly as *Merge into* does on a person's page.
- **Dismiss** remembers your no. It is remembered against the two identities,
  not the two rows, so it holds even if the rows are rebuilt by a later sync.
- Hidden people are never offered: hiding is already an answer.

**What your agent sees.** A chat or a message gains a `person` field —
`{ id, name }` — when the sender or the other side of a direct chat is someone
in your address book, and the `list_people` tool lists it: id, name,
your notes, which channels are linked, and how many chats they appear in. Never
a phone number, and never the underlying Telegram id or WhatsApp number — the id
is this instance's own and means nothing outside it. The notes are the one field
you write yourself and they go out verbatim, so write them for an agent to read.
`GET /api/people` answers the same thing with the same key.

Two labels come from the same contact list, and they are not gated behind a
link. A name you saved in your contacts is used as the sender label for that
person's messages wherever the channel sent none — in the portal and to an agent
— and a WhatsApp chat or sender nobody has any name for shows as the phone
number that is its identity, again in both places. Neither adds a field: they
fill in `senderName` and a chat's title, which an access key can already read.

**Hiding someone.** *Hide* takes a person out of the address book and away from
your agents, and keeps their links: that is what stops the next contact sync
putting them back. Hidden people are listed under **Hidden** at the foot of the
People page with a Restore button each, so nothing is lost. The chats, the
messages and the attachments are untouched either way, and their names go back
to whatever the channels call them. Deleting a *connection* clears the contacts
read from that account, but leaves your people alone — they are yours, not the
channel's.

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
| `STENO_POSTHOG_KEY` | the project's token | The PostHog project anonymous usage events are sent to. It is PostHog's write-only client token, shipped in the build as every PostHog client's is; a fork sets its own. It is **not** the off switch — that is the **Anonymous usage** box in Settings, or `DO_NOT_TRACK=1`. See [What leaves your machine](PRIVACY.md#what-leaves-your-machine). |
| `STENO_POSTHOG_HOST` | `https://us.i.posthog.com` | PostHog ingest host. Set the EU host if your project lives there. |
| `DO_NOT_TRACK` | unset | Set to `1` and no usage event is ever sent, whatever Settings says. The same variable GitHub CLI and other tools honour. |
| `STENO_MINT_KEY` | unset | Set to a label (say `laptop`) and restart: boot mints an access key with that label and prints it **once** in the boot log, then remembers the value in `$DATA_DIR/boot-ops.json` so a restart with it still set prints nothing. For when every key is lost and you cannot pair the same phone again. Remove it afterwards. See [Lost access](docs/self-hosting.md#lost-access). |
| `STENO_RESET` | unset | Set to any word and restart: boot empties `DATA_DIR` — database, media, WhatsApp auth state, generated secret — once for that word, and the next visit starts setup from scratch. Unlink **steno-personal** on your phone yourself afterwards; a reset cannot reach the phone. |

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

## Contributing

Issues and pull requests are welcome; read [CONTRIBUTING.md](CONTRIBUTING.md)
first — it lists the promises the code keeps and what the project will not
become. Conduct is covered by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Documentation

| | |
|---|---|
| [PRIVACY.md](PRIVACY.md) | What is read, what is stored, what leaves the box. |
| [SECURITY.md](SECURITY.md) | The security model, and how to report a problem. |
| [docs/self-hosting.md](docs/self-hosting.md) | Docker, bare Node, Railway, reverse proxies, backups, upgrades. |
| [docs/architecture.md](docs/architecture.md) | How the two processes and the channel port fit together. |
| [docs/threat-model.md](docs/threat-model.md) | What this protects against, and what it does not. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Ground rules, development setup, what the project will not become. |
| [docs/releasing.md](docs/releasing.md) | How a release is cut. |
| [CHANGELOG.md](CHANGELOG.md) | Releases. |

## Licence

This project is licensed under the GNU Affero General Public License v3.0; see
[LICENSE](LICENSE) for the full text. Because it is the AGPL, if you modify it
and let other people use your modified version over a network, you have to offer
them your source too.

## Follow along

Source lives at <https://github.com/0xmythril/steno-personal>; watch the
repository or its Releases page to hear about new versions. steno-personal is
built and maintained by [0xmythril](https://github.com/0xmythril), who also
posts about it on X at <https://x.com/0xmythril>.

**Want the next version early?** Changes are integrated on the `staging`
branch and run on a private staging instance before they reach `main`. What is
being tested is tagged as a pre-release — `vX.Y.Z-rc.N` on the
[releases page](https://github.com/0xmythril/steno-personal/releases) — so you
can check the tag out and run it on your own instance ahead of the stable
release. There is no shared instance to log into: this is one archive for one
person, so the only way to see it running is to run it yourself.
