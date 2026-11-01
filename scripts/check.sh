#!/usr/bin/env bash
# The one gate: typecheck, plugin bundle freshness, package contents, unit + integration tests. Non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")/.."

# #610: `--changed [<base>]` runs every non-test step and only the tests the change touches (scripts/changed-tests.mjs).
# Agents run it before a PR; the full gate is CI's on both OSes.
changed=0
changed_base=""
if [ "${1:-}" = "--changed" ]; then changed=1; changed_base=${2:-}; fi

# #548: `AHUB_CHECK_SHARD=i/n` runs one slice of the full suite, balanced by the recorded per-file times in scripts/test-timings.json (bun test --shard --timings:
# every file runs in exactly one shard). Shard 1 also runs the steps that must happen once per gate (docs, typecheck, roles, bundle, package); the others only install and test.
# CI runs the macOS leg as shards; without the variable this is the whole gate, as before. It is the full suite's slice, never a changed-file selection.
shard="${AHUB_CHECK_SHARD:-}"
if [ -n "$shard" ]; then
  case "$shard" in
    [1-9]/[1-9]|[1-9]/[1-9][0-9]|[1-9][0-9]/[1-9][0-9]) ;;
    *) echo "check: AHUB_CHECK_SHARD must be i/n, such as 2/4 (got '$shard')" >&2; exit 2 ;;
  esac
  if [ "${shard%%/*}" -lt 1 ] || [ "${shard%%/*}" -gt "${shard##*/}" ]; then echo "check: AHUB_CHECK_SHARD $shard: i must be between 1 and n" >&2; exit 2; fi
  if [ "$changed" -eq 1 ]; then echo "check: AHUB_CHECK_SHARD and --changed cannot be combined" >&2; exit 2; fi
fi

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

if [ -z "$shard" ] || [ "${shard%%/*}" = "1" ]; then node scripts/check-docs.mjs; fi
bun install --frozen-lockfile >/dev/null
# The published N-1 runtime is an isolated, exact-locked test fixture, never a root CLI dependency.
if [ -f test/fixtures/protocol-v16/package.json ]; then (cd test/fixtures/protocol-v16 && bun install --frozen-lockfile >/dev/null); fi
if [ -z "$shard" ] || [ "${shard%%/*}" = "1" ]; then
  bun x tsc --noEmit
  bun scripts/check-roles.ts
  bun scripts/build.mjs --check
  node scripts/check-package.mjs # includes the standalone pet host, JXA and HTML assets
fi

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

if [ -n "$shard" ]; then
  test_args=("--shard=$shard" "--timings=scripts/test-timings.json")
  echo "check: shard $shard of the full suite (scripts/test-timings.json)" >&2
  # #548: a shard starts the suite cold. Several tests run the system git (PATH=/usr/bin:/bin) with a 1000 ms timeout; on a fresh hosted macOS runner the first execs of /usr/bin/git
  # (the Xcode shim, then the real binary) take over a second, and each is killed at the timeout before it can finish, so the first tests that use it fail (hosted shards 3 and 4 of PR #954:
  # 8 tests, all at the 1000 ms timeout, where the same tests take about 140 ms in an unsharded leg that has run git earlier). One unbounded exec warms it. Failure to warm is not a failure.
  # ponytail: the warm-up covers git only; the upgrade path is raising the 1000 ms test timeouts if another cold executable shows up.
  warm_git=${AHUB_CHECK_WARM_GIT:-/usr/bin/git}
  if [ -x "$warm_git" ]; then "$warm_git" --version >/dev/null 2>&1 || true; fi
fi
# The shard is this script's own business and is already in $shard and test_args: the test runner and everything it spawns must not inherit it. A test that runs a scratch check.sh
# (test/check-lock.test.ts copies process.env) would otherwise skip the shard-1-only steps it expects, and fail in any shard but 1 (a rebalance of the timings would turn the macOS gate red).
unset AHUB_CHECK_SHARD

