# Control write outcomes and latency, 2026-11-02

Refs #1078, task #631.

## Pre-change measurement

Source plus fixture commit: `5e3a59a8168d61e6aff38027d86ef53a7283abb3`, based on main `8511d01a`.
Run: dgx02 `remote_dev.py verify`, pinned Bun 1.4.2, linux/x64; exit 0 in 25 seconds.
Command: `bun install --frozen-lockfile && bun scripts/benchmarks/control-write-latency.ts`.

The isolated fixture seeded 600 tasks, 12 history notes of 4096 bytes per task, a 30,617,600-byte database and a 110,100,480-byte (105 MiB) event log with 215,040 synthetic rows. Startup, including event-log reads, took 1106.66 ms and is excluded from write round trips. There were 20 samples per phase, all successful; p95 is the nearest-rank 19th sample. The host is shared; this is not a dedicated-host or cross-platform performance guarantee.

| Operation | Samples | p50 ms | p95 ms | Board.list calls | Rows decoded |
| --- | --- | --- | --- | --- | --- |
| review_approved | 20 | 269.32 | 326.65 | 180 | 92300 |
| proposal_backlog | 20 | 57.52 | 69.66 | 40 | 21100 |
| proposal_claim | 20 | 448 | 486.09 | 260 | 150340 |
| delivery_complete | 20 | 7.33 | 28.33 | 0 | 0 |

Measurements are actual ControlClient request round trips through production startDaemon/Tasks/Bus, not the MCP stdio wrapper. Board timings observe nested synchronous methods, so their durations must not be added to write durations. The completed-delivery phase uses an accepted journaled delivery from a synthetic peer. HOME and agent homes are private fixtures; inference, memory and MLX are disabled, PII screening is scripted clear, and no native agent, account or model is called. No real hub board or person configuration is modified.

Aggregate machine receipt: [baseline JSON](2026-11-02-control-write-baseline.json), SHA-256 `d967281b6d5e28bb42dc7a6dae0edd986834763fab151842f960db21def6906b`. It contains counts and timing metadata only.

## What the measurement establishes

The 35-45 second production symptom is not reproduced by this database/log-size fixture: all four measured p95 values are below 0.5 seconds before behavior changes. Repeated full Board.list decoding is a measurable cost (9 scans per review and 13 per claimed proposal), but this does not establish it as the cause of the reported production stalls. The measured completed-delivery path performs no Board.list calls. External/model-screen waits and the channel MCP wrapper are not measured here; no timeout is widened and no speculative Board cache is added on this evidence.

## Measured privacy-read hot path

The first guarded implementation at `7615b065fcc5a6c0f9e0fd78fa4daed1531b4f5a` exposed three additional full Board.list scans per claimed proposal: 320 calls over 20 samples, versus 260 before the change, with claim p95 634.64 ms. The [intermediate receipt](2026-11-02-control-write-guarded.json) is retained rather than overwritten.

The privacy predicate needs only state and signal flags for tasks owned or reviewed by that peer. A fresh Board.peerTaskSignals query now reads just those fields, without decoding unrelated titles, plans or histories. The daemon retains the same `isClosedTaskState` and `Tasks.isPii` predicates, including the current routing policy; no privacy result is cached. Corrupt required signal data fails closed, while unrelated history bytes are not a privacy input. The benchmark separately counts these fresh projections.

## Post-projection measurement

Source snapshot `2adfd6bd0e108baec09b9c75e937b162ff6e316c` used the same 600-task/12-note/105 MiB fixture and 20 samples per operation. All 80 operations succeeded. The aggregate [post-change receipt](2026-11-02-control-write-after.json) has SHA-256 `44e932568954c387d9a278f4c3bc5c1d0cb01e23dda4550981db8db17afcaa0e`. It measures the source snapshot, independently of later invalid-input-only compatibility checks and documentation commits.

| Operation | p50 ms | p95 ms | Full Board.list calls | Fresh signal projections | Projection ms (total) |
| --- | ---: | ---: | ---: | ---: | ---: |
| review_approved | 247.64 | 301.97 | 140 | 40 | 7.28 |
| proposal_backlog | 60.86 | 75.6 | 40 | 0 | 0 |
| proposal_claim | 473.43 | 529.83 | 260 | 60 | 9.21 |
| delivery_complete | 8.89 | 26.97 | 0 | 0 | 0 |

