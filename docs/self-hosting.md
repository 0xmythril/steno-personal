# Self-hosting

Three ways to run it: Docker (recommended), bare Node 24, or Railway. All three
end in the same place — one process tree, one directory of state.

## Before you start

- One instance is one person. There is no multi-user mode and adding one is a
  non-goal.
- `DATA_DIR` is the entire state. Wherever you run this, know where that
  directory is and back it up.
- The first boot prints an access key. That is your only way in, so read the log.

## Docker

```bash
git clone https://github.com/0xmythril/steno-personal.git
cd steno-personal
docker compose up -d
docker compose logs -f app
```

The shipped `docker-compose.yml` binds to `127.0.0.1:3000` on purpose: on a home
machine the portal should not be reachable from the network until you decide it
should be. Change the port mapping to `3000:3000` only together with a reverse
proxy and TLS.

Useful commands:

```bash
docker compose logs -f app                        # follow the log
docker compose exec app npm run mint-key -- laptop # recovery key
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
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`systemctl enable --now steno-personal`, then
`journalctl -u steno-personal -f` to find the bootstrap key.

## Railway

The one-click template in the README is the short path. If you would rather wire
it up yourself, or the template is not published yet:

1. Sign in to Railway. A new account created through
   <https://railway.com?referralCode=45_zFw> starts with $20 in credits; that is the
   maintainer's referral link, and using it is optional.
2. **New Project → Deploy from GitHub repo**, pick your fork.
3. Railway reads `railway.json`: Dockerfile build, healthcheck on `/api/health`
   with a 120 s timeout, restart on failure up to 10 times.
4. **Attach a volume** to the service with mount path `/data`. 5 GB is a
   sensible start; media is what grows.
5. Set variables: `DATA_DIR=/data`, and a `SECRET_KEY` of at least 32
   characters (`openssl rand -base64 48`). Railway supplies `PORT` itself.
6. Deploy, then **read the deploy log** for the bootstrap access key.
7. **Generate a domain** under Settings → Networking, open it, and log in.

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

```bash
cd steno-personal
git pull
docker compose up -d --build
```

Bare Node:

```bash
git pull
npm ci
npm run build
sudo systemctl restart steno-personal
```

**Migrations run at boot.** `scripts/boot.ts` applies any new migration before
the web app or the worker starts, so there is nothing to run by hand and no
window where a new build talks to an old schema. If a migration fails, boot
exits non-zero and the supervisor refuses to start the app — you get a broken
container with a readable error rather than a half-migrated database. Take a
backup before a major upgrade anyway; migrations are forward-only and there is
no down path.

Your access keys, connections, and archive survive an upgrade. Container
restarts do not re-print a bootstrap key: it is minted only when no active key
exists.

## Publishing the Railway template (maintainers)

The template exists, unpublished, as code `1Vhm3c` (editor:
<https://railway.com/workspace/templates/546731b9-54bf-467b-9d40-67f685511bb6>),
generated from the `steno-personal` project in the maintainer's workspace, and
the README button already points at it. What remains is the editor cleanup in
step 3 to 5, the verification in step 6, and publishing. This is the whole
procedure, kept for the day the template has to be rebuilt. It is manual on
purpose — Railway has no committed template manifest; a template is built in the
dashboard composer or generated from a live project, per
<https://docs.railway.com/templates/create>. Verify against that page before you
start, in case Railway has since shipped a file format.

**1. Build a working project first.** Follow the Railway section above and get a
real deploy green, with the volume attached and a bootstrap key in the log. A
template generated from something that works is worth more than one assembled
blind.

**2. Create the template.** Either

- dashboard: project **Settings → Generate Template from Project → Create
  Template**, then confirm the settings in the composer; or
- CLI: `railway templates create --project steno-personal --environment production`
  (`railway template` is an accepted alias; see <https://docs.railway.com/cli/templates>).

The CLI clones the project's variables verbatim. Do **not** set
`SECRET_KEY=${{secret(48)}}` on the live project first: Railway evaluates the
function there and stores the resulting string, so the clone would hand every
deployer the same secret. Leave `SECRET_KEY` off the project and add the
function in the template editor (step 4).

**3. Check the service in the composer.**

- Source: the GitHub repo `0xmythril/steno-personal`. To pin a branch, paste the
  full branch URL, e.g. `https://github.com/0xmythril/steno-personal/tree/main`.