tests=0
# #610: the temp root is the OS per-user temp dir, never an inherited TMPDIR that may sit inside an agent's home.
os_tmp=$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || echo /tmp)
check_tmp=$(mktemp -d "${os_tmp%/}/ahub-check.XXXXXX")
check_tmp=$(cd "$check_tmp" && pwd -P)
export TMPDIR="$check_tmp"
ledger="$check_tmp/owned-processes.jsonl"
: > "$ledger"
progress="$check_tmp/test-progress.txt"
: > "$progress"
output_fifo="$check_tmp/test-output.fifo"
mkfifo "$output_fifo"
export AHUB_CHECK_RUN_ROOT="$check_tmp"
export AHUB_CHECK_PROCESS_LEDGER="$ledger"
export BUN_OPTIONS="${BUN_OPTIONS:+$BUN_OPTIONS }--preload=$PWD/scripts/record-test-process.mjs"

preserve_tmp=1
test_pid=""
tee_pid=""
cleanup_check() {
  status=$?
  trap - EXIT INT TERM
  if [ -n "$tee_pid" ]; then kill "$tee_pid" 2>/dev/null || true; fi
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
# #516: the watchdog stops a run on lost progress, not on elapsed time. Bun prints its results on stderr: they go through a fifo to
# scripts/progress-tee.sh, which passes every line on to this script's stderr unchanged and appends one byte to $progress for each result
# line or file header, and hang-watch.sh polls that file's size. Stdout stays untouched. A fifo and a filter of its own, not a pipe or a
# process substitution: with a pipe `$!` would be the filter and `wait` its status, so the watchdog would stop the filter and leave bun
# running and a failing suite would read as passing; a process substitution cannot be waited on with a bound, and a leaked fixture child that
# keeps the output open must not hold the gate before the leak scan names it.
scripts/progress-tee.sh "$progress" < "$output_fifo" >&2 &
tee_pid=$!
# #613: and no ORCA_* variable (src/hub/orca-env.ts names the launcher's four; the whole prefix goes): a run from an Orca pane would otherwise open real tabs and agents there.
while IFS= read -r orca_var; do unset "$orca_var"; done < <(compgen -e | grep '^ORCA_' || true)
env -u AGENTHUB_PEER_ID -u AGENTHUB_DELIVERY_ONLY -u AGENTHUB_CHANNEL -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CODEX_THREAD_ID \
  -u AGENTHUB_PROJECT_DIR -u AGENTHUB_STATE_DIR -u AGENTHUB_INSTANCE_ID -u AGENTHUB_LAUNCH_ID -u NO_COLOR \
  GIT_CONFIG_GLOBAL=/dev/null TERM=xterm-256color bun test --timeout 20000 ${test_args[@]+"${test_args[@]}"} 2> "$output_fifo" &
test_pid=$!
# A suite still printing test results is slow, not hung (hosted ubuntu runs of 14-17 minutes were cut at 1080 s while passing tests line
# by line): the quiet bound (AHUB_CHECK_QUIET_S, 300 s without a result line or file header) is the hang detector and AHUB_CHECK_HANG_S the backstop.
scripts/hang-watch.sh "$test_pid" "${AHUB_CHECK_HANG_S:-960}" "$progress" "${AHUB_CHECK_QUIET_S:-300}" &
watch_pid=$!
wait "$test_pid" || tests=$?
test_pid=""
kill "$watch_pid" 2>/dev/null || true # its work is done: never let it watch a pid that may be reused
wait "$watch_pid" 2>/dev/null || true
# The filter ends when every writer has closed the fifo: wait a bounded time for the last lines, then let it go (a leaked child still holds it,
# and the leak scan below reports that).
for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$tee_pid" 2>/dev/null || break; sleep 0.5; done
kill "$tee_pid" 2>/dev/null || true
wait "$tee_pid" 2>/dev/null || true
tee_pid=""

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
if [ -n "$shard" ]; then echo "check: OK (shard $shard)"
elif [ "$changed" -eq 1 ] && [ ${#test_args[@]} -gt 0 ]; then echo "check: OK (changed)"; else echo "check: OK"; fi
