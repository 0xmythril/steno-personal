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

Requirements: a local Docker Engine with a Unix socket, Docker Compose v2,
Node 24 on the host, the repository checkout, one running `app` service, and a
named volume mounted at `/data`. Both web and worker must be enabled. Remote
Docker contexts, nested mounts under `/data`, and split web/worker installations
are not supported. Docker
Desktop needs file sharing enabled for the repository directory.

First deploy a version containing this feature using the existing Docker
instructions, preserving your existing volume and `SECRET_KEY`. Back up first.
Wait for `/api/ready` to return HTTP 200, then run from the checkout:

```bash
node scripts/upgrades.mjs enable
```

The command builds and pins the companion image, captures your resolved Compose
configuration and environment in `.steno-updater/`, and recreates the app with
a private socket mount. It keeps the existing Compose project and data volume.
If enablement is interrupted after that directory is created, inspect it and
use the managed Compose command below to finish starting the services.

**After enabling, use the managed Compose command for lifecycle operations.**
The original compose file still points at your source build; using it directly
could reinstall older code against an upgraded database.
Builds containing this feature refuse to boot if the database journal contains
unknown or changed migrations. This guards schema downgrades, but it does not
make arbitrary application downgrades safe; retain the matching backup.

```bash
node scripts/upgrades.mjs compose ps
node scripts/upgrades.mjs compose logs --tail 100 updater
node scripts/upgrades.mjs compose stop
node scripts/upgrades.mjs compose up -d --no-build --pull never
```

The selected image digest lives in `.steno-updater/release.json`. Configuration
is a snapshot: later edits to the original compose file or `.env` do not apply
to the managed deployment. Host operators edit `.steno-updater/compose.json`
and run the managed command. Keep `DATA_DIR`, volume mounts, project name,
the updater mounts and the encryption key unchanged. Back up the control
directory before editing it. It contains secrets and must remain private.
Environment values in the snapshot escape literal dollar signs as `$$`, as
required by Compose. Preserve that escaping when editing a value.

Do not run another app or worker against this volume, prune retained images,
or run Compose operations while an upgrade is active. The updater refuses to
proceed when another running container mounts the data volume. It cannot detect
an unrelated host process writing to Docker's volume storage.

The companion itself is pinned and does not upgrade itself. Updating it is a
host operation: build a reviewed updater version, update only the updater's
image in the managed configuration, and recreate that service while no app
upgrade is active.

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
4. It starts the new image against the same volume. The existing boot script
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
loss. They are never automatically deleted. Allow space for the archive and
backup, and prune old backup directories yourself only after verifying the
current release and retaining a known good recovery point. Some backup files
are owned by root; use host administrator access to inspect or copy them.

The journal is `.steno-updater/journal.json`. If automatic recovery failed:

1. Stop both services with the managed Compose command. Preserve the journal,
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
4. Start only `app` using the managed command and verify `/api/ready`, login,
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
identifiers, access keys or instance identifier are sent. Disable the companion
and remove `STENO_UPDATER_SOCKET` and its mount to remove this capability.
