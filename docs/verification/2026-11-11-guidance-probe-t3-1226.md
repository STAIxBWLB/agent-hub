# Guidance probe T3 qualification

Date: 2026-11-11. Refs #1226. This is a human verification record for host-sealed
receipts, the outcome denominator, crash reconcile and owned-output prune. It is not
a live trial and no real model, native session or account was used.

## Scope and authorization

T3 adds a private `guidance_probe_receipts` table, `sealReceipt`, `receipts`,
`outcome`, `reconcile`, `previewPrune` and `prune` to `GuidanceProbeStore`, pure
receipt, comparability and retention types in `guidance-probes.ts`, and output
collection and owned removal in `src/local/probe-workspace.ts`. The adapter harvests
the declared output before the confinement stop releases the workspace and reports the
measurement on the observation; the fixture host samples `startedAt` and seals.

No CLI verb, wire operation, daemon runner, config key or live launch is added, and
nothing selects the constructor-only adapter. Public `show` keeps only `comparable`,
now the older expression AND the sealed-receipt verdict, so it can only get stricter.

Fixtures and fakes are source evidence. They do not prove OS confinement, provider
behavior, sampling control or model quality. The live trial stays unapproved (T4).

## Contract points and the check that observes each

| Point | Check |
| --- | --- |
| Receipt is host computed; a caller can ask for a success but not force one | `test/guidance-probe-receipts-store.test.ts` sealing cases: any gap in served model, teardown, usage, coverage or output downgrades to `unknown` |
| A conflicting replay latches the observation hold and the refusal is raised after the commit | Store replay-conflict case reads the persisted hold after the throw |
| A reserved or running session left by a crash is `unknown_held` with an `unknown` receipt; reconcile is idempotent and a read-only open never writes | Store reconcile cases, including a second call writing nothing and a reopened read-only open |
| The denominator counts every reserved slot; a missing or reconciled receipt is `unknown`, never `failed` | `test/guidance-probe-receipts.test.ts` counts and the control test for a settled session with no receipt |
| Comparability reasons and counts stay private; public `show` carries only the flag | `test/guidance-probes-control.test.ts` asserts the reasons and `counts` are absent from the public JSON |
| The 1 GiB cap holds at runtime | adapter tests: output past the cap is excluded, never hashed or retained; scratch past the cap carries `storage_over_cap` |
| Output is collected before the workspace is released | adapter test whose fixture stop removes the workspace; moving the harvest after `close` fails four tests |
| Prune acts only after `expiresAt`, only on a terminal and unheld experiment, only with the current plan digest, and only on files whose recorded identity still matches | Store prune cases and `test/guidance-probe-cleanup.test.ts` (swapped file, swapped directory, empty swapped directory, hardlink) |
| Prune never deletes a receipt or manifest | Store case comparing receipts before and after a prune |
| A slot is marked pruned only when nothing was kept | mixed-slot case where one file is swapped between preview and prune |
| Integrity covers receipts; an orphan receipt row fails recovery | Store integrity cases |

Mutation checks (each reverted afterwards, final tree equals the tested tree): ignoring
`expiresAt`, pruning a held or active experiment, skipping the plan digest check,
deleting the receipt row on prune, marking a slot pruned although a file was kept,
harvesting after the close, dropping the over-cap limit and retaining past the cap
each fail at least one test. One mutation (teardown always verified) was not caught by
the adapter file because the fixture stop never fails; the Store cases cover the
downgrade, and a failing close is covered by the existing T2 interrupted-close cases.
A first draft of the mixed-slot assertion survived its mutation and was rewritten
until the mutation failed.

## Locks

No `GuidanceProbeStore` file lock is used. Receipts and prune plans run in the Store's
SQLite transaction, so no stale-holder recovery exists to test. If a file lock is ever
needed it follows `SourceRegistry.locked` with a two-recoverer test (#329).

## Gates

Typecheck, the six probe test files, the docs check and the hardcoded-values inventory
were run locally and report in the PR. `scripts/check.sh --changed` runs on dgx02 at
the committed head and is reported with the head SHA in the PR and `hub_task_done`.
Hosted CI is the gate for the full suite.
