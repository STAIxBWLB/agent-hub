# Live-board-copy write latency, 2026-11-03

Task #669, Refs #1078. **The reported 30-second stall was not reproduced and its cause remains unknown.** These measurements do not establish an environmental cause or a latency fix. No production code, timeout, retry bound, live configuration or running daemon was changed.

## Input and isolation

A read-only SQLite connection backed up the project's live database into an owner-only scratch directory. SQLite backup includes committed WAL state without copying an inconsistent database/WAL pair. Profiling then used that snapshot and disposable copies only. The snapshot contains 670 tasks, 4,719,605 bytes of history JSON and a 33,292,288-byte database. Its 2,055 deliveries comprise 1,801 completed, 136 failed, 111 discarded and 7 accepted rows. Counts differ from the assignment's earlier observation because the board continued operating before backup.

Matching config.json, config.local.json, routing.toml and sdlc.toml were copied privately. No task text, config contents, database, account path or native/model output is in this receipt or the aggregate. The original snapshot was never used as a writable daemon database. Each control experiment first copied it to a new scratch project's database, appended three synthetic review tasks and used scripted peers. Private HOME, AGENTHUB_HOME, AMEM_HOME and agent homes prevented access to account or memory state. No native agent or real model was started.

Read-only current-source probes used a readonly Bun SQLite handle with query_only and Board's read methods. Control probes adapted the existing scripts/benchmarks/control-write-latency.ts runner: replace synthetic board seeding with the snapshot copy plus synthetic review rows, preserve the production startDaemon/Tasks/Bus/ControlClient path, and emit aggregate timings only. The copied delivery journal retained its historical rows. Synthetic event-log bulk seeding was disabled; the person's event log was not replayed. Startup is timed separately.

The matched-config runs loaded the copied configuration and routing, with explicit isolation differences: fresh empty memory store enabled; native memory capture, inference, triage, MLX and task sweep disabled; WIP limits set to 32 for the scripted batch; batching set to zero; PII screening scripted clear; outbound fetch refused. Research and snapshot settings otherwise followed the loaded configuration. This is not a claim to reproduce the live memory repository, external services, native session state or concurrent activity.

## Source and measurements

All diagnostics ran on the same Mac, darwin/arm64, Bun 1.4.3. They are bounded private-copy profiling, not a test gate or a pinned-Bun live-binary reproduction. The 0.27.0 source is tag v0.27.0, commit 1d0557d6ee7f6e1b48416e5905865704b35c9dbe, using the installed runtime's exact agent-mem 0.18.0 dependency through an own-worktree symlink. The current source is e2ff29696d6a5ddb7a9232c4aadeb7fc97995794 with agent-mem 0.19.0. No dependency was installed or changed on the Mac.

A token-free status copy confirmed the running hub was 0.27.0, protocol 16, without tool_write_idempotency. The released-source comparisons below are separate from the running process; it received no profiling requests.

Read-only current-source observation: Board.list 100.60 ms, Tasks construction 132.49 ms, all 670 publicView projections 142.67 ms, statusTasks 0.44 ms, stalled 0.68 ms and pendingOffers 0.18 ms. An earlier independent SQLite select/decode observation was 4.09/12.47 ms. These are single observations, not latency distributions or proof that repeated scans can never accumulate.

Each control phase has only three successful samples. The reported p95 is nearest-rank, therefore the maximum of those three samples. It is not a stable production percentile. Values are request round trips in milliseconds:

| Source / fixture | Review p50 / p95 | Backlog propose p50 / p95 | Claimed propose p50 / p95 | Delivery complete p50 / p95 |
| --- | --- | --- | --- | --- |
| Current, isolated core | 67.70 / 78.34 | 31.80 / 32.22 | 86.74 / 87.95 | 18.00 / 18.62 |
| 0.27.0, isolated core | 89.69 / 103.84 | 28.07 / 28.43 | 81.62 / 89.19 | 20.43 / 20.68 |
| 0.27.0, matched config with isolation | 137.69 / 146.96 | 34.71 / 35.46 | 144.18 / 145.91 | 19.38 / 20.48 |
| 0.27.0, same config with hook spans | 134.30 / 144.84 | 33.77 / 34.75 | 141.73 / 146.71 | 21.35 / 21.94 |