Claim full scans returned from 320 in the first guarded version to 260, with all 60 new privacy projections still executed. Those projections took 9.21 ms total across 20 claims; they are fresh reads rather than cached decisions. Review full scans fell from 180 to 140. Shared-host timing variation prevents a general speedup claim; the measured p95 values and scan counts are reported without discarding the intermediate run. The reported live 35-45 second delay remains unverified.

## Implementation and verification

Replay over the authenticated control connection applies to `hub_task_propose`, `hub_review` and `hub_delivery_done`. The control message carries `requestId` separately from transport `rid`; duplicate calls keep their own transport correlation while joining one pending write or returning its first retained result. A changed actor/role/launch/execution scope or changed arguments cannot reuse that ID. Current authority/privacy gates still run before results leave the daemon. Deterministic read-only, capability and reviewer denials use the original pre-effect validation and retain their specific error/isError behavior. Malformed review identifiers reach the strict task validator before authority coercion. Invocation retains its existing admission/cancellation protocol.

The additive `tool_write_idempotency` feature enables automatic request IDs in current clients. Legacy calls without IDs retain their execution behavior. A client never resubmits an explicit replay to a legacy daemon that would ignore its ID. Timeout, cancellation after sending and socket loss report an unknown outcome, name a settling read (`hub_task_list`, `hub_task_show`, or the person's/conductor's `ahub queue show`), and do not automatically retry. The channel keeps unknown outcomes out of the generic `isError` retry path.

The daemon retains up to 512 keys and 64 KiB per result within a 15-minute replay window. In-flight keys never expire into a second execution. Expired or different-instance IDs are refused without reapplying; a monotonic wall-clock watermark prevents a backwards clock jump from reviving an expired ID. Capacity refuses new writes rather than evicting a live key. Unexpected failures or oversized results retain a bounded unknown receipt, not a second effect. This is an in-memory, per-daemon contract, not a durable cross-restart result ledger; a prior instance's ID is unknown after restart and is never applied by a current supporting daemon.

Cached overlap metadata is also bound to the current visibility of its referenced tasks. Up to 64 unique formatted overlap references are checked with fresh id/signals-only queries, including completed tasks; private, missing or ambiguous references withhold the cached text without another effect. The regression first failed with a real cached path after only the other owner's task became PII, then passed with the referenced-task guard.

The channel retains 512 live MCP-to-wire mappings and at most 65,536 hash-only seen-ID tombstones per plugin process, so an expired MCP ID does not become a fresh write. Changing the arguments for one typed MCP request ID reuses its token and reaches the server's conflict refusal. A full identity history fails closed; a durable outcome ledger is the upgrade path for higher sustained volume.

Helper/client focused verification at `bd7f723444595b94e7f2b8176417c6a5f0a87871` passed 27 tests and typecheck on dgx02. Integrated focused verification at `7615b065fcc5a6c0f9e0fd78fa4daed1531b4f5a` passed 65 tests and typecheck; projection verification at `2adfd6bd0e108baec09b9c75e937b162ff6e316c` passed 66 tests across eight files, typecheck and a byte-identical pinned bundle rebuild. Final focused verification at `e3bee9ac94d9cd0c9910dfd4639c4f245c18753d` passed 69 tests, 550 assertions across eight files, typecheck and bundle freshness. It includes preserving uncertainty metadata through the last authority reply fence, while legacy replies stay unchanged. Final changed-gate results and hosted CI state are recorded against the exact reviewed head in the PR and task #631.

The first full changed-gate attempt at `3dd0a0480db4ca0d768184afec30f2a5c79f8faa` was stopped by the implementer (exit 130 after 698 seconds), not passed. It exposed 24 compatibility failures: static recovery metadata could not parse a computed feature entry, known permission denials had become unknown information responses, and a VM fixture lacked the new peer-signal read port. The production literal declaration and known-refusal path were corrected; the existing fixture gained its required port with no assertion weakened. The cached-overlap PII issue was separately reproduced before its fix. Targeted verification at the subsequent source snapshot passed 94 tests, 849 assertions across ten files and typecheck, including the original failing contracts. The final full-gate outcome remains bound to the PR/task head rather than inferred from this earlier attempt.
