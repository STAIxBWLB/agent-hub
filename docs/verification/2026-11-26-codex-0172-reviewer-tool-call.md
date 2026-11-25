# Codex 0.172.0 reviewer tool-call receipt

Date 2026-11-26 KST. Refs #888, hub task 1127. One authorized model-backed review on macOS arm64 with Bun 1.4.4 supplemented the [model-free receipt](2026-11-25-codex-0172-reviewer-isolation.md). **0.172.0 remains unverified for `codex-review`.** The review persisted an approved verdict at the exact fixture head, but the stored verdict lacked the required synthetic marker and the run did not establish the served model ID.

## Fixture and preflight

The procedure followed the [0.169.0 tool-call receipt](2026-11-14-codex-0169-reviewer-tool-call.md). A scratch harness started the production daemon, fresh Codex reviewer and task tool path against a synthetic two-argument addition function. It placed the marker and instruction in an accepted plan risk. A separate account-free fake run persisted one approved verdict with the marker and exact fixture head. Both runs checked the marker and head in the review envelope, confirmed the builder's done summary was withheld, and created an exclusive one-attempt fence immediately before invoking the original review routine.

## One native review

| Evidence | Observed |
| --- | --- |
| Hub source head | `5fccf20115160cdeef2d2ffe601cb53e6d6dac08` |
| Executable SHA-256, before and after | `f30a99714dc984876864239ef60563949b1e21421a7c9180422f51fd39186bc6`, matching the model-free receipt |
| Native preparation | Read-only, strict MCP and ephemeral, with 14 attestation markers |
| Review envelope | Required marker and exact head present, builder summary withheld |
| Fixture head | `a5683ec400bb6987097c074298f371b48a51ab3c` |
| Attempts / native exit | 1 / 0 |
| Tool call | `hub_review` observed, with no refusal recorded |
| Persisted reviewer approval / exact head | 1 / matched |
| Persisted synthetic marker | Missing |
| Served model ID | Unavailable from the observed native turn metadata |
| Reviewer and source after the turn | Idle, synthetic source unchanged |

Read-only SQLite readback supplied the verdict count and head match. The harness recorded only whether the marker appeared in the verdict. The marker SHA-256 was `9d05b1e4978210416f93419dc14d011b6125bbcdd7e0145ef1bd80fcc246340d`. The task history SHA-256 was `36414f44d435c287263d6350b0a19ebbab15a3da343c463983187452a16b994d`. The terminal event provided completion without a served model ID. The receipt records no configured alias in its place. There was no retry.

## Isolation and cleanup

The harness started from an empty inherited environment with separate scratch `HOME`, `AGENTHUB_HOME`, `CODEX_HOME`, `AMEM_HOME`, `XDG_CONFIG_HOME` and `TMPDIR`. Temporary exact-version trust was confined to the scratch hub. One temporary auth symlink referenced the authorized account. The harness did not read or copy the credential contents. It removed the symlink after stopping the daemon, and the source auth file's metadata fingerprint was unchanged. A process-table check found zero remaining processes matching the native fixture root.
