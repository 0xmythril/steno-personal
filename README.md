# steno-personal

Your own Telegram and WhatsApp chats, archived read-only into one SQLite
file, readable by your agents over MCP. Self-hosted: one container, one
volume, no accounts.

**Status:** M4 (media and enrichment). Launch docs and the Railway template land in M5.

## Quick start

```bash
docker compose up
```

The first boot prints an access key in the log. Open http://localhost:3000,
paste it, then go to Settings, create a key with a name, and revoke the
printed one so nothing usable stays in your log history.

## The WhatsApp risk, in one paragraph

WhatsApp does not permit unofficial clients. steno-personal connects as a
linked device using Baileys, exactly the way WhatsApp Web does, but it is not
WhatsApp's own client: your number can be restricted or banned, and your phone
will show an unofficial-client notice under Linked devices. The risk is higher
when this runs on a cloud host than on a machine at home. steno-personal never
sends anything, never marks a chat read, and never shows you as online — but
that is a design guarantee, not a promise from WhatsApp. Connect a number you
can afford to lose access to, or do not connect one at all.

## Connecting Telegram

Open **Connections**, read the consent screen, and press Connect. Scan the QR
code with Telegram &rarr; Settings &rarr; Devices &rarr; Link Desktop Device;
if your account has two-step verification, the page asks for that password and
stores it encrypted just long enough for the worker to use it once.

The connection is read-only: it never marks anything read, never shows you as
online, and never sends. It appears in Telegram's own device list as
**steno-personal**, and removing it there revokes it here within a minute.
Disconnect does the same from this side and keeps everything already archived.

The worker needs Telegram API credentials. Until this project ships its own
registered pair, get one from https://my.telegram.org and set `TELEGRAM_API_ID`
and `TELEGRAM_API_HASH`. Without them the app still runs — the worker logs one
warning, skips Telegram, and no login code ever appears.

## Configuration

See `.env.example`. `DATA_DIR` holds the database, media, and WhatsApp auth
state. `SECRET_KEY` encrypts secrets at rest and is generated into the volume
if unset. Lost every key? `docker compose exec app npm run mint-key -- recovery`.

On Railway, attach a volume mounted at `/data` before the first deploy.
Without one, every redeploy discards the database and the secret key, so
every key you minted stops working and a new bootstrap key is printed in the
deploy log.

## Media and enrichment

Attachments are downloaded to `$DATA_DIR/media` and served from `/media/<id>`
behind your access key — an image appears inline in a transcript, a voice note
gets a player, anything else is a download link.

Enrichment is **off** until you save an OpenRouter key in Settings. With one
saved and a toggle on, images are read for the text in them and voice notes are
transcribed, and both become searchable alongside the message text. That upload
is the only thing that ever leaves your machine; the model picker names the
provider that receives it. Each analysed row records what it cost in
micro-dollars. `ANALYSIS_DAILY_LIMIT` (default 500) caps billed analyses per
rolling day and `ANALYSIS_BACKFILL_BATCH` (default 20) paces the backfill of
media you already have.

## Licence

AGPL-3.0. See LICENSE.
