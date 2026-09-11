# Upgrades from Settings

The optional Docker companion lets an owner signed into the portal check for a
stable release and start an upgrade from **Settings → Software updates**. It
downloads the image, pauses Steno, backs up the archive, applies migrations,
and checks the web app and worker. A failed installation restores the previous
image and its matching backup. Upgrades within the current major version are
supported; major releases require the host operator to follow release notes.

This feature requires published release images. The release workflow publishes
them after its checks pass; adding the updater code alone does not publish an
image. Until a newer stable image is available, no upgrade can be completed.

## Enable on Docker

Run this once from your Steno checkout on the Docker host:

```bash
sh scripts/enable-upgrades.sh
```

Then refresh **Settings → Software updates** and choose **Check for updates**.
From then on, choose the offered version in Settings and confirm when you are
ready for a maintenance window. No host command is needed for each upgrade.

You need Docker with Compose v2 and a shell on Linux, macOS, or WSL. **Node.js is
not required on the host.** The script builds and runs its setup tools inside
Docker. Docker Desktop needs file sharing enabled for the checkout directory.
Use a local Unix-socket Docker context. Remote daemons and exported Docker or
Compose connection/file overrides are not supported by this setup command.

The running app must already be a release with **Software updates** in Settings,
using one named volume at `/data`, with both web and worker enabled. If your
installation predates this feature, follow [the existing upgrade instructions](self-hosting.md#upgrading)
once, preserving the volume and encryption key, before enabling it. Refresh the
checkout to that release too, so the setup script is available. Split services
and nested mounts below `/data` need a manual deployment.

Setup pins the running application image and the companion image, captures the
actual application environment, and briefly recreates the app to connect the
private updater socket. It does not change the application version, apply a new
schema, or replace your data volume. It waits for the app and companion to
respond before reporting success.

### Ordinary Docker commands keep working

After setup, keep using the commands you already know:

```bash
docker compose ps
docker compose logs --tail 100 updater
docker compose stop
docker compose up -d
```

A marked block in `.env` sets `COMPOSE_FILE` and `COMPOSE_PROJECT_NAME` so these
commands use the managed configuration and selected release. Existing `.env`
values are preserved, and the original file is copied privately to
`.steno-updater/env.before-upgrades`. Setup refuses symlinked environment/control
paths instead of replacing them. The control directory and any setup scratch
files are excluded from git and Docker build contexts.

Do not override `COMPOSE_FILE`, use `docker compose -f docker-compose.yml`, or
change the project name after setup: that bypasses the selected release. Builds
containing this feature refuse unknown or changed database migrations, but this
is not a guarantee that arbitrary application downgrades are safe.

**Already enabled upgrades with the old Node command?** Run the shell command
above once. It adds the normal Compose routing while retaining your selected
release, companion, backups, and data. The old `node scripts/upgrades.mjs compose`
commands remain supported as a compatibility path.

**Setup interrupted?** Run the same command again. Complete setup files are
published together; a retry keeps an existing release and the first environment
backup. If an upgrade or recovery is unfinished, setup refuses to proceed until
that operation finishes or the host operator recovers it. Do not run setup or
other Compose operations while an upgrade is active.

### Configuration and the companion

The selected image digest lives in `.steno-updater/release.json`. Application
configuration is captured in `.steno-updater/compose.json`. Later edits to the
original compose file or application variables in `.env` do not change that
snapshot: host operators edit the managed JSON and run `docker compose up -d`.
Environment values there escape literal dollar signs as `$$`, as required by
Compose. Preserve that escaping, the encryption key, volume mounts, and project
name. Back up the control directory before editing it; it contains secrets.

Do not run another app or worker against this volume or prune retained images.
The updater refuses to proceed when another running container mounts the data
volume. It cannot detect unrelated host processes writing directly to Docker's
volume storage.

The companion itself stays pinned. Updating it is a host operation: build a
reviewed companion version, update only the updater's image in the managed
configuration, and recreate that service while no upgrade is active. Repeating
setup does not silently upgrade or downgrade the installed companion.

## What happens after clicking Upgrade

1. The companion verifies the target is the latest published stable release
   and a newer version within the same major version. It pulls only the fixed
   project image from GHCR and pins the downloaded digest. It checks the
   version inside the image and available backup space.
2. It stops the app and worker with a 120-second grace period. Docker may kill
   them after that timeout; the stopped directory backup includes SQLite WAL
   files so SQLite can recover when reopened.
3. It archives the complete data volume and saves a manifest containing the
   previous image, deployment configuration and environment, including an
   externally supplied encryption key. A failed backup never installs the
   candidate release.
4. It starts the new image against the same volume, then recreates any
   service that shares the app container's network namespace (the WeChat
   sidecar from `compose.wechat.yaml`), since that service lost its network
   with the old container. A sidecar that fails to start does not roll the
   upgrade back. The existing boot script
   runs migrations first. Readiness requires database access and a recent
   heartbeat from the installed worker; channel pairing is not a requirement.