The last run also exercised the console's real task_assign operation: 186.26 / 192.51 ms, three successful assignments. Assigned tasks remain proposed until their owners accept, as expected. Startup ranged from 330.14 ms to 1,662.28 ms and is excluded from the table. No speedup claim is made from comparisons with different versions, configuration or instrumentation.

## Shared hook observations

Both board writes and delivery completion synchronously refresh queue/status state in daemon.ts. Board.onChange calls settleSupersededDeliveries and writeStatus; bus.onQueues also refreshes holds and status. In addition, Bus.refreshRecoveryHold reads journal.list(peer), which includes historical completed deliveries. These are plausible accumulation points absent from the earlier zero-delivery synthetic fixture, but the copy measurements did not show the reported stall.

The last run wrapped the real board.onChange and bus.onQueues callbacks, retaining their behavior. Across three samples per phase, aggregate board-hook / queue-hook times were:

| Phase | Board hook total ms / calls | Queue hook total ms / calls |
| --- | --- | --- |
| Review | 179.69 / 6 | 90.21 / 18 |
| Backlog propose | 91.97 / 3 | 0 / 0 |
| Claimed propose | 223.18 / 9 | 0 / 0 |
| Assignment | 116.67 / 3 | 77.33 / 15 |
| Delivery complete | 0 / 0 | 58.45 / 6 |

These spans nest inside writes and sometimes inside one another; do not add them to round-trip times. They do not separate SQLite fsync/checkpoint time from the rest of a write. The original active WAL, lock holders and their timing are not retained by an online backup, so transient disk/lock behavior remains unverified.

On the snapshot, tasks 667 and 668 went from proposed to lifecycle linked to assigned within 52 and 54 ms respectively. Their first proposed timestamps are 2026-11-02T20:55:33.856Z and 20:56:34.404Z. This bounds those recorded transitions only: no request-start or reply timestamp is present, so it cannot establish their complete tool-call latency.

## Replay coverage finding

Source audit at e2ff2969 confirms toolWriteOperation recognizes task propose and review, plus delivery_complete for unknown-outcome handling. Delivery completion uses the journal's natural idempotence rather than registry capacity. Task accept, task_assign, done, decline and cancel are outside that operation set; transport uncertainty/replay protection must not be described as covering every write. No timeout retry was injected in this investigation.

The four accept entries on task 668 were deliberate plan revisions as the implementation scope grew, not evidence of a timeout retry. A separate controlled test is needed to demonstrate a lost-response retry for accept or assignment before expanding their idempotency contract. The running 0.27.0 process also lacks the feature shipped in the later source; a source merge is not live activation.

## Result and next step

No causal production fix is justified by these observations. The copy rules out a deterministic 30-second stall for these particular sampled inputs and isolated configurations; it does not exonerate every local path. Live memory-store contention, MCP stdio handling, queued socket work, concurrent background passes, external metadata calls and intermittent filesystem delays remain unmeasured.

Next, in a separately approved instrumentation change, record bounded metadata-only monotonic spans at client send/receive, daemon receive/reply, and the board/queue/status/memory/external-call boundaries. Include event-loop delay so queued admission can be distinguished from post-write work. Use counts, operation names and opaque correlation IDs, never payloads or task text. Deploy through the normal reviewed release/upgrade process and capture one naturally occurring stall before choosing a fix. Do not raise the 30-second timeout or WAL/resource thresholds. This task did not deploy, restart, upgrade, inject a failure into, or attach a profiler to the live daemon.

The [aggregate JSON](2026-11-03-live-board-latency.json) contains counts and timings only, SHA-256 e44ef37a822b350673064f2d2640c372bb51725bd8ad5152d3d8c38e7f8cc65d. Harness hashes identify the private adapters of the existing runner; raw inputs and account/environment state are intentionally not published. This is a findings receipt, not an exact reproduction package or before/after fix receipt.
