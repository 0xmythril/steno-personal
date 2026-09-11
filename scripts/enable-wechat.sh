#!/bin/sh
# One-command WeChat setup for the Docker Compose deployment. Builds the Stele
# sidecar from a pinned source revision, starts it in the app's network
# namespace, mints Steno's two Stele credentials, and points the app at them.
# Needs Docker and a shell on a Linux amd64 host; nothing else. Re-running is
# safe: existing images, volumes and credentials are kept.
#
# Stele's own recipe uses host networking and an SSH tunnel; this one keeps
# the API inside the Compose project instead. See docs/self-hosting.md.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"

# The Stele revision this checkout was written against. Bump deliberately.
STELE_REPO=${STELE_REPO:-https://github.com/0xmythril/stele.git}
STELE_REF=${STELE_REF:-3bf1359377f58c19e3a950c718eec189003d1a54}
# A local Stele checkout overrides the git build context (private repository,
# offline host, or a patched build).
STELE_SOURCE=${STELE_SOURCE:-}
BEGIN='# BEGIN STENO WECHAT'
END='# END STENO WECHAT'

fail() { echo "$1" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || fail 'Install and start Docker, then rerun this command.'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is required.'
[ "$(docker info --format '{{.OSType}}')" = linux ] || fail 'The WeChat sidecar runs Linux containers only.'
case "$(docker info --format '{{.Architecture}}')" in x86_64|amd64) ;; *) fail 'The WeChat sidecar needs a Linux amd64 Docker host; Stele builds Tencent'\''s official client for that platform only.' ;; esac
[ -d .steno-updater ] && fail 'Upgrades from Settings are enabled, and they snapshot the Compose configuration. Enable WeChat before enabling upgrades, or add the services in compose.wechat.yaml to .steno-updater/compose.json by hand; see docs/self-hosting.md.'
if [ -f .env ] && grep -v -x -F -e "$BEGIN" -e "$END" .env | grep -q '^COMPOSE_FILE='; then
  fail '.env already sets COMPOSE_FILE. Remove that line or add compose.wechat.yaml to it yourself, then rerun.'
fi
if [ -n "$STELE_SOURCE" ]; then
  [ -f "$STELE_SOURCE/channels/wechat/container/runtime.Dockerfile" ] || fail "STELE_SOURCE=$STELE_SOURCE is not a Stele checkout."
  context=$STELE_SOURCE
else
  context="$STELE_REPO#$STELE_REF"
fi

echo 'Building the Stele sidecar. The first build downloads and verifies the official WeChat client; allow several minutes.'
docker build -f channels/wechat/container/client.Dockerfile -t stele-client:local "$context"
docker build -f channels/wechat/container/runtime.Dockerfile \
  --build-arg STELE_CLIENT_IMAGE=stele-client:local --build-arg "STELE_RELEASE=$STELE_REF" \
  -t stele-wechat:local "$context"

umask 077
mkdir -p .steno-wechat
chmod 700 .steno-wechat
# Route Compose through the overlay. One authoritative block; rerunning replaces it.
touch .env
if grep -q -x -F "$BEGIN" .env; then
  tmp=$(mktemp .env.XXXXXX)
  awk -v b="$BEGIN" -v e="$END" '$0==b{skip=1} !skip{print} $0==e{skip=0}' .env > "$tmp"
  cat "$tmp" > .env && rm -f "$tmp"
fi
[ -s .env ] && [ "$(tail -c1 .env | od -An -c | tr -d ' ')" != '\n' ] && printf '\n' >> .env
printf '%s\n# Written by scripts/enable-wechat.sh; rerun it rather than editing.\nCOMPOSE_FILE=docker-compose.yml:compose.wechat.yaml\n%s\n' "$BEGIN" "$END" >> .env

echo 'Starting Steno with the sidecar attached.'
docker compose up -d
echo 'Waiting for the Stele API.'
attempt=0
until docker compose exec -T stele node channels/wechat/src/cli.ts status /data/collector/config.json >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || fail 'Stele did not answer within two minutes. Check: docker compose logs --tail 100 stele'
  sleep 2
done

# Two credentials, issued inside Stele's private volume, copied out once, then
# removed there. Stele keeps only hashes. The read token serves the importer;
# the login token also lets the owner open the QR stream from Connections.
mint() { # id scopes file
  if [ -s ".steno-wechat/$3" ]; then return; fi
  docker compose exec -T stele node channels/wechat/src/cli.ts credential-revoke /data/collector/config.json "$1" >/dev/null 2>&1 || true
  docker compose exec -T stele node channels/wechat/src/cli.ts credential-add /data/collector/config.json "$1" "$2" "/data/collector/$1.token" >/dev/null
  docker compose cp "stele:/data/collector/$1.token" ".steno-wechat/$3" >/dev/null
  chmod 600 ".steno-wechat/$3"
  docker compose exec -T stele rm -f "/data/collector/$1.token"
}
mint steno-reader read reader.token
mint steno-login read,login login.token

echo 'WeChat is enabled. Open Connections in Steno and choose Connect WeChat; scan the QR with your phone and read its history-sync prompt before confirming.'
echo 'After an upgrade or any change that recreates the app container, run: docker compose up -d'