5. After repeated readiness checks succeed, it records success. If checks do
   not succeed within five minutes, it stops the app, restores the complete
   backup, and starts and verifies the old image.

The page polls the local app and reconnects after maintenance. While the app
is stopped it cannot show the companion's live progress. If it does not return,
inspect the companion logs and journal from the host. Closing the tab does not
cancel the upgrade. A second upgrade is refused while one is active.

The companion journals each stage outside the archive. After a companion
restart it recovers an interrupted transaction before accepting new requests.
If recovery fails, it records `recovery-required`, retains the backup, and
blocks further upgrades until the host operator restores the installation.

## Backups and recovery

Backups live in `.steno-updater/backups/<upgrade-id>/`, separate from the app
volume. Each contains `archive.tar.gz` and `manifest.json`. Keep copies off the
machine for disaster recovery; these local backups do not protect against disk
loss. They are never automatically deleted. Deleting the live data volume or
resetting Steno does not delete these backups. Allow space for the archive and
backup, and prune old backup directories yourself only after verifying the
current release and retaining a known good recovery point. Some backup files
are owned by root; use host administrator access to inspect or copy them.

The journal is `.steno-updater/journal.json`. If automatic recovery failed:

1. Stop both services with `docker compose stop`. Preserve the journal,
   backup, and the current data volume for diagnosis.
2. Choose the backup recorded by the journal. Verify its tar archive can be
   read before modifying the volume. Restore the **entire** archived directory
   to the original data volume while every writer is stopped, replacing its
   contents. Do not merge it into the failed release's files.
3. Restore the saved `compose` object from `manifest.json` as the managed
   `compose.json`, and set `services.app.image` in `release.json` to the
   manifest's `previous.image`. Preserve the original `SECRET_KEY`. The
   previous local image must still exist; record a retrievable release digest
   before relying on off-machine recovery of a locally built image.
4. Start only `app` with `docker compose up -d --no-deps app` and verify `/api/ready`, login,
   archive searches and connections. Once verified, archive the failed journal
   outside the control directory, remove the active `journal.json`, and start
   the companion. Never clear a journal to bypass an unfinished recovery.

A rollback returns data to the backup point. New messages collected after that
point may need to sync again, and channel providers can sometimes require
re-pairing a restored session. Retain the same hostname to preserve passkeys.

## Railway and other hosts

The existing Railway Dockerfile, startup command, health check and `/data`
volume remain supported. Leave `STENO_UPDATER_SOCKET` unset. Settings shows
guided upgrade instructions instead of an enabled upgrade button.

Back up the entire volume and preserve the service variables, particularly
`SECRET_KEY`. Deploy the chosen release through the platform with one active
writer to the volume. Verify readiness, login and syncing afterwards. If a
migration requires rollback, restore the matching volume backup and previous
release; a deployment rollback alone does not roll back SQLite.

There is no Railway API integration in this implementation. No Railway token
is requested or stored. Platform backup and deployment automation can be added
as a separate integration.

## Authority and network access

The button requires a portal session; bearer tokens are not accepted directly.
A key that can log into the portal can obtain a session and then initiate an
upgrade, so this is not an additional privilege boundary for those keys.
Enabling the companion grants upgrade authority to anyone who can access the
portal. Next.js Server Actions apply their same-origin checks to update requests.

The companion has Docker daemon access, which is effectively host control.
Installing it explicitly grants that authority. The web app only receives its
private Unix socket, which accepts status, release-check and upgrade requests
for this installation and the fixed project repository. No TCP port is exposed.
The app's access to that socket still authorizes installation of published
project code, so only enable it if that is appropriate for your host.

There are no scheduled update checks. Clicking **Check for updates** contacts
GitHub; clicking **Upgrade** checks again and downloads images through Docker
from GHCR and its delivery infrastructure. Those services see the host IP and
request timing, and the registry sees the selected image. No chats, account
identifiers, access keys or instance identifier are sent. To disable this capability, stop the companion and remove its service,
`STENO_UPDATER_SOCKET`, and the socket mount from the managed configuration.
Keep the `.env` routing block so future Compose commands retain the selected
application image. Reverting to the original compose file can reinstall older
code against a newer archive.
