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

bun test &
test_pid=$!
wait "$test_pid" || tests=$?
test_pid=""

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
