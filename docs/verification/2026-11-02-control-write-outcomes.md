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

Per-call replay and unknown-outcome handling are being verified separately from this pre-change measurement. Exact-head focused/gate and post-change measurement results will be recorded before this task is submitted for review.
