#!/usr/bin/env bash
set -euo pipefail
docker version >/dev/null
node scripts/smoke-upgrades.mjs
