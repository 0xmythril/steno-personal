# steno-personal

Your own Telegram and WhatsApp chats, archived read-only into one SQLite
file, readable by your agents over MCP. Self-hosted: one container, one
volume, no accounts.

**Status:** M2 (Telegram and WhatsApp live). Agent access over MCP in M3.

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

## Licence

AGPL-3.0. See LICENSE.
