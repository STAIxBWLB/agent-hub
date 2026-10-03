#!/usr/bin/env bash
# Usage: scripts/hang-watch.sh PID SECONDS
# Waits while PID runs. If it still runs after SECONDS, prints where it is (a stack sample on macOS, the thread states
# elsewhere) and stops it with SIGTERM, so a test run whose event loop is blocked (which no test timeout can end) fails
# fast with evidence instead of at the CI job limit (issue #115). Exits as soon as PID is gone; prints nothing then.
set -u
pid=$1 limit=$2
end=$((SECONDS + limit))
# A zombie has exited: only its parent's wait is missing.
running() { kill -0 "$pid" 2>/dev/null && ! ps -o stat= -p "$pid" 2>/dev/null | grep -q '^Z'; }
while running; do
  if [ "$SECONDS" -ge "$end" ]; then
    echo "check: pid $pid still running after ${limit}s; where it is:" >&2
    if command -v sample >/dev/null 2>&1; then
      sample "$pid" 3 2>/dev/null | sed -n '/Call graph:/,/Total number in stack/p' | head -120 >&2
    else
      ps -L -o pid,lwp,stat,wchan:32,etime,args -p "$pid" >&2 2>/dev/null || ps -o pid,stat,etime,args -p "$pid" >&2
    fi
    kill -TERM "$pid" 2>/dev/null
    exit 0
  fi
  sleep 1
done
