#!/usr/bin/env bash
# Usage: scripts/hang-watch.sh PID SECONDS
# Waits while PID runs. If it still runs after SECONDS, prints where it is (a stack sample on macOS, the thread states
# elsewhere) and stops it, SIGTERM then SIGKILL, so a test run whose event loop is blocked (which no test timeout can end)
# fails fast with evidence instead of at the CI job limit (issue #115). Exits as soon as PID is gone; prints nothing then.
# The process is the one with PID and the start time it had when the watch began: a reused pid is never signalled.
set -u
pid=$1 limit=$2
started=$(LC_ALL=C TZ=UTC ps -o lstart= -p "$pid" 2>/dev/null)
end=$((SECONDS + limit))
# The same process, and not a zombie (a zombie has exited: only its parent's wait is missing).
running() {
  [ -n "$started" ] || return 1
  local now stat
  now=$(LC_ALL=C TZ=UTC ps -o lstart= -p "$pid" 2>/dev/null) && [ "$now" = "$started" ] || return 1
  stat=$(ps -o stat= -p "$pid" 2>/dev/null) && [ "${stat#Z}" = "$stat" ]
}
while running; do
  if [ "$SECONDS" -ge "$end" ]; then
    echo "check: pid $pid still running after ${limit}s; where it is:" >&2
    if command -v sample >/dev/null 2>&1; then
      report=$(mktemp) # sample writes a report file of its own otherwise (in /tmp, whatever TMPDIR says)
      sample "$pid" 3 -file "$report" >/dev/null 2>&1
      sed -n '/Call graph:/,/Total number in stack/p' "$report" | head -120 >&2
      rm -f "$report"
    else
      ps -L -o pid,lwp,stat,wchan:32,etime,args -p "$pid" >&2 2>/dev/null || ps -o pid,stat,etime,args -p "$pid" >&2
    fi
    running && kill -TERM "$pid" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do running || exit 0; sleep 1; done
    running && kill -KILL "$pid" 2>/dev/null
    exit 0
  fi
  sleep 1
done
