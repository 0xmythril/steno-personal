#!/usr/bin/env bash
# End-to-end release gate. Builds the image, runs it on a throwaway volume, and
# proves the ways in and out still work: a key requested with STENO_MINT_KEY
# printed to the log once, a cookie login, a bearer token, a restart that
# prints nothing twice, and a STENO_RESET that empties the volume and reopens
# setup. Everything is torn down afterwards, pass or fail.
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
  # Only when there is a container to read: a build failure never created one,
  # and the banner over an empty `docker logs` reads like a lost log.
  if [ "$code" != "0" ] && docker inspect "$NAME" >/dev/null 2>&1; then
    echo "--- last 40 log lines (keys redacted) ---" >&2
    docker logs "$NAME" 2>&1 | tail -40 | sed -E 's/sp_[A-Za-z0-9_-]+/sp_<redacted>/g' >&2 || true
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
  exit $code
}
trap cleanup EXIT

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

# run_container <extra docker run args...>: starts $NAME on $VOLUME.
run_container() {
  docker run -d --name "$NAME" \
    -p "127.0.0.1:${PORT}:3000" \
    -v "${VOLUME}:/data" \
    -e DATA_DIR=/data \
    "$@" \
    "$IMAGE" >/dev/null || fail "docker run failed — the container was never started"
}

# wait_healthy <what>: polls /api/health for up to 120 s.
wait_healthy() {
  local ready=0
  for _ in $(seq 1 60); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/health" || true)" = "200" ]; then
      ready=1; break
    fi
    docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null | grep -q true \
      || fail "the container exited during $1"
    sleep 2
  done
  [ "$ready" = "1" ] || fail "/api/health never answered 200 within 120s ($1)"
}

status_of() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# The container log as a string. Grepping `docker logs` through a pipe under
# pipefail is a race: `grep -q` exits on its first match, `docker logs` takes a
# SIGPIPE, and a line that IS there reads as a failure. Capture, then grep.
container_logs() { docker logs "$NAME" 2>&1; }

echo "==> build $IMAGE"
docker build -t "$IMAGE" . || fail "docker build failed — see the build output above"

echo "==> run $NAME on $VOLUME with STENO_MINT_KEY=smoke"
run_container -e STENO_MINT_KEY=smoke
wait_healthy boot
curl -sf "${BASE}/api/health" | grep -q '"ok":true' || fail "health payload is not {\"ok\":true}"

echo "==> read the requested key from the log"
logs="$(container_logs)"
grep -q 'access key "smoke"' <<<"$logs" || fail "no STENO_MINT_KEY banner in the container log"
KEY="$(grep -o 'sp_[A-Za-z0-9_-]\{20,\}' <<<"$logs" | head -1)"
[ -n "$KEY" ] || fail "no key in the container log"

echo "==> a key exists, so setup is closed"
code="$(status_of "${BASE}/setup")"
case "$code" in 30[1278]) ;; *) fail "GET /setup returned $code, expected a redirect to /login" ;; esac
curl -s -D - -o /dev/null "${BASE}/setup" | grep -qi '^location: .*/login' || fail "/setup did not redirect to /login"

echo "==> anonymous /api/chats is refused"
code="$(status_of "${BASE}/api/chats")"
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

echo "==> restart keeps the volume and prints no second key"
docker restart "$NAME" >/dev/null || fail "docker restart failed"
wait_healthy "the restart"
count="$(grep -c 'access key "smoke"' <<<"$(container_logs)" || true)"
[ "$count" = "1" ] || fail "the STENO_MINT_KEY banner appeared $count times, expected 1"
curl -sf -H "Authorization: Bearer ${KEY}" "${BASE}/api/chats" >/dev/null \
  || fail "the original key stopped working after a restart"

echo "==> STENO_RESET on the same volume empties it and reopens setup"
docker rm -f "$NAME" >/dev/null || fail "could not remove the container before the reset run"
run_container -e STENO_RESET=smoke
wait_healthy "the reset boot"
logs="$(container_logs)"
grep -q 'STENO_RESET handled' <<<"$logs" || fail "boot did not report the reset"
if grep -q 'access key' <<<"$logs"; then fail "a key was printed on the reset boot"; fi
code="$(status_of -H "Authorization: Bearer ${KEY}" "${BASE}/api/chats")"
[ "$code" = "401" ] || fail "the old key still worked after the reset (got $code)"
code="$(status_of "${BASE}/setup")"
[ "$code" = "200" ] || fail "GET /setup returned $code after the reset, expected 200"
curl -s -D - -o /dev/null "${BASE}/login" | grep -qi '^location: .*/setup' || fail "/login did not redirect to /setup on the fresh instance"

echo "==> a restart with STENO_RESET still set resets nothing"
docker restart "$NAME" >/dev/null || fail "docker restart failed after the reset"
wait_healthy "the post-reset restart"
count="$(grep -c 'STENO_RESET handled' <<<"$(container_logs)" || true)"
[ "$count" = "1" ] || fail "the reset ran $count times across restarts, expected 1"

echo "SMOKE PASS"
