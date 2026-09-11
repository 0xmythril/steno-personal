# Self-hosting

Three ways to run it: Docker (recommended), bare Node 24, or Railway. All three
end in the same place — one process tree, one directory of state.

## Before you start

- One instance is one person. There is no multi-user mode and adding one is a
  non-goal.
- `DATA_DIR` is the entire state. Wherever you run this, know where that
  directory is and back it up.
- No key is printed to the log. The first visit to the portal is **Setup**:
  pair a channel, receive your first access key, save it. Whoever reaches a
  fresh instance first becomes its owner, so open it as soon as it is up.

## Docker

```bash
git clone https://github.com/0xmythril/steno-personal.git
cd steno-personal
docker compose up -d
docker compose logs -f app
```

The same stable release images are mirrored to Docker Hub for environments
that consume prebuilt images. See [Docker Hub images](docker-hub.md) for tags,
architectures, and signature verification. Keep the Compose checkout when you
want the in-app upgrade setup; it supplies the deployment metadata and
persistent volume configuration the companion needs.

The shipped `docker-compose.yml` binds to `127.0.0.1:3000` on purpose: on a home
machine the portal should not be reachable from the network until you decide it
should be. Change the port mapping to `3000:3000` only together with a reverse
proxy and TLS.

Useful commands:

```bash
docker compose logs -f app                        # follow the log
docker compose exec app npm run mint-key -- laptop # emergency key (see Lost access)
docker compose down                                # stop, keep data
docker compose down -v                             # stop, destroy data
```

To pin a `SECRET_KEY` yourself instead of letting one be generated into the
volume, add it to the `environment:` block or an `.env` file next to the compose
file. It must be at least 32 characters. Generate one with:

```bash
openssl rand -base64 48
```

## Bare Node 24

No Docker, no root. Good on a Mac mini or a home server you already manage.

```bash
git clone https://github.com/0xmythril/steno-personal.git
cd steno-personal
nvm use            # reads .nvmrc: Node 24
npm ci
export NEXT_TELEMETRY_DISABLED=1   # Next.js's own build statistics, off
npm run build

export DATA_DIR="$HOME/.steno-personal"
export PORT=3000
npm start          # scripts/start.mjs: boot, then web + worker
```

`npm start` is the supervisor. Do not run `next start` on its own — you would
get the portal with no worker, so nothing would ever be archived.

Building needs a toolchain for `better-sqlite3`'s native module: on Debian and
Ubuntu `python3 make g++`, on macOS the Xcode command line tools.

To keep it running, a systemd unit:

