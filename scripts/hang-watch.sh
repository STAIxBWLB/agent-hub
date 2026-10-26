#!/usr/bin/env bash
# Usage: scripts/hang-watch.sh PID SECONDS [PROGRESS_FILE]
# Waits while PID runs. A run that goes PROGRESS_FILE seconds without a new line in PROGRESS_FILE (default 180: no
# progress, so no test result line and no end) is a hang: print where it is (a stack sample on macOS, the thread
# states elsewhere) and stop it, SIGTERM then SIGKILL, so a test run whose event loop is blocked (which no test
# timeout can end) fails fast with evidence instead of at the CI job limit (issue #115). SECONDS stays as a generous
# overall backstop for a run that keeps spewing output while hung (#516: hosted ubuntu runs of 14-17 minutes were
# still passing tests line by line when the old total-time kill fired at 1080 s). Without PROGRESS_FILE there are no
# progress lines to read, so SECONDS is the kill bound, as before. Exits as soon as PID is gone; prints nothing then.
# The process is the one with PID and the start time it had when the watch began: a reused pid is never signalled.
set -u
pid=$1 limit=$2 progress=${3:-}
quiet_limit=${AHUB_CHECK_QUIET_S:-180}
started=$(LC_ALL=C TZ=UTC ps -o lstart= -p "$pid" 2>/dev/null)
end=$((SECONDS + limit))
last_lines=0
last_move=$SECONDS
# The same process, and not a zombie (a zombie has exited: only its parent's wait is missing).
running() {
  [ -n "$started" ] || return 1
  local now stat
  now=$(LC_ALL=C TZ=UTC ps -o lstart= -p "$pid" 2>/dev/null) && [ "$now" = "$started" ] || return 1
  stat=$(ps -o stat= -p "$pid" 2>/dev/null) && [ "${stat#Z}" = "$stat" ]
}
# Lines the watched process has emitted so far; a read failure holds the last count, so a momentary error never
# reads as a burst of progress, and an empty or unreadable file reads as none at all.
progress_lines() {
  [ -f "$progress" ] || return 1
  local n
  n=$(wc -l < "$progress" 2>/dev/null) || return 1
  echo "${n//[![:digit:]]/}"
}
stop() {
  local reason=$1 why cause
  if [ "$reason" = quiet ]; then
    why="no test result line for ${quiet_limit}s (last $((SECONDS - last_move))s ago) and still running after ${SECONDS}s"
  else
    why="still running after ${limit}s"
  fi
  cause=${reason}
  echo "check: pid $pid ${why}; where it is:" >&2
  echo "check: hang-watch: cause=${cause} pid=${pid} bound=${limit}s quiet_bound=${quiet_limit}s quiet_elapsed=$((SECONDS - last_move))s" >&2
  if command -v sample >/dev/null 2>&1; then
    report=$(mktemp) # sample writes a report file of its own otherwise (in /tmp, whatever TMPDIR says)
    sample "$pid" 3 -file "$report" >/dev/null 2>&1 || echo "check: sample failed" >&2
    sed -n '/Call graph:/,/Total number in stack/p' "$report" | head -120 >&2
    rm -f "$report"
  else
    ps -L -o pid,lwp,stat,wchan:32,etime,args -p "$pid" >&2 2>/dev/null || ps -o pid,stat,etime,args -p "$pid" >&2
  fi
  running && kill -TERM "$pid" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do running || exit 0; sleep 1; done
  running && kill -KILL "$pid" 2>/dev/null
  exit 0
}
while running; do
  if [ -n "$progress" ]; then
    lines=$(progress_lines) || lines=$last_lines
    if [ "$lines" -gt "$last_lines" ]; then
      last_lines=$lines
      last_move=$SECONDS
    elif [ $((SECONDS - last_move)) -ge "$quiet_limit" ] && [ "$SECONDS" -lt "$end" ]; then
      stop quiet
    fi
  fi
  if [ "$SECONDS" -ge "$end" ]; then
    stop total
  fi
  sleep 1
done
