#!/usr/bin/env bash
# The one gate: typecheck, plugin bundle freshness, unit + integration tests. Non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")/.."

bun install --frozen-lockfile >/dev/null
bun x tsc --noEmit
bun scripts/build.mjs --check
bun test
echo "check: OK"
