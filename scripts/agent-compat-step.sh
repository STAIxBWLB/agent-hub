#!/usr/bin/env bash
# #691: run the watcher and record its verdict for the workflow. Usage: agent-compat-step.sh <report-file> <command...>
# The watcher exits 0 (all verified) or 3 (some ahead, with a report that starts with the drift header). Anything else,
# Bun's crash code 1 included, or a drift exit without a valid report, fails the step so no issue is touched.
set -u
report=$1; shift
"$@" > "$report"
status=$?
cat "$report"
out=${GITHUB_OUTPUT:-/dev/null}
case "$status" in
  0) echo "ahead=false" >> "$out" ;;
  3) if head -1 "$report" | grep -q '^Published agent CLI versions ahead of their verified set'; then echo "ahead=true" >> "$out"
     else echo "agent-compat: drift exit without a valid report" >&2; exit 1; fi ;;
  *) echo "agent-compat: watcher failed with status $status" >&2; exit 1 ;;
esac
