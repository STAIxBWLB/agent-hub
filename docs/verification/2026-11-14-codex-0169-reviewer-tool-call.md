# Codex 0.169.0 reviewer tool-call receipt

Result: passed. One authorized native review persisted one approved verdict that carried the required private synthetic marker, with the stored head matching the fixture head. Date: 2026-11-14, macOS arm64, Bun 1.4.4. Scope: issue #888, hub task 931. This supplements the [model-free isolation receipt](2026-11-14-codex-0169-reviewer-isolation.md). No native model retry was made.

## Fixture and model-free proof

The fixture follows the [corrected 0.166.0 procedure](2026-11-02-codex-0166-reviewer-tool-call.md): the instruction and the marker sit in one accepted `plan.risks` item, because the production review request omits task detail when an accepted plan exists, and a review-only reviewer receives a withheld done summary. A throwaway harness outside git (private scratch directory, not a supported command) started the production `startDaemon` with `ReviewerPrintPeer`, `codexReviewerBackend`, the stdio plugin and `Tasks`. A temporary builder proposed and accepted a synthetic arithmetic task (`score.ts` returning `a + b`), a temporary inspector was attached, and the builder's completion triggered the native review. The harness neither called `hub_review` on the model's behalf nor substituted a verdict.

Before the native run, the same harness ran twice (before and after the root move described below) against the committed `test/fakes/fake-codex-reviewer.ts` (no account, no model) and each time returned one approved verdict, one attempt, the marker and head present in the review envelope and the done summary withheld. The harness wrapped the original `ReviewerPrintPeer.review`: immediately before entering it, it asserted that the review envelope carried the marker and the exact fixture head and withheld the done summary, and only then created its persistent exclusive one-attempt fence (`O_EXCL`). The envelope and the marker value were not retained in the repository.

## Four refused starts, before any model request

The native harness was started four times before the run below. Each stopped at `start` with `reviewer isolation unavailable [cause: sandbox_proof]`, before a task existed, so before the fence was created and before any model request. The fence file for the native run did not exist until the fifth start. The cause was the fixture, not 0.169.0:

- The fixture's `local.deny` list named `~/.jcode` among the standard credential and tool-home roots. Bisecting model-free with the committed `prepare`, denying that one path alone fails the sandbox proof for the verified 0.166.0 control and for 0.167.2 as well as 0.169.0, and every other path in the list passes (`.codex`, `.ssh`, `.aws`, `.config`, `.gnupg`, `.claude`, `.kimi`, `.kimi-code`, `.agenthub`, `.kube`, `.docker`, `.netrc`, `.git-credentials`, `Library/Keychains`, `.gemini`, `.qwen`). I did not diagnose why that denial fails the canary and I did not change product code. The fixture list is the harness's choice, not the project's `local.deny` default.
- Two guesses did not help and are recorded so the sequence is complete: moving the per-run root from the scratch directory to the system temp directory (third refusal onward), and running the 0.169.0 prefix from a copy outside `~/.jcode` (fourth refusal; the copy's production binary identity, read model-free, equals the original prefix's).
- The fifth start dropped `~/.jcode` from the fixture's deny list. It passed and ran the review below, with the root in the system temp directory and the prefix copy.

## One production review

| Evidence | Observed |
| --- | --- |
| Tested source head | `dcff79a1e26a4f900d845e55d3ab6693d6ea0d4b`; the branch was later rebased on main, which changed only `quietSyncError` in `src/hub/daemon.ts`, so `src/adapters/` and `plugins/agent-hub/server.js` are byte-identical to the tested tree |
| Native version / binary identity | 0.169.0 / `sha256:5cb2fa931709a799a155da3685c5dcd5be751a26dffdf6d947f4b9d4c5e9d88d` |
| Isolation at start | `readOnly`, `strictMcp` and `ephemeral` true, 14 model-free evidence markers (read model-free from the same binary; the actual review profile hash was not captured) |
| Fixture task / reviewer | 1 / `codex-review` |
| Review envelope before the native call | marker and exact head present, done summary withheld |
| Persisted state / verdict count | `approved` / 1 |
| Stored refs commit equals the fixture head | true |
| Required marker present in the persisted history | true |
| Marker SHA-256 | `d7260ff3c4a66feaa053c9a115d8bb0ce0ba3182e54aa06d3db894cf878eb10c` |
| History SHA-256 | `f085f466c7a62f4c823cf540c42461c00c97c28824068f2c9c4df8e1e18be6c7` |
| Review attempts / final peer state | 1 / idle |
| Fixture start / verdict readback, UTC | 2026-11-14 01:28:34.062 / 01:28:55.510 |

Read-only SQLite readback found exactly one persisted reviewer verdict for the task. The tool trace was not separately recorded for this run, so the receipt rests on the persisted verdict, its marker and its bound head: a verdict stored through `hub_review` bound to the exact head and the marker means the model called `hub_review` with both, which it could only learn from the accepted plan.

## Isolation and cleanup

The fixture used exact-version admission only in its fresh temporary hub home and changed no real machine trust record. The child ran with a clean environment and fresh HOME, CODEX_HOME and TMPDIR. One `auth.json` symlink referenced the configured account; no credential value or personal configuration was read or copied. The run was admitted by `dot admit`.

Before and after the run the account's auth metadata fingerprint (filesystem metadata, no contents) was unchanged: SHA-256 `3f2633eabf64c4e9451ac2a370de140eedb2d555ed577b7e3b5518d380eb7e6f`. The auth symlink was removed, `score.ts` still held its synthetic source, the daemon stopped, and a process-table scan for the fixture roots and the 0.169.0 prefix found zero remaining processes. The per-run roots and the prefix copy were removed. Account paths, token values, the marker value and model prose remain outside the repository.

## Admission and limits

This receipt and the [model-free receipt](2026-11-14-codex-0169-reviewer-isolation.md) together qualify 0.169.0 for `COMPAT["codex-review"].verified` alongside 0.146.0, 0.163.0, 0.164.0 and 0.166.0. It changes neither attached-Codex compatibility nor the exact-version trust path, runtime proofs or isolation boundaries; every launch still runs each proof.

This is one synthetic production-boundary receipt on macOS. It does not establish deployment, native Linux behavior, every review workflow, universal orphan detection, or the effective network and web-search mode in a model turn, neither of which was separately measured. 0.167.0 and 0.167.2 remain unverified.
