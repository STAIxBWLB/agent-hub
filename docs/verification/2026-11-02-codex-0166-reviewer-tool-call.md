# Codex 0.166.0 corrected reviewer tool-call receipt

Result: passed. One newly authorized native review persisted one approved verdict with the required private synthetic marker and exact fixture head. Date: 2026-11-02, macOS arm64, Bun 1.4.2. Scope: issue #888, hub task #625. This supplements the [model-free isolation receipt](2026-10-31-codex-0166-reviewer-isolation.md) and preserves the [failed 2026-10-31 marker receipt](2026-10-31-codex-0166-reviewer-tool-call.md). No native model retry was made.

## Fixture correction and model-free proof

The earlier fixture put its marker in task detail, which the production review request omits when an accepted plan exists. A review-only reviewer also receives a withheld done summary. The corrected fixture places its instruction and marker in one accepted `plan.risks` item under the 512-character item limit. Product behavior is unchanged; `Tasks` was not edited.

The committed `test/review-scope.test.ts` regression observes the actual `Tasks` review envelope through the bus. It asserts that accepted plan text reaches a code-scope, review-only reviewer while detail and the done summary remain withheld. Before the native run, exact-head dgx02 verification at `d3d926237eedaca59231e913628d98885dc05fef` returned 20 pass, 0 fail, 105 assertions and `check: OK (changed)`.

The native harness also inspected the production review envelope immediately before entering the original `ReviewerPrintPeer.review`: marker present, review-only summary withheld. Only after this assertion did it consume its persistent exclusive one-attempt fence. The observed envelope itself and marker value were not retained in the repository.

## One production review

The fixture used production `startDaemon`, `ReviewerPrintPeer`, `codexReviewerBackend`, the stdio plugin and `Tasks`. A temporary builder proposed and accepted a synthetic arithmetic task; a temporary console assigned its reviewer; builder completion triggered the native review. The harness neither called `hub_review` on the model's behalf nor substituted its verdict.

| Evidence | Observed |
| --- | --- |
| Tested source head | `d3d926237eedaca59231e913628d98885dc05fef` |
| Native version / binary identity | 0.166.0 / `sha256:77c2eae1013cec5acaa8a2d980bb760a7ca7657ebb9cb3033550cad787ab2fdd` |
| Backend source SHA-256 | `8e6ce4e64c6787a81e48a97172d25bbf1876ae5bc24a54934e7a107075a72214` |
| Stdio plugin SHA-256 at native run | `dda1558792bd2daae85d562ab3953cb3d253dd1fb7e5cee8ae7edd203d8e8a65` |
| Startup isolation profile SHA-256 | `d9da3aedb1361596675b2d692d1c2d6b61d535054a14c9a0574b8daca9fb1019` |
| Actual review profile SHA-256 | `4a20862407a5b604a8126cf59a3d1b8edaaf6aa631f58a0fbc09c36b92451f8e` |
| Fixture task / reviewer | 1 / `codex-review` |
| Fixture head | `27ed7ec3a56c1caf8c8b0a1b280019b149e96372` |
| Persisted state / verdict count | `approved` / 1 |
| Stored refs and running review head matched | true |
| Required marker matched | true |
| Marker SHA-256 | `b173f3b2d6d5177ab83637e2aaea40a2c2ef4931a0f7f0ec4e474001ff4dc8de` |
| History SHA-256 | `5ceab0bbe4bde8595dd30118d56f10b7e55c8facbabddb5fdc927490c04ce6f3` |
| Review attempts / delivery states / final peer state | 1 / accepted, completed / idle |
| Fixture start / verdict readback, UTC | 2026-11-01 23:36:58.064 / 23:37:11.189 |

The production trace observed successful `hub_task_show` and `hub_review` calls bound to the fixture head. Host and native tracing each observed them, so the two observations per tool are not claimed as distinct model calls. Read-only SQLite readback found exactly one persisted reviewer verdict.

## Isolation and cleanup

`dot admit` admitted the Mac preparation and native run. The controller held the repository lock before creating fresh HOME, CODEX_HOME and TMPDIR. One `auth.json` symlink referenced the configured account; no credential value or personal configuration was read or copied by the harness. The source worktree had a frozen dependency installation. The fixture used exact-version admission only in its fresh temporary hub home; it changed no real machine trust record. Eighteen bounded private roots covered the original configured account and the original HOME's credential locations, alongside production's private-state and canary denies.

The actual isolation receipt retained `readOnly`, `strictMcp` and `ephemeral`, all true, and all 14 model-free evidence markers. Apps, plugins, hooks and legacy notify were disabled; configured tools were exactly the two hub review tools with per-tool approval. Public-read, exact/glob/symlink private-denial, portable-core, credential-root and write-denial canaries passed. Effective network isolation and web-search behavior in the model turn were not separately measured.

The setup-only rehearsal returned zero native preparations and zero model requests, without creating an auth symlink or consuming the model fence. The actual run used that fence once, with the existing 110-second fixture and 120-second controller deadlines. No product source or immutable backend object was modified.

Before cleanup, `score.ts` was read back and still contained the expected synthetic source. Account auth metadata was unchanged, with before/after SHA-256 `d96bfccc2a92e15d7e437ba24bb7b0669703c5e5bb7daceef01be05c5c94a4fd`; this fingerprint covers filesystem metadata, without reading credential contents. Production whole-process-group teardown was awaited; the driver group was absent and the bounded fixture-root argv scan found zero remaining processes. The controller released only its own inode/owner-bound lock. The auth symlink, temporary homes, source project and task state were removed.

Private proof metadata: 4398 bytes, SHA-256 `c5fc7859b2bf81727f57c0558230c569ccea1e36b0799747b9436a986cae2ca0`; harness log length 0 bytes. Account paths, token values, marker value and model prose remain outside the repository.

## Admission and limits

This complete receipt qualifies 0.166.0 for `COMPAT["codex-review"].verified` alongside 0.146.0, 0.163.0 and 0.164.0. It changes neither attached-Codex compatibility nor the exact-version trust path, runtime proofs or isolation boundaries. The model-free inventory alone remains insufficient for admission.

This is one synthetic production-boundary receipt on macOS. It does not establish deployment, native Linux behavior, every review workflow or universal orphan detection. The pinned-Bun generated bundle and changed-source/hosted CI gates at the final PR head are separate evidence from this model run.