- Build: Dockerfile — it should already be picked up from `railway.json`.
- Healthcheck path: `/api/health`.
- Public networking: HTTP, enabled.

**4. Set the variables.** Three fixed, plus the two Telegram credentials the
deployer fills in:

| Variable | Value | Why |
|---|---|---|
| `DATA_DIR` | `/data` | Matches the volume mount path below. |
| `SECRET_KEY` | `${{secret(48)}}` | A different random secret per deploy. `secret(length?, alphabet?)` is a Railway template variable function evaluated at deploy time; it defaults to 32 characters, and 48 comfortably clears the 32-character minimum. Docs: <https://docs.railway.com/templates/create> ("Template variable functions"). |
| `PORT` | `3000` | The supervisor passes it to Next. |
| `TELEGRAM_API_ID` | empty, deployer-supplied | The repo ships **no** working pair (`TELEGRAM_DEFAULT_API_ID` is `0`), so leave the value blank and let the deployer paste their own from my.telegram.org. Blank is a valid state: the worker warns once and runs without Telegram. |
| `TELEGRAM_API_HASH` | empty, deployer-supplied | Same; both are needed together before a Telegram QR appears. |

**5. Attach the volume.** Right-click the service in the composer → **Attach
Volume** → mount path `/data`. One volume, that path, nothing else — it must
match `DATA_DIR`. There is no volume block in `railway.json`; the volume belongs
to the template. Docs: <https://docs.railway.com/templates/create> ("Add a
volume") and <https://docs.railway.com/volumes>.

**6. Create the template**, then deploy it once yourself from a clean workspace
and confirm, in order:

- the build uses the Dockerfile and succeeds;
- the volume is mounted at `/data`;
- `SECRET_KEY` in the deployed service is a 48-character random string, not the
  literal `${{secret(48)}}`;
- the deploy log contains the bootstrap key banner with an `sp_…` key;
- the generated domain serves `/login`, and that key logs in;
- `/api/health` returns `{"ok":true}`;
- redeploying does **not** print a new key (the volume persisted).

That list is the exit criterion for M5: one click gives a running instance.

**7. Publish it.** Dashboard: **Workspace settings → Templates → Publish**, and
fill the form — category `Other`, a one-line description, and the overview
markdown. Or CLI:

```bash
railway templates publish <template-id> \
  --category Other \
  --description "Archive your own Telegram and WhatsApp chats to SQLite, read-only, for your agents" \
  --readme-file README.md
```

First publication requires `--readme-file` or `--readme`; `railway templates
update` replaces the metadata later. Docs:
<https://docs.railway.com/cli/templates>.

**8. Check the button.** The README button points at:

```
https://railway.com/new/template/1Vhm3c?referralCode=45_zFw&utm_medium=integration&utm_source=button&utm_campaign=steno-personal
```

If the template is ever recreated, its code changes and this URL must follow.

`45_zFw` is the maintainer's code from the workspace's referrals page
(<https://railway.com/account/referrals>): a signup through it gets $20 in
credits and the maintainer gets 15% of their first twelve months of invoices
under Railway's affiliate programme. The same link is offered, and labelled as
a referral, in the README and in the Railway steps above. That is separate from the template kickback,
which needs no code at all: once the template is on the marketplace you earn
15% of the usage it generates, 25% if you answer questions in your template
queue. Docs: <https://docs.railway.com/community/affiliate-program> and
<https://docs.railway.com/templates/kickbacks>.

The button image is `https://railway.com/button.svg`. Docs:
<https://docs.railway.com/templates/publish-and-share>.

**9. Re-run the invariant sweep.** `tests/launch-invariants.test.ts` asserts
that the README button carries a real template URL
(`toContain('railway.com/new/template/')`) and that no placeholder marker is
left in any shipped document. Keep it green.

## Troubleshooting

**No key in the log.** A key already exists — a bootstrap key is minted only
when there are none. Use `npm run mint-key -- recovery` inside the container.

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
