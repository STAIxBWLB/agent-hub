#!/usr/bin/env bash
# Usage: scripts/hang-watch.sh PID SECONDS [PROGRESS_FILE QUIET_SECONDS]
# Waits while PID runs and stops it, SIGTERM then SIGKILL, with evidence of where it is (a stack sample on macOS, the
# thread states elsewhere, and the process table below it), so a test run whose event loop is blocked (which no test
# timeout can end) fails fast instead of at the CI job limit (issue #115). Exits as soon as PID is gone; prints nothing then.
#
# Two bounds. With PROGRESS_FILE and QUIET_SECONDS, the run is stopped once PROGRESS_FILE has not grown for QUIET_SECONDS: scripts/progress-tee.sh
# appends one byte to it for every test result line and test file header the suite prints, so a suite that is slow but still passing tests is
# never cut (#516: hosted ubuntu runs of 14-17 minutes were killed at the total bound while passing line by line). SECONDS is then only the overall
# backstop for a run that keeps printing results while it is hung. Without them there is nothing to read, so SECONDS is the one bound, as before
# (the CI timing job and scripts/seeded-check.ts call it that way).
# The process is the one with PID and the start time it had when the watch began: a reused pid is never signalled.
set -u
pid=$1 limit=$2 progress=${3:-} quiet_limit=${4:-}
started=$(LC_ALL=C TZ=UTC ps -o lstart= -p "$pid" 2>/dev/null)
end=$((SECONDS + limit))
last_size=0
last_move=$SECONDS
# The same process, and not a zombie (a zombie has exited: only its parent's wait is missing).
running() {
  [ -n "$started" ] || return 1
  local now stat
  now=$(LC_ALL=C TZ=UTC ps -o lstart= -p "$pid" 2>/dev/null) && [ "$now" = "$started" ] || return 1
  stat=$(ps -o stat= -p "$pid" 2>/dev/null) && [ "${stat#Z}" = "$stat" ]
}
# Bytes in the progress file. An unreadable file reads as no growth, never as a burst of progress.
size() {
  local n
  [ -f "$progress" ] || return 1
  n=$(wc -c < "$progress" 2>/dev/null) || return 1
  echo "${n//[![:digit:]]/}"
}
# What runs below PID, from one process table snapshot: the hung thing is often a fixture child, not the runner.
process_table() {
  echo "check: processes below pid $pid:" >&2
  ps -A -o pid=,ppid=,stat=,etime=,args= 2>/dev/null | awk -v root="$pid" '
    { parent[$1] = $2; row[$1] = $0 }
    END { for (id in parent) { at = id; depth = 0; while ((at in parent) && at != root && depth < 64) { at = parent[at]; depth++ }
                                if (at == root && id != root) print row[id] } }' | head -40 >&2
}
stop() {
  local why=$1 quiet=$((SECONDS - last_move))
  if [ "$why" = quiet ]; then
    echo "check: pid $pid made no progress (no test result line or file header) for ${quiet}s, bound ${quiet_limit}s; where it is:" >&2
  else
    echo "check: pid $pid still running after ${limit}s; where it is:" >&2
  fi
  echo "check: hang-watch: cause=$why quiet_for=${quiet}s quiet_bound=${quiet_limit}s total_bound=${limit}s" >&2
  if command -v sample >/dev/null 2>&1; then
    report=$(mktemp) # sample writes a report file of its own otherwise (in /tmp, whatever TMPDIR says)
    sample "$pid" 3 -file "$report" >/dev/null 2>&1 || echo "check: sample failed" >&2
    sed -n '/Call graph:/,/Total number in stack/p' "$report" | head -120 >&2
    rm -f "$report"
  else
    ps -L -o pid,lwp,stat,wchan:32,etime,args -p "$pid" >&2 2>/dev/null || ps -o pid,stat,etime,args -p "$pid" >&2
  fi
  process_table
  running && kill -TERM "$pid" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do running || exit 0; sleep 1; done
  running && kill -KILL "$pid" 2>/dev/null
  exit 0
}
while running; do
  if [ "$SECONDS" -ge "$end" ]; then stop total; fi
  if [ -n "$progress" ] && [ -n "$quiet_limit" ]; then
    now_size=$(size) || now_size=$last_size
    if [ "${now_size:-0}" -gt "$last_size" ]; then last_size=$now_size; last_move=$SECONDS
    elif [ $((SECONDS - last_move)) -ge "$quiet_limit" ]; then stop quiet; fi
  fi
  sleep 1
done
