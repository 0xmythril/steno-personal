#!/bin/sh
# Docker-only bootstrap. Render configuration on the host so shell variables,
# .env values, and the selected Docker context retain their original meaning.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
command -v docker >/dev/null 2>&1 || { echo 'Install and start Docker, then rerun this command.' >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo 'Docker Compose v2 is required.' >&2; exit 1; }
if [ -n "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}${COMPOSE_FILE:-}${COMPOSE_ENV_FILES:-}${COMPOSE_DISABLE_ENV_FILE:-}${COMPOSE_PATH_SEPARATOR:-}" ]; then
  echo 'Unset exported Docker/Compose connection and file overrides before setup. Select a local context with docker context use.' >&2
  exit 1
fi
endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
case "$endpoint" in unix://*) daemon_socket=${endpoint#unix://} ;; *) echo 'Setup requires a local Docker Unix socket.' >&2; exit 1 ;; esac
case "$(docker info --format '{{.OperatingSystem}}')" in *'Docker Desktop'*) daemon_socket=/var/run/docker.sock ;; esac
container_id=$(docker compose ps -a -q app 2>/dev/null) || { echo 'Could not read the Compose deployment. Check its configuration and try again.' >&2; exit 1; }
if [ -z "$container_id" ]; then echo 'Start Steno with docker compose up -d, then rerun setup.' >&2; exit 1; fi
project=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container_id")
case "$project" in ''|*[!a-z0-9_-]*) echo 'Could not identify a single Steno Compose project.' >&2; exit 1 ;; esac
echo 'Building the updater tools with Docker. Node.js is not required on this machine.'
docker build -f updater/Dockerfile -t steno-personal-updater:local .
updater_image=$(docker image inspect --format '{{.Id}}' steno-personal-updater:local)
umask 077
setup_input=$(mktemp -d "$PWD/.steno-updater-input-XXXXXX")
trap 'rm -rf -- "$setup_input"' EXIT HUP INT TERM
if ! docker compose config --format json > "$setup_input/config.json" 2>/dev/null; then
  echo 'Could not read Compose configuration. Check .env and the compose file; their contents have not been printed.' >&2
  exit 1
fi
printf '%s\n' "$container_id" > "$setup_input/container-id"
docker run --rm --init --name "$project-upgrade-setup" \
  --mount "type=bind,src=$daemon_socket,dst=/var/run/docker.sock" \
  --mount "type=bind,src=$PWD,dst=$PWD" --workdir "$PWD" \
  --env "STENO_SETUP_INPUT=$setup_input" --env "STENO_SETUP_IMAGE=$updater_image" \
  --env "STENO_SETUP_SOCKET=$daemon_socket" \
  "$updater_image" node /updater/install.mjs
