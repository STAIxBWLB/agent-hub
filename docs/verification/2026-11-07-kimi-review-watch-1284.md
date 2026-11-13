# Kimi review policy watching (#1284)

Date: 2026-11-07. Task #785. These are model-free private fixtures on dgx02,
Linux x64, Bun 1.4.2. The production Kimi preparation and reviewer peer are used
with an owned fake print/version command and synthetic OAuth files. No real Kimi
CLI, provider, account, credential or model interaction is claimed. COMPAT and
machine trust are unchanged.

The historical baseline was measured before production optimization, at
`4daaa842db4035c5504caff6867445b47b7c1be5`. It drives the actual old
`ReviewerPrintPeer` interval and complete `current()` fence. Input is exactly
1048576 framed bytes; the generated agent file is 1048868 bytes.

The post-change samples below are bound to
`dedbf4974d2a91ebd96623f4bd4a1ca04c06ac47`. The worker mode uses the real
policy worker and new controller. Inline-reference mode uses the same full fence
on the main thread under the new controller; it is a comparator, not another
measurement of the historical interval.

## Measurements

Values are milliseconds. Authority samples are eight synchronous `reviewToken()`
calls. Periodic samples are three checks per mode, after preparation has already
read the private files. These are small warm-fixture samples, not a cold-start,
production latency regression, p99 estimate or general speedup claim.

| Mode | Authority mean / max | Ordinary check mean / max | Ordinary start-to-start |
| --- | ---: | ---: | --- |
| Historical inline interval | 1.631 / 3.011 | 1.657 / 1.776 | 100.259, 100.214 |
| Worker | 1.709 / 3.937 | 2.748 / 2.998 | 100.362, 99.739 |
| New-controller inline reference | 1.613 / 3.095 | 1.725 / 1.877 | 99.857, 100.511 |

The worker check includes IPC and completion overhead. Work is moved off the main
event loop; the filesystem/hash work is not eliminated. Synchronous authority
checks remain synchronous and retain their separate measured cost.

A second phase adds a synthetic 150 ms hold, separately recorded from the actual
full-check cost. The worker is held inside its real request path until an
independent requester receives a real loopback control response. The fixture
checks that the underlying check has not completed prematurely. Inline modes
block the main thread; the independent requester confirms its request was sent.
The control server shares the actual reviewer's process/event loop. This is a
causal control fixture, not an installed daemon's response-time trace.

| Mode | Slow start-to-start | Causal shared-counter order |
| --- | --- | --- |
| Historical interval | 160.648, 152.533 | check start 1, check end 2, control dispatch 3, response 5 |
| Worker | 165.924, 154.460 | check start 1, control dispatch 2, response 3, check end 4 |
| New-controller inline reference | 162.538, 153.221 | check start 1, check end 2, control dispatch 3, response 5 |

Every sample's maximum concurrent checks is one. The first synthetic sample can
include requester coordination in addition to the nominal hold; it is not
reported as production hash cost. Assertions use ordering, not a host-specific
latency threshold. A fake monotonic clock separately proves that a check started
at 100 and completed at 350 schedules an immediate overdue check at 350, then a
fast completion schedules 400, without replaying every missed tick.

The full numeric baseline output is retained in the workspace's
`scratchpad/temp/task785-baseline-4daaa842.log`; the benchmark command emits the
raw arrays, ordering counters and cleanup flags. The post-change command is
`bun scripts/benchmarks/kimi-review-watch-1284.ts`, with `--inline-reference`
selecting its comparator. Each observed run confirmed peer stop, requester join,
profile removal and unchanged synthetic source files; post-change runs also
confirmed policy-worker join.

## Validation and ownership

Both synchronous authority checks and the worker call the same complete
filesystem checker: lexical and physical cwd ancestors, native source identity,
executable metadata, source configuration hash, all three private-file hashes and
all native/private auth targets. The parent adds abort/cleanup guards before and
after an asynchronous check. No successful asynchronous result is cached as
verdict or task-MCP authority. Version probing, fresh private homes, the two-tool
allowlist and OAuth-lock teardown are unchanged.

The worker receives a closed immutable projection of expected paths, metadata
and fingerprints, not serialized task facts, configuration contents or inherited
environment. It still reads the bounded files to hash them. Requests are
serialized and replies carry only a monotonic request ID and boolean. Error,
output, protocol and early boot failures poison the probe, including before the
first periodic tick; error text is not forwarded.

Each child/review sequence owns its watcher. Stop cancels scheduling before
joining a blocked check, initiates worker termination even if native stop fails,
and joins before profile deletion or confirmed input cleanup. Failed joins keep
the owner/profile and busy state until an explicit stop retry. A late result
cannot settle or revive a subsequent review, even for the same task and batch.
Worker progress never touches the native inactivity watchdog.

The source worker has a JS wrapper. The plugin has a separately generated,
self-contained sidecar with the same basename. A fixture copies that sidecar
alone into a directory containing a space and executes it without a source tree
beside it. Both generated assets use the pinned Bun after a worktree-local frozen
install; neither is hand edited.

At `dedbf4974d2a91ebd96623f4bd4a1ca04c06ac47`, dgx02 typecheck and 75 tests
across six files passed (514 assertions), followed by both numeric benchmark
modes. Coverage includes actual workers, empty environment, closed projection,
cwd/binary/config/auth changes, equal-size restored-mtime content tampering,
atomic OAuth refresh, stop while blocked, cleanup retries, early failure,
same-task late results, watchdog and output-limit cleanup. Existing Kimi isolation,
privacy, two-tool and lifecycle assertions were retained. The one old fake launch
with `watchCurrent` gained the asynchronous probe required by the new contract.

Two earlier fixture failures are not passing evidence: `28b7a07c` stopped at a
missing MCP-schema `additionalProperties:false`; `f5b5e8e2` passed typecheck and
56 tests but four new mtime cases used sub-ms timestamps that `Date` could not
restore exactly. The corrected fixture initializes exact whole-second timestamps
before binding; its size, precision and refusal assertions are unchanged.

Final canonical/seed/hosted-CI results are recorded at their exact tested heads
in the PR/task. Inventory discovery was deferred once with exit 75 because three
remote slots were occupied; no retry loop or local test/index fallback ran. No
documentation stamp, native version receipt, model-quality claim, merge or tag
is part of this change.
