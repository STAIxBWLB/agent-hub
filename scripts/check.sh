#!/usr/bin/env bash
# The one gate: typecheck, plugin bundle freshness, package contents, unit + integration tests. Non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")/.."

bun install --frozen-lockfile >/dev/null
bun x tsc --noEmit
bun scripts/build.mjs --check
node scripts/check-package.mjs

tests=0
bun test || tests=$?
# issue #56: a daemon leaked by the suite spins a core for days. Test projects live in
# mkdtemp dirs named ahub-* (realpath /private$TMPDIR on macOS, /tmp on Linux), and the
# daemon argv carries --project <temp-root>, so that tmp path signature finds any of them
# without matching a real hub whose project dir happens to start with ahub-. The guard
# runs whether or not the tests passed; a leak fails the gate either way.
if pgrep -f "(T|tmp)/ahub-" >/dev/null 2>&1; then
  echo "check: leaked agent-hub process(es) survived the test suite:" >&2
  pgrep -fl "(T|tmp)/ahub-" >&2 || true
  exit 1
fi
if [ "$tests" -ne 0 ]; then exit "$tests"; fi
echo "check: OK"
