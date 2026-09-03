#!/usr/bin/env bash
# End-to-end release gate. Builds the image, runs it on a throwaway volume, and
# proves the three ways in still work: the bootstrap key printed to the log, a
# cookie login, and a bearer token. Everything is torn down afterwards, pass or
# fail.
#
#   bash scripts/smoke.sh
#   SMOKE_PORT=4100 bash scripts/smoke.sh
set -euo pipefail

IMAGE="${IMAGE:-steno-personal:smoke}"
NAME="${NAME:-steno-smoke-$$}"
PORT="${SMOKE_PORT:-3999}"
BASE="http://127.0.0.1:${PORT}"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/steno-smoke.XXXXXX")"
JAR="${WORKDIR}/cookies.txt"
VOLUME="${WORKDIR}/data"
mkdir -p "$VOLUME"

cleanup() {
  code=$?
  if [ "$code" != "0" ]; then
    echo "--- last 40 log lines (keys redacted) ---" >&2
    docker logs "$NAME" 2>&1 | tail -40 | sed -E 's/sp_[A-Za-z0-9_-]+/sp_<redacted>/g' >&2 || true
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
  exit $code
}
trap cleanup EXIT

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

echo "==> build $IMAGE"
docker build -t "$IMAGE" .

echo "==> run $NAME on $VOLUME"
docker run -d --name "$NAME" \
  -p "127.0.0.1:${PORT}:3000" \
  -v "${VOLUME}:/data" \
  -e DATA_DIR=/data \
  "$IMAGE" >/dev/null

echo "==> wait for /api/health"
ready=0
for _ in $(seq 1 60); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/health" || true)" = "200" ]; then
    ready=1; break
  fi
  docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null | grep -q true \
    || fail "the container exited during boot"
  sleep 2
done
[ "$ready" = "1" ] || fail "/api/health never answered 200 within 120s"
curl -sf "${BASE}/api/health" | grep -q '"ok":true' || fail "health payload is not {\"ok\":true}"

echo "==> read the bootstrap key from the log"
KEY="$(docker logs "$NAME" 2>&1 | grep -o 'sp_[A-Za-z0-9_-]\{20,\}' | head -1)"
[ -n "$KEY" ] || fail "no bootstrap key in the container log"

echo "==> anonymous /api/chats is refused"
code="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/chats")"
[ "$code" = "401" ] || fail "anonymous /api/chats returned $code, expected 401"

echo "==> cookie login"
code="$(curl -s -c "$JAR" -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/login" \
  -H 'content-type: application/json' --data "{\"key\":\"${KEY}\"}")"
[ "$code" = "204" ] || fail "POST /api/login returned $code, expected 204"
grep -q 'sp_session' "$JAR" || fail "no sp_session cookie was set"

echo "==> a wrong key is refused"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/login" \
  -H 'content-type: application/json' --data '{"key":"sp_definitely_not_a_real_key"}')"
[ "$code" = "401" ] || fail "a bad key returned $code, expected 401"

echo "==> /api/chats with the cookie"
body="$(curl -sf -b "$JAR" "${BASE}/api/chats")" || fail "the cookie request failed"
echo "$body" | grep -q '"chats"' || fail "cookie response has no chats: $body"

echo "==> /api/chats with the bearer key"
body="$(curl -sf -H "Authorization: Bearer ${KEY}" "${BASE}/api/chats")" \
  || fail "the bearer request failed"
echo "$body" | grep -q '"chats"' || fail "bearer response has no chats: $body"

echo "==> restart keeps the volume and mints no second key"
docker restart "$NAME" >/dev/null
for _ in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/health" || true)" = "200" ] && break
  sleep 2
done
count="$(docker logs "$NAME" 2>&1 | grep -c 'your first access key' || true)"
[ "$count" = "1" ] || fail "the bootstrap banner appeared $count times, expected 1"
curl -sf -H "Authorization: Bearer ${KEY}" "${BASE}/api/chats" >/dev/null \
  || fail "the original key stopped working after a restart"

echo "SMOKE PASS"
