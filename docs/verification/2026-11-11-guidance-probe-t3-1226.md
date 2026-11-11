# Guidance probe T3 qualification

Date: 2026-11-11. Refs #1226. This is a human verification record for host-sealed
receipts, the outcome denominator, crash reconcile and owned-output prune. It is not
a live trial and no real model, native session or account was used.

## Scope and authorization

T3 adds a private `guidance_probe_receipts` table, `sealReceipt`, `settleAndSeal`,
`receipts`, `outcome`, `reconcile`, `previewPrune` and `prune` to `GuidanceProbeStore`, pure
receipt, comparability and retention types in `guidance-probes.ts`, and output
collection and owned removal in `src/local/probe-workspace.ts`. The adapter harvests
the declared output after the confinement stop reported quiescence and reports the
measurement on the observation; the fixture host samples `startedAt` and settles and
seals in one transaction. The daemon calls `reconcile` at start and at the release of a
held recovery.

No CLI verb, wire operation, daemon runner, config key or live launch is added, and
nothing selects the constructor-only adapter. Public `show` keeps only `comparable`,
now the older expression AND the sealed-receipt verdict, so it can only get stricter.

Fixtures and fakes are source evidence. They do not prove OS confinement, provider
behavior, sampling control or model quality. The live trial stays unapproved (T4).

## Contract points and the check that observes each

| Point | Check |
| --- | --- |
| Receipt is host computed; a caller can ask for a success but not force one | `test/guidance-probe-receipts-store.test.ts` sealing cases: any gap in served model, teardown, usage, coverage or output downgrades to `unknown` |
| Fingerprints are the host's own, never the declaration's (F1) | a changed host fingerprint is recorded and yields `input_drift`; a host that could not read them records `null` (unverified coverage); matching ones stay comparable |
| Tokens are this session's and a replay is stable (F2) | per-session `tokensObserved` is not the experiment total; an identical replay after a later session ran, or after a later cancel, returns the stored receipt and latches nothing; a changed measured fact still latches |
| What the host cannot vouch for is `unknown` first (F3) | a crash after a cancel request, or with an elapsed hold, reconciles as `unknown`; a session settled under a cancel is `unknown` unverified and `cancelled` verified; `unavailable` only for a session that never called the model |
| The walk limit never skips silently (F4) | a 9-level output path is excluded as `over_depth`; scratch past the limit is unmeasured and counts as over the cap, in the cleanup and adapter tests |
| Output is read only after quiescence, by descriptor (F5) | the adapter fixture's stop plays a straggler's last write and only a harvest after the stop sees it; a FIFO or symlink swapped in after the `lstat` is excluded without blocking; retention copies the bytes already read and refuses bytes that do not match the manifest |
| Settlement and receipt are one transaction (F6) | every session run through the host has its receipt, even when the adapter measured nothing; a seal that fails rolls the settlement back; an adapter failure is settled `unknown` with a receipt |
| Reconcile is wired (F7) | `test/guidance-probes-daemon.test.ts`: a session a dead process left `reserved` is `unknown_held` with an `unknown` receipt after start, once, with no launch; `test/guidance-probes-recovery.test.ts`: a held recovery target leaves it untouched until release, then reconciles |
| A held experiment expires after the cancel (F8) | not prunable while held, prunable after `cancelIntent`, `usageUnknown` alone never blocks, a receipt is never deleted |
| Hydration checks the session row (N1) | a receipt revision that differs from its session, or a state that session could not produce, is storage corruption |
| A truly read-only open (N2) | a Store opened read-only reads receipts and outcome and leaves every row byte-identical; `reconcile` through it fails |
| Expiry is the Store's clock (N3) | `previewPrune` and `prune` take no time; moving the fixture clock moves expiry |
| A conflicting replay latches the observation hold and the refusal is raised after the commit | Store replay-conflict case reads the persisted hold after the throw |
| The denominator counts every reserved slot; a missing or reconciled receipt is `unknown`, never `failed` | `test/guidance-probe-receipts.test.ts` counts and the control test for a session the host could not witness |
| Comparability reasons and counts stay private; public `show` carries only the flag | `test/guidance-probes-control.test.ts` asserts the reasons and `counts` are absent from the public JSON |
| The 1 GiB cap holds at runtime | adapter tests: output past the cap is excluded, never hashed or retained; scratch past the cap carries `storage_over_cap` |
| Prune acts only after `expiresAt`, only with the current plan digest, and only on files whose recorded identity (device, inode, change time) still matches | Store prune cases and `test/guidance-probe-cleanup.test.ts` |
| A slot is marked pruned only when nothing was kept | mixed-slot case where one file is swapped between preview and prune |
| Integrity covers receipts; an orphan receipt row fails recovery | Store integrity cases |
| Retained output always has an owner (R1) | `test/guidance-probe-retention-ownership.test.ts`, real adapter + Store + fixture host: a fallback model, a failed seal and a lost clock each leave no retained directory and the port's `discardRetained` ran once; a matching model keeps its directory owned by the receipt row; a forged record with the real identity reaches no delete |
| The receipt byte bound holds the largest valid manifest (R2) | `test/guidance-probe-receipts.test.ts` and the Store test: 64 entries with the longest names, and with 64 exclusions, round-trip within the derived `receiptBytes`; a seal of a record hydration would refuse is refused whole, never stored |
| Both walks are bounded in entries (R3) | `test/guidance-probe-cleanup.test.ts`: scratch past the entry cap is unmeasured, output past it is excluded whole as `over_walk_cap` with nothing hashed or retained, the two walks have separate budgets, a directory far over the cap is abandoned in bounded time; an over-long name is `invalid_name` under a digest label, never raw |
| Reconcile visits every experiment and names its failures (N4) | Store test: a corrupt experiment that sorts first is reported with its key and the next one is still reconciled; with no callback the failure is thrown only after every key was tried |
| Integrity cross-checks receipts against sessions (N5) | an edited generation, or a success for a session that did not close, fails the recovery integrity pass |
| An in-flight session blocks a prune on its own (N6) | a cancelled (otherwise prunable) experiment with a running session is `experiment_active` and removes nothing |

