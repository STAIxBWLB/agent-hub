#!/usr/bin/env bash
# Usage: scripts/progress-tee.sh FILE   (reads stdin, writes the same lines to stdout)
# The test gate's output filter (#516). Every line goes through to stdout unchanged and flushed at once, and for each line that shows the
# suite moving, one byte is appended to FILE: a `bun test` result line ((pass), (fail), (skip) or (todo)) or a test file header (a line ending
# in `.ts:`). scripts/hang-watch.sh polls the size of FILE, so a long log is never rescanned and a run that only logs is not progress. The last
# line of the input counts too when it has no newline.
set -u
PROGRESS_FILE=$1 exec awk '
BEGIN { file = ENVIRON["PROGRESS_FILE"] }
{
  print; fflush()
  if ($0 ~ /^\((pass|fail|skip|todo)\) / || $0 ~ /\.ts:$/) { printf "x" >> file; close(file) }
}'