```ini
[Unit]
Description=steno-personal
After=network-online.target

[Service]
Type=simple
User=steno
WorkingDirectory=/opt/steno-personal
Environment=DATA_DIR=/var/lib/steno-personal
Environment=PORT=3000
Environment=NODE_ENV=production
Environment=NEXT_TELEMETRY_DISABLED=1
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`systemctl enable --now steno-personal`, then open the portal to set it up;
`journalctl -u steno-personal -f` follows the log.

## Railway

The one-click template in the README is the short path. If you would rather wire
it up yourself, or the template is not published yet:

1. Sign in to Railway. A new account created through
   <https://railway.com?referralCode=45_zFw> starts with credits; that is the
   maintainer's referral link, and using it is optional.
2. **New Project → Deploy from GitHub repo**, pick your fork.
3. Railway reads `railway.json`: Dockerfile build, healthcheck on `/api/health`
   with a 120 s timeout, restart on failure up to 10 times.
4. **Attach a volume** to the service with mount path `/data`. 5 GB is a
   sensible start; media is what grows.
5. Set variables: `DATA_DIR=/data`, and a `SECRET_KEY` of at least 32
   characters (`openssl rand -base64 48`). Railway supplies `PORT` itself.
6. Deploy, and **generate a domain** under Settings → Networking.
7. Open the domain straight away: it lands on **Setup**. Pair a channel and
   save the access key it hands you.

Two Railway details worth knowing, both from
<https://docs.railway.com/volumes>: volumes are mounted only when the container
starts — not at build time and not during a pre-deploy command — which is why
migrations run inside the start command rather than a pre-deploy hook. And
volumes are mounted as `root`; our image runs as root, so no `RAILWAY_RUN_UID`
is needed.

If you pick Railway's smallest plan (512 MB of memory), know that `/media/[id]`
reads the whole attachment into memory before it streams a response — there is
no `Range` support, so a large voice note or video is re-fetched and re-read in
full on every request, not resumed or partially served. `MAX_MEDIA_BYTES` caps
any single file at 100 MiB, but several concurrent requests for large files on a
512 MB instance can still add up. If you archive a chat with large media and run
on a small instance, size up rather than watch it OOM.

Re-read the WhatsApp paragraph in the README before pairing WhatsApp on a cloud
host. Telegram is fine there.

## Configuration

Every variable is optional; empty means unset. The README carries the short list
most people touch; this is all of them.

| Variable | Default | What it does |
|---|---|---|
| `DATA_DIR` | `./data`; `/data` in Docker | Where everything lives: the SQLite file, downloaded media, WhatsApp auth state, and the generated secret key. |
| `PORT` | `3000` | Port the portal and MCP endpoint listen on. |
| `SECRET_KEY` | generated | Encrypts your OpenRouter key, your revealable access keys, and the Telegram session at rest. If unset, one is generated into `$DATA_DIR/secret.key` on first boot. Set it yourself and the file is not used. **Changing or losing it makes those encrypted values unreadable** — you re-pair the channels and re-enter the OpenRouter key; your messages are unaffected. |
| `TELEGRAM_API_ID` | the project's own | Telegram application id. The project ships a registered pair, so leave it unset unless you registered your own at <https://my.telegram.org>. `0` runs without Telegram: every page that could pair it shows **Not available** and says so, and the worker logs one warning. |
| `STELE_WECHAT_URL` | unset | Optional Stele origin: HTTPS, or HTTP on loopback. Set with the read token file; see [WeChat through Stele](#wechat-through-stele). |
| `STELE_WECHAT_READ_TOKEN_FILE` | unset | Absolute path to a private regular file containing Stele's read credential, available to web and worker. |
| `STELE_WECHAT_LOGIN_TOKEN_FILE` | unset | Absolute path to a separate private login credential file; enables owner QR pairing in Connections. |
| `TELEGRAM_API_HASH` | the project's own | Telegram application hash, from the same page. Set both together or neither. |
| `ANALYSIS_DAILY_LIMIT` | `500` | Images plus voice notes sent for enrichment per day. A ceiling, not an exact quota: the count is taken once per pass, before either medium runs, so a pass starting just under the limit can still drain a full batch of each — worst case `2 × ANALYSIS_BACKFILL_BATCH − 1` rows beyond it. `0` disables enrichment entirely. |
| `ANALYSIS_BACKFILL_BATCH` | `20` | How many old attachments are enriched per pass, so a backfill does not spend the day's budget at once. |
| `LOG_LEVEL` | `info` | Exactly one of `trace`, `debug`, `info`, `warn`, `error`, `silent` — any other value fails validation at boot and the container will not start. Logs carry counts and kinds, never chat text, names, numbers, or your search queries — at any level. |
| `RUN_WEB` | on | Set to exactly `false` to run only the worker in this container. |
| `RUN_WORKER` | on | Set to exactly `false` to run only the portal in this container. |
| `STENO_POSTHOG_KEY` | the project's token | The PostHog project anonymous usage events are sent to. It is PostHog's write-only client token, shipped in the build as every PostHog client's is; a fork sets its own. It is **not** the off switch — that is the **Anonymous usage** box in Settings, or `DO_NOT_TRACK=1`. See [What leaves your machine](../PRIVACY.md#what-leaves-your-machine). |
| `STENO_POSTHOG_HOST` | `https://us.i.posthog.com` | PostHog ingest host. Set the EU host if your project lives there. |
| `DO_NOT_TRACK` | unset | Set to `1` and no usage event is ever sent, whatever Settings says. The same variable GitHub CLI and other tools honour. |
| `NEXT_TELEMETRY_DISABLED` | `1` in Docker, unset otherwise | Read by Next.js, not by this project: without it, `next build` and `next dev` report anonymous build statistics to Vercel. The Docker image sets it; set it yourself when you build from source. |
| `STENO_UPDATER_SOCKET` | unset | Absolute Unix socket path for the optional Docker companion. The host installer sets it; leave unset on Railway. See [upgrades](upgrades.md). |
| `STENO_MINT_KEY` | unset | Set to a label (say `laptop`) and restart: boot mints an access key with that label and prints it **once** in the boot log, then remembers the value in `$DATA_DIR/boot-ops.json` so a restart with it still set prints nothing. For when every key is lost and you cannot pair the same phone again. Remove it afterwards. See [Lost access](#lost-access). |
| `STENO_RESET` | unset | Set to any word and restart: boot empties `DATA_DIR` — database, media, WhatsApp auth state, generated secret — once for that word, and the next visit starts setup from scratch. Unlink **steno-personal** on your phone yourself afterwards; a reset cannot reach the phone. |

**The one optional third party.** Image text extraction and voice-note
transcription are off until you save an OpenRouter key in **Settings**. Once you
do, the attachments you enabled are sent to OpenRouter to be read, and the text
comes back into your search index. Leave the key blank and nothing ever leaves
your machine. Per-item cost is recorded so you can see what it spent.

Where to set one: Railway — the service's **Variables** tab. Docker Compose —
the `environment:` block or an `.env` file next to the compose file. Bare Node —
your shell, or an `Environment=` line in the systemd unit. `.env.example` in the
repo lists the same set with the same defaults.

## Behind a reverse proxy

The session cookie is issued with the `Secure` flag **only when the request
arrived over HTTPS**, and behind a proxy the app learns that from the
`X-Forwarded-Proto` header. If your proxy does not set it, you get a cookie
without `Secure` on an HTTPS site — a downgrade nobody will notice until it
matters. Just as important the other way: make sure your proxy strips any
`X-Forwarded-Proto` a client sent and always sets its own — the app trusts
whatever value it sees on that header, so a proxy that passes a client-supplied
one through unchanged lets a client claim `https` for a plain HTTP hop. Railway
sets it correctly for you. On your own proxy, set it yourself and strip
client-supplied values.

The same two headers, `Host` (or `X-Forwarded-Host`) and `X-Forwarded-Proto`,
decide the passkey relying party. A wrong host makes every passkey prompt fail
with "not accepted", and on a plain-http LAN address such as
`http://192.168.1.20:3000` the browser offers no passkey at all: put a hostname
and TLS in front, and the button appears.

nginx:

```nginx
server {
  listen 443 ssl;
  server_name steno.example.com;

  location / {
    proxy_pass         http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Forwarded-Proto $scheme;   # required for a Secure cookie
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   Upgrade           $http_upgrade;
    proxy_set_header   Connection        "upgrade";
    proxy_read_timeout 300s;                        # MCP streams stay open
  }
}
```

`proxy_set_header X-Forwarded-Proto $scheme;` both sets and overwrites the
header — nginx does not append here, so a client-sent value is already replaced.
Confirm the same is true of any proxy you use.

Caddy sets `X-Forwarded-Proto` automatically:

```
steno.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Traefik does too, via `X-Forwarded-*`, provided the entrypoint is the TLS one.

Check it after you set it up: log in, then look at the cookie in your browser's
devtools. `sp_session` must show `Secure` and `HttpOnly`.

The long `proxy_read_timeout` is for the MCP transport, which holds a response
open. A 60-second default will make an agent's connection drop mid-conversation.

## Pushing conversations in

Telegram and WhatsApp arrive live. Anything else — a Slack workspace an agent
can already read, an exported chat, an agent's own transcript — is pushed:
something you run posts a batch to your instance under a **push key**.

In **Settings**, turn on **Advanced mode** and confirm the explanation.
Then mint a key and tick **Push**. Leave **Read** unticked for a
cron job — a key that only pushes cannot log in or read anything — and tick
both for an agent that searches and also stores its own transcript. Keep
the key out of the command line — a key on argv shows up in `ps` for any
other user on the box and sits in plain text in your shell history or
crontab. Put it in a curl config file instead:

```
# ~/.steno-push.curlrc, mode 0600
header = "Authorization: Bearer sp_YOUR_PUSH_KEY"
```

```bash
chmod 600 ~/.steno-push.curlrc
curl -sS -K "$HOME/.steno-push.curlrc" -X POST "https://<your-host>/api/import" \
  -H "Content-Type: application/json" \
  --data @batch.json
```

`batch.json`:

```json
{
  "format": "steno/1",
  "source": { "type": "slack", "id": "acme", "label": "Slack (Acme)" },
  "messages": [
    {
      "externalChatId": "C0123ABC",
      "chatKind": "group",
      "chatTitle": "#eng",
      "externalMessageId": "1725500000.000100",
      "senderExternalId": "U0AB12",
      "senderName": "Ada",
      "fromOwner": false,
      "sentAt": "2026-09-05T10:00:00Z",
      "type": "text",
      "text": "the vendor agreed to net 30"
    }
  ],
  "deletes": []
}
```

- `source.type` and `source.id` are lowercase slugs (`^[a-z][a-z0-9-]{1,31}$`);
  together they name the source, and every later batch for the same pair
  lands in the same place. `label` is what the portal shows.
- Message identity is `externalChatId` plus `externalMessageId`. Resending is
  safe: a message already stored is counted as a duplicate and left alone, so
  a cron job can post the last hour every ten minutes. Set `editedAt` on a
  resent message to update its text. Steno stores the source's edit timestamp
  and only accepts a strictly newer edit; older or equal timestamps count as
  duplicates without changing the message. A `deletes` entry removes a message from
  every read for good.
  Any push key may push to any source, and every message remembers which key
  delivered it. If two keys push the same message with different text, the
  first version stays and the response counts the disagreement under
  `conflicts`, naming up to twenty. A pushed source may not call itself
  `telegram` or `whatsapp`; those names mean a paired account. Use
  `whatsapp-export` or similar.
- `replyToExternalId` names the message this one answers, in the same chat.
  `type` is `text` unless you say otherwise; `raw` is any object you want kept
  with the message (64 KiB).
- Limits: 1 000 messages and 1 000 deletes per batch, 8 MiB per request,
  64 KiB of text per message. Attachments are not accepted yet; steno never
  fetches a URL on your behalf.
- The response counts `inserted`, `duplicates`, `edited`, `deleted` and
  `conflicts`, and returns the source's id. `400` lists what was wrong;
  nothing is written from a batch that fails validation.

A cron line that pushes whatever an agent left in `~/slack/latest.json`, using
the same `~/.steno-push.curlrc` — a key in the crontab itself is just as
readable (by anyone who can run `crontab -l` for that user) as one on argv:

```
*/10 * * * * curl -sS -K "$HOME/.steno-push.curlrc" -X POST "https://<your-host>/api/import" -H "Content-Type: application/json" --data @"$HOME/slack/latest.json" >/dev/null
```

Everything pushed is read back exactly like the live channels: in the portal,
over `/api` and in every MCP tool's results, including their own `channel`
filter (any source type now, not only the two live channels) and a
`source_id` filter — the source's id, the same one `whoami` reports — to
stay inside one source.

Running from an agent rather than a cron job? `push_messages` takes the same
batch, minus `format`, as an MCP tool on its own endpoint, `/mcp/push`; a key
minted with Push authenticates there the same way, as a bearer token. See
[docs/mcp.md](mcp.md).

The Connections page lists every pushed source under **Sources**: its label,
who created it, every key that has pushed to it, how many messages it holds,
when it was last pushed and how many conflicts that push reported. Deleting
one there erases everything it carries; the keys that pushed it keep
working. In Settings, revoking a key stops it without touching what it
already pushed — **Revoke and delete what it pushed** removes both, key and
messages, in the same step, and takes with it any pushed source that key fed
alone; a source another key also feeds stays.

## Backups

Everything is `DATA_DIR`. Copy it and you have copied the instance.

The database is SQLite in WAL mode, so a copy taken while the app is writing can
be a moment behind. Stop the container for the few seconds it takes:

```bash
docker compose stop app
docker run --rm -v steno-personal_data:/data -v "$PWD:/backup" \
  busybox tar czf /backup/steno-$(date +%F).tar.gz -C /data .
docker compose start app
```

Bare Node:

```bash
sudo systemctl stop steno-personal
tar czf ~/steno-$(date +%F).tar.gz -C /var/lib/steno-personal .
sudo systemctl start steno-personal
```

Restore by stopping the app, emptying `DATA_DIR`, extracting the archive into
it, and starting again. Same `SECRET_KEY` or the encrypted values (Telegram
session, OpenRouter key, revealable access keys) will not decrypt — if you let
the key be generated, `secret.key` is inside the backup and you are fine.

On Railway, use `railway volume browse /` for an interactive look or
`railway volume files download /steno.db ./steno.db` for a single file, and turn
on Railway's own volume backups in the volume's settings.

A backup contains every message in every chat you have archived. Store it
accordingly.

## Upgrading

For the optional **Upgrade** button in Settings, see [upgrades.md](upgrades.md).
Enable it once with `sh scripts/enable-upgrades.sh` (Docker and a shell only).
After setup, ordinary `docker compose` commands use the selected release; use
Settings for future upgrades instead of the source-build commands below. Railway continues to use its existing Docker deployment.

Back up the complete data directory and preserve `SECRET_KEY` before every
upgrade, including minor releases with migrations.

```bash
cd steno-personal
git pull
docker compose up -d --build
```

Bare Node:

```bash
git pull
npm ci
NEXT_TELEMETRY_DISABLED=1 npm run build
sudo systemctl restart steno-personal
```

**Migrations run at boot.** `scripts/boot.ts` applies any new migration before
the web app or the worker starts, so there is nothing to run by hand and no
window where a new build talks to an old schema. If a migration fails, boot
exits non-zero and the supervisor refuses to start the app — you get a broken
container with a readable error rather than a half-migrated database. Take a
backup before every upgrade; migrations are forward-only and there is
no down path.

Your access keys, connections, and archive survive an upgrade. No key is ever
printed to the log on a restart unless you asked for one with
`STENO_MINT_KEY` (below).

## Lost access

Three situations, three answers. None of them run through the web portal, on
purpose: nothing reachable from the network can hand out a key or wipe an
instance. The first is self-service; the other two are for whoever runs the
host, because the host is what proves you are allowed to do them.

A passkey is bound to the hostname it was registered on. Move the instance to
a new domain, or restore a backup somewhere else, and existing passkeys stop
matching: log in with a key and register again from Settings. A security key
needs a PIN set, because user verification is required. A passkey never
substitutes for a key in what follows — recovery and the host mint keys.

**Lost the key, still have the account.** Open `/login` and choose **Pair your
phone again**. Pairing the same Telegram account or WhatsApp number this archive
reads — now or at any time in the past — proves it is yours: a new key is
created and shown once, exactly like the first one. The pairing device is
unlinked again the moment the account is confirmed; nothing is read from it.
Someone who pairs a different account is told so, unlinked, and given nothing —
you will see their attempt under **Past connections**.

**Lost the key and the account, want to keep the archive.** Mint a key from the
host. Set the variable `STENO_MINT_KEY` to a label, say `laptop`, and restart:
boot mints a key with that label and prints it **once** in the boot log —

```
==========================================================
  steno-personal: access key "laptop"
  sp_…
  Paste it at /login. Remove STENO_MINT_KEY now; this banner
  will not print again for this value.
==========================================================
```

— then remembers the value in `$DATA_DIR/boot-ops.json`, so a restart with the
variable still set prints nothing. Paste the key at `/login`, remove the
variable, and revoke that key under **Settings** once you have made your own:
it is sitting in a log. With a shell you can skip the variable:
`docker compose exec app npm run mint-key -- laptop`, or on Railway
`railway ssh` then `npm run mint-key -- laptop`.

**Start over.** Set `STENO_RESET` to any word and restart: boot empties
`DATA_DIR` — database, media, WhatsApp auth state, the generated secret — once
for that word, records the word, and the next visit lands on **Setup**. A
reset cannot reach your phone: open Telegram → Settings → Devices and WhatsApp →
Linked devices and remove **steno-personal** yourself. The native equivalents
do the same thing: `docker compose down -v`, wiping or recreating the Railway
volume from its settings, or stopping the service and deleting `DATA_DIR` on
bare Node.

Where to set a variable: Railway — the service's **Variables** tab (a change
redeploys automatically). Docker Compose — the `environment:` block or an
`.env` file next to the compose file, then `docker compose up -d`. systemd — an
`Environment=` line in the unit, then `systemctl restart`. Remove it afterwards
either way; leaving it set is harmless but untidy.

## Publishing the Railway template

Maintainer work, kept in [releasing.md](releasing.md#the-railway-template) so
this page stays about running an instance.

## Troubleshooting

**No key in the log.** That is normal: the log never carries a key unless you
set `STENO_MINT_KEY`. A fresh instance hands its first key out on `/setup`; a
locked-out one is recovered from `/login` or from the host — see Lost access.

**`/setup` says the instance already has an owner.** A key exists, so Setup is
closed. Log in with a key, or recover from `/login`.

**"secret key mismatch" after a restore.** `SECRET_KEY` differs from the one the
data was encrypted with. Restore `secret.key` from the backup, or set the same
value you had; the messages are unaffected but the channels must be re-paired.

**The cookie is not `Secure` behind my proxy.** The proxy is not sending
`X-Forwarded-Proto: https`. See the reverse proxy section.

**The container restarts in a loop on Railway.** Read the deploy log for the
`[boot] failed:` line. The usual causes are a missing volume (so `DATA_DIR` is
not writable) or a `SECRET_KEY` shorter than 32 characters.

**WhatsApp keeps disconnecting.** Its linked-device session ends if the phone is
offline for a long stretch, and it ends immediately if you unlink from the
phone. Re-pair from Connections. Repeated forced logouts can also be the first
sign of a restriction — see the WhatsApp paragraph in the README.

### Advanced mode

Settings starts with Advanced mode off. Turn it on and confirm the explanation
to show push-key creation, agent write configuration, source management, chat
export, dispute resolution, and contribution removal controls. The preference is saved for this instance.
Turning it off hides those controls without revoking keys, stopping imports, or
removing archived conversations. Existing keys can still be revoked in Settings.
History, its filters and CSV export, and disputed-version comparisons remain
available in either mode. Resolving disputes and removing contributions requires
revealing the controls with Advanced mode. Recording continues while it is off.
Advanced mode is a UI preference, not an API permission or a write kill switch.


## Reviewing archive History

Open **History** for Activity, Disputes and Revoked keys. Activity filters and CSV dates use UTC. Source summaries describe retained events in the chosen period; they are not lifetime totals. Metadata recording begins on the first boot with History enabled; previous activity and previously discarded conflicting text cannot be reconstructed. The worker maintains retention even when no channel is connected. Run one worker per archive, as the supplied supervisor does: on worker startup unfinished sync runs are marked interrupted.

The last pusher shown in Chats is recorded by future pushes affecting that chat; older unknown values are left blank. A source creator is distinct from its subsequent pushers.

Push ingestion is now atomic, retaining the existing `steno/1` counts and timestamp ordering. `duplicates` includes conflicts and edited existing rows; do not add those counts as disjoint totals. An HTTP `409` with `dispute_capacity` means pending review storage is full and nothing from that batch was saved. Review disputes, then retry. MCP push reports the same condition in its tool error. Limits: 10,000 pending candidates and 512 MiB of incoming text, independent of activity’s 90-day/10,000-event retention. No extra service, credential or environment variable is required.

History and its CSV export require an owner portal session. API/MCP keys continue to read only normal archive content. See [Privacy](../PRIVACY.md#local-history) for recording coverage, retained deletion metadata and key-cleanup semantics.

## WeChat through Stele

WeChat is read through [Stele](https://github.com/0xmythril/stele), a separate
service that runs Tencent's official Linux client and exposes what it captures
over a private API. Steno never runs a WeChat library itself; the only file that
contacts Stele is `lib/channels/stele-client.ts`. This is experimental: text
only, history coverage depends on what the official client exposes, and Stele
itself notes that ordinary DMs and incoming group messages are still gated.

**It needs a Linux amd64 Docker host.** Stele builds the official client for
that platform and reads its memory with `SYS_PTRACE`, so Railway and most
managed container platforms cannot run it. Linking WeChat to an unofficial
reader can affect your account; only link your own.

### One command, on the Docker Compose deployment

From the checkout, with Steno already running and set up:

```bash
sh scripts/enable-wechat.sh
```

It builds the Stele sidecar from a pinned revision (the first build downloads
and checksum-verifies the WeChat client and takes several minutes), starts it
inside the app container's network namespace, mints Steno a read credential
and a separate read-and-login credential inside Stele, copies them into
`.steno-wechat/` with mode 0600, and routes Compose through
`compose.wechat.yaml` by writing a marked block into `.env`. Rerunning it is
safe. Then open **Connections**, choose **Connect WeChat**, scan the QR with
your phone, and read the history-sync prompt on the phone before confirming:
what you choose there bounds what Steno can ever import.

Two consequences of the sidecar design:

- The sidecar shares the app container's loopback, so Stele's API is reachable
  only from inside Steno. Nothing is exposed on the host or your network.
  Stele's own recipe uses host networking and an SSH tunnel instead; its
  preflight script expects that and is not used here.
- When the app container is recreated, the sidecar loses its network until it
  is recreated too. `docker compose up -d` does that, and upgrades started
  from Settings do it themselves. If the WeChat card says capture is
  unavailable after a restart, run `docker compose up -d`.

Enable WeChat **before** enabling upgrades from Settings. Upgrade setup
snapshots the Compose configuration, and the script refuses to run once
`.steno-updater/` exists; on an installation that already has upgrades, add
the `stele` service and the `app` additions from `compose.wechat.yaml` to
`.steno-updater/compose.json` by hand, then `docker compose up -d`.

Stele's operator commands work through Compose, for example:

```bash
docker compose exec stele node channels/wechat/src/cli.ts status /data/collector/config.json
docker compose logs --tail 100 stele
```

Stele deliberately does not restart itself after the official client dies;
look at its log, then `docker compose up -d stele`. Its two volumes,
`stele-collector` and `stele-client`, hold the WeChat session and Stele's
own state. Steno's upgrade backups do not include them; back them up with
the same care as `DATA_DIR` if you want to survive a disk loss without
re-linking. The pinned Stele revision is `STELE_REF` at the top of the
script; set `STELE_SOURCE=/path/to/stele` to build from a local checkout.

### Stele somewhere else

If Stele runs on another host or outside Compose, configure Steno by hand:

1. Run Stele following its own guides and mint two credentials there:
   `steno-reader` with scope `read` and `steno-login` with `read,login`. Keep
   its API private; do not reuse Steno access keys for these credentials.
2. Copy each credential into a separate regular file readable by the Steno
   service user: mode `0600`, absolute path, no symlinks or hard links, at
   least 32 characters. Never commit these files.
3. Give Steno a private route. Steno accepts `https://` anywhere, or `http://`
   only on loopback (`127.0.0.1`, `localhost`, `[::1]`). A Steno container's
   loopback is not the host's: run an SSH tunnel in Steno's network namespace,
   or put a private HTTPS proxy in front of Stele. No redirect is followed.
4. Set the three `STELE_WECHAT_*` variables from the Configuration table and
   restart web and worker. Mount the read file into both processes and the
   login file into the web process; the worker does not use the login
   credential.

| Variable | What it is |
|---|---|
| `STELE_WECHAT_URL` | Origin only: no path, query or embedded credentials. |
| `STELE_WECHAT_READ_TOKEN_FILE` | Absolute path to the read credential file, for web and worker. |
| `STELE_WECHAT_LOGIN_TOKEN_FILE` | Absolute path to the login credential file; enables the QR button. |

### What happens after you scan

The browser receives only temporary PNG QR frames over its authenticated Steno
connection, each valid for at most ten seconds; it never receives the Stele
credentials or endpoint. Login success arrives before capture is ready: the
WeChat card moves from *starting* to *scanning* to *Stele can read messages*.

The worker then bootstraps through a checkpoint, replays changes, and commits
message changes and the resume cursor together in one transaction. Restarts
resume from the encrypted connection state. An expired cursor triggers a
baseline rebuild scoped to this connection. Known deletions remain terminal,
including during rebuilding. Initial baselines are bounded to 50,000 messages
and 10,000 pages; larger sources fail without publishing a partial baseline.
*Last imported* is the last completed checkpoint, not a guarantee that capture
is current; the card warns when it is more than two minutes old.

Current scope is text only. Contacts and person matching, media, and upstream
recall capture are unavailable; a recall in WeChat may remain in the archive.
WeChat cannot establish Steno's first owner or recover lost Steno access.
Disconnecting the importer keeps archived messages and does not unlink the
shared Stele device; manage that device in WeChat. A different account or
dataset requires deliberately disconnecting and reconnecting; existing archives
are not silently repurposed.

No live pairing is part of the integration checks yet. The first real run
should validate pairing, a restart, and an upgrade with the sidecar attached.
