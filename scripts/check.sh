#!/usr/bin/env bash
# The one gate: typecheck, plugin bundle freshness, package contents, unit + integration tests. Non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")/.."

bun install --frozen-lockfile >/dev/null
bun x tsc --noEmit
bun scripts/build.mjs --check
node scripts/check-package.mjs

tests=0
check_tmp=$(mktemp -d "${TMPDIR:-/tmp}/ahub-check.XXXXXX")
check_tmp=$(cd "$check_tmp" && pwd -P)
export TMPDIR="$check_tmp"
ledger="$check_tmp/owned-processes.jsonl"
: > "$ledger"
export AHUB_CHECK_RUN_ROOT="$check_tmp"
export AHUB_CHECK_PROCESS_LEDGER="$ledger"
export BUN_OPTIONS="${BUN_OPTIONS:+$BUN_OPTIONS }--preload=$PWD/scripts/record-test-process.mjs"

preserve_tmp=1
test_pid=""
cleanup_check() {
  status=$?
  trap - EXIT INT TERM
  if [ -n "$test_pid" ]; then
    kill -TERM "$test_pid" 2>/dev/null || true
    wait "$test_pid" 2>/dev/null || true
  fi
  if [ "$preserve_tmp" -eq 0 ]; then rm -rf "$check_tmp"; fi
  exit "$status"
}
trap cleanup_check EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# 20 s per test, not Bun's 5 s: in Bun 1.3.14 a test timeout that fires while Bun.spawnSync runs can start the next
# test inside spawnSync's own event loop, where a spawnSync then spins at full CPU for good (#115: the stacks of two
# local hangs under load; the macOS CI hang of 0.12.5 matches them). Bun 1.4.2 still starts the next test there (#121,
# checked directly); the spin was not reproduced on demand on either version, so the timeout and the watchdog stay.
# A run that hangs anyway is sampled and stopped long before the CI job limit; a normal run takes about two minutes.
bun test --timeout 20000 &
test_pid=$!
scripts/hang-watch.sh "$test_pid" "${AHUB_CHECK_HANG_S:-600}" &
watch_pid=$!
wait "$test_pid" || tests=$?
test_pid=""
kill "$watch_pid" 2>/dev/null || true # its work is done: never let it watch a pid that may be reused
wait "$watch_pid" 2>/dev/null || true

# The Bun preload records each current-run Bun process's PID, start time, and process
# group at startup. The final scan uses those identities to include children that outlive
# the daemon. Run this after test failures as well.
leaks=0
node scripts/check-owned-processes.mjs "$check_tmp" "$ledger" || leaks=$?
if [ "$tests" -ne 0 ] || [ "$leaks" -ne 0 ]; then
  echo "check: preserved test fixtures at $check_tmp" >&2
  if [ "$leaks" -ne 0 ]; then exit 1; fi
  exit "$tests"
fi
preserve_tmp=0
echo "check: OK"
