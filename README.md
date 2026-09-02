# steno-personal

Your own Telegram and WhatsApp chats, archived read-only into one SQLite
file, readable by your agents over MCP. Self-hosted: one container, one
volume, no accounts.

**Status:** M0 (scaffold). Channels arrive in M1 (Telegram) and M2 (WhatsApp).

## Quick start

```bash
docker compose up
```

The first boot prints an access key in the log. Open http://localhost:3000,
paste it, then go to Settings, create a key with a name, and revoke the
printed one so nothing usable stays in your log history.

## The WhatsApp risk, in one paragraph

WhatsApp connects as a linked device on your own number through an
unofficial client library. WhatsApp can restrict or ban numbers that use
unofficial clients, and recent phone builds show an "unofficial client"
notice under Linked devices. The risk is higher when this runs on a cloud
host than on a machine at home. You accept that risk on the consent screen
before pairing; nothing here can remove it.

## Configuration

See `.env.example`. `DATA_DIR` holds the database, media, and WhatsApp auth
state. `SECRET_KEY` encrypts secrets at rest and is generated into the volume
if unset. Lost every key? `docker compose exec app npm run mint-key -- recovery`.

## Licence

AGPL-3.0. See LICENSE.
