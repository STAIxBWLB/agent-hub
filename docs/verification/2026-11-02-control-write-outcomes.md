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

## What the measurement establishes

The 35-45 second production symptom is not reproduced by this database/log-size fixture: all four measured p95 values are below 0.5 seconds before behavior changes. Repeated full Board.list decoding is a measurable cost (9 scans per review and 13 per claimed proposal), but this does not establish it as the cause of the reported production stalls. The measured completed-delivery path performs no Board.list calls. External/model-screen waits and the channel MCP wrapper are not measured here; no timeout is widened and no speculative Board cache is added on this evidence.

## Implementation and verification

Replay applies to `hub_task_propose`, `hub_review` and `hub_delivery_done`. The control message carries `requestId` separately from transport `rid`; duplicate calls keep their own transport correlation while joining one pending write or returning its first retained result. A changed actor/role/launch/execution scope or changed arguments cannot reuse that ID. Current authority/privacy gates still run before results leave the daemon. Invocation retains its existing admission/cancellation protocol.

The additive `tool_write_idempotency` feature enables automatic request IDs in current clients. Legacy calls without IDs retain their execution behavior. A client never resubmits an explicit replay to a legacy daemon that would ignore its ID. Timeout, cancellation after sending and socket loss report an unknown outcome, name a settling read (`hub_task_list`, `hub_task_show`, or the person's/conductor's `ahub queue show`), and do not automatically retry. The channel keeps unknown outcomes out of the generic `isError` retry path.

The daemon retains up to 512 keys and 64 KiB per result within a 15-minute replay window. In-flight keys never expire into a second execution. Expired or different-instance IDs are refused without reapplying; a monotonic wall-clock watermark prevents a backwards clock jump from reviving an expired ID. Capacity refuses new writes rather than evicting a live key. Unexpected failures or oversized results retain a bounded unknown receipt, not a second effect. This is an in-memory, per-daemon contract, not a durable cross-restart result ledger; a prior instance's ID is unknown after restart and is never applied by a current supporting daemon.

The channel retains 512 live MCP-to-wire mappings and at most 65,536 hash-only seen-ID tombstones per plugin process, so an expired MCP ID does not become a fresh write. Changing the arguments for one typed MCP request ID reuses its token and reaches the server's conflict refusal. A full identity history fails closed; a durable outcome ledger is the upgrade path for higher sustained volume.

Helper/client focused verification at `bd7f723444595b94e7f2b8176417c6a5f0a87871` passed 27 tests and typecheck on dgx02. Integrated exact-head, bundle, changed gate and post-change measurement evidence is still pending and will be recorded before review submission.
