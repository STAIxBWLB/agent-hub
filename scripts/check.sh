#!/usr/bin/env bash
# The one gate: typecheck, plugin bundle freshness, package contents, unit + integration tests. Non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")/.."

# #610: `--changed [<base>]` runs every non-test step and only the tests the change touches (scripts/changed-tests.mjs).
# Agents run it before a PR; the full gate is CI's on both OSes.
changed=0
changed_base=""
if [ "${1:-}" = "--changed" ]; then changed=1; changed_base=${2:-}; fi

# One heavy job per repo (#398): every worktree shares the git common dir, so a second gate waits here instead of
# depending on a chat message being read in time. AHUB_CHECK_LOCK_WAIT_S bounds the wait (0 fails at once).
# ponytail: liveness is `kill -0`, so a reused pid keeps a crashed holder's slot until its directory is removed by
# hand, and two waiters reaping the same dead holder can both start; move the slot into the hub if either bites.
heavy_lock=""
release_heavy() { if [ -n "$heavy_lock" ]; then rm -rf "$heavy_lock"; heavy_lock=""; fi; }
if common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then
  lock="$common/ahub-heavy.lock"
  wait_s=${AHUB_CHECK_LOCK_WAIT_S:-1800}
  waited=0
  until mkdir "$lock" 2>/dev/null; do
    holder=$(cat "$lock/owner" 2>/dev/null || true)
    pid=${holder%% *}
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then rm -rf "$lock"; continue; fi
    if [ "$waited" -ge "$wait_s" ]; then echo "check: heavy-job slot still held by ${holder:-an unknown run} ($lock)" >&2; exit 1; fi
    if [ "$waited" -eq 0 ]; then echo "check: waiting for the heavy-job slot held by ${holder:-a starting run}" >&2; fi
    sleep 5; waited=$((waited + 5))
  done
  heavy_lock=$lock
  echo "$$ since $(date '+%H:%M:%S') in $PWD" > "$lock/owner"
  trap release_heavy EXIT
fi

node scripts/check-docs.mjs
bun install --frozen-lockfile >/dev/null
bun x tsc --noEmit
bun scripts/check-roles.ts
bun scripts/build.mjs --check
node scripts/check-package.mjs # includes the standalone pet host, JXA and HTML assets

test_args=()
if [ "$changed" -eq 1 ]; then
  selection=$(node scripts/changed-tests.mjs ${changed_base:+"$changed_base"})
  if [ "$selection" = "ALL" ]; then echo "check: --changed selected the full suite" >&2
  elif [ -z "$selection" ]; then echo "check: --changed found no affected tests"; echo "check: OK (changed)"; exit 0
  else
    while IFS= read -r file; do test_args+=("$file"); done <<< "$selection"
    echo "check: --changed runs ${#test_args[@]} test files" >&2
  fi
fi

tests=0
# #610: the temp root is the OS per-user temp dir, never an inherited TMPDIR that may sit inside an agent's home.
os_tmp=$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || echo /tmp)
check_tmp=$(mktemp -d "${os_tmp%/}/ahub-check.XXXXXX")
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
  release_heavy
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
# Human CLI fixtures must not inherit the coding agent running this gate. Clear the
# runner's OS environment before Bun starts; identity tests set their own child markers.
# An `ahub claude` session also carries its hub's project, state dir and launch identity:
# a fixture's plugin would send that project at hello and be refused by the fixture hub.
# #610: and not the person's git config (a global ignore hid fixture files) or color settings (NO_COLOR and a dumb
# TERM broke the ANSI goldens); tests that need either set it themselves.
env -u AGENTHUB_PEER_ID -u AGENTHUB_DELIVERY_ONLY -u AGENTHUB_CHANNEL -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CODEX_THREAD_ID \
  -u AGENTHUB_PROJECT_DIR -u AGENTHUB_STATE_DIR -u AGENTHUB_INSTANCE_ID -u AGENTHUB_LAUNCH_ID -u NO_COLOR \
  GIT_CONFIG_GLOBAL=/dev/null TERM=xterm-256color bun test --timeout 20000 ${test_args[@]+"${test_args[@]}"} &
test_pid=$!
scripts/hang-watch.sh "$test_pid" "${AHUB_CHECK_HANG_S:-960}" &
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
if [ "$changed" -eq 1 ] && [ ${#test_args[@]} -gt 0 ]; then echo "check: OK (changed)"; else echo "check: OK"; fi
