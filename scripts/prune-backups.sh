#!/bin/sh
# Remove old upgrade backups from .steno-updater/backups, keeping the newest N
# and the one the journal names. Backup files are root-owned, so this runs
# inside a container rather than asking for sudo; it needs Docker and nothing
# else, like enable-upgrades.sh. The checkout's own updater code is mounted
# read-only, so it works whichever companion build is installed.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
keep=${1:-}
case "$keep" in ''|*[!0-9]*|0) echo 'Usage: sh scripts/prune-backups.sh <keep> [--dry-run]' >&2; exit 2 ;; esac
case "${2:-}" in ''|--dry-run) ;; *) echo 'Usage: sh scripts/prune-backups.sh <keep> [--dry-run]' >&2; exit 2 ;; esac
[ -f .steno-updater/deployment.json ] || { echo 'Upgrades are not enabled in this checkout; nothing to prune.' >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo 'Install and start Docker, then rerun this command.' >&2; exit 1; }
docker run --rm --network none \
  --mount "type=bind,src=$PWD/updater,dst=/updater,readonly" \
  --mount "type=bind,src=$PWD/.steno-updater,dst=/state" \
  node:24-slim node /updater/prune.mjs --keep "$keep" ${2:+"$2"}