Mutation checks (each reverted afterwards, final tree equals the tested tree). Each of
these changes makes at least one test fail: copying fingerprints from the manifest,
tokens from the experiment total, the cause read from live cancel state, unavailable
after a model call, teardown not decided first, the seal outside the settlement
transaction, a held experiment blocking forever, `usageUnknown` blocking, an unchecked
revision, expiry ignoring the clock, harvest before the stop, depth skipped silently,
scratch unmeasured ignored, retention re-reading the path, the daemon never calling
reconcile, the recovery release never calling it, and reconciling while a recovery is
held. Mutation checks for the second review round (each reverted): the host never discarding
unowned output, the adapter trusting any record it is handed, the old 16384 receipt bound,
no entry cap in either walk, reconcile stopping at the first failure, integrity reading
receipts without the session cross-check, and prune without its in-flight guard. Each
fails at least one test. Two things are not mutation-tested and said so: dropping `O_NONBLOCK` is covered
by a test with a 20 s bound that hung, so a regression there fails by timeout rather than
by assertion; and the harvest's own `closed` guard is defence in depth behind the throw of
a failed close, so removing it changes no observable behaviour. An earlier pass found the
teardown ordering test too weak (it survived the mutation) and it was rewritten until the
mutation failed.

## Locks

No `GuidanceProbeStore` file lock is used. Receipts and prune plans run in the Store's
SQLite transaction, so no stale-holder recovery exists to test. If a file lock is ever
needed it follows `SourceRegistry.locked` with a two-recoverer test (#329).

## Gates

Typecheck, the six probe test files, the docs check and the hardcoded-values inventory
were run locally and report in the PR. `scripts/check.sh --changed` runs on dgx02 at
the committed head and is reported with the head SHA in the PR and `hub_task_done`.
Hosted CI is the gate for the full suite.
