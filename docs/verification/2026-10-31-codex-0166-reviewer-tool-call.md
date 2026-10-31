# Codex 0.166.0 reviewer tool-call receipt, failed marker check

Result: the single authorized native review persisted one approved verdict through production stdio MCP and `Tasks`, but the required private synthetic marker was absent. The full receipt failed and 0.166.0 was removed from the proposed verified set. No model retry was made. Date: 2026-10-31, macOS arm64, Bun 1.4.2. Scope: issue #888, task 579, PR #997 connector P1. The positive [model-free receipt](2026-10-31-codex-0166-reviewer-isolation.md) remains available and does not independently qualify the version.

## One production review

This repeated the [0.164.0 fixture](2026-10-25-codex-0164-reviewer-tool-call.md) using the actual `startDaemon`, `ReviewerPrintPeer`, `codexReviewerBackend`, stdio plugin and `Tasks`. A temporary builder proposed and accepted one synthetic arithmetic task. Its temporary console assigned `codex-review`; builder completion triggered the real native reviewer. The harness never invoked `hub_review` itself or substituted a tool result.

Read-only SQLite inspection found state `approved`, reviewer `codex-review` and exactly one persisted reviewer verdict. The stored task refs and running-child binding matched the synthetic fixture head. Two successful `hub_review` observations were retained at the production trace observer; host and native observations may duplicate one invocation, so they are not claimed as two distinct calls. No `hub_task_show` observation was retained.

The private-marker check returned false. The marker was placed in task detail, while the accepted plan contained no marker. Current `Tasks.reviewRequest` omits task detail when a rendered plan is present. This is a fixture-visibility concern, but the retained metadata does not establish whether model omission or host screening caused the missing marker. Raw prompts and model prose were not preserved. The next attempt's fixture correction is to place the marker in the done summary or accepted plan, where the reviewer is actually shown it, and assert model-free that the rendered review request contains it before consuming a new model-run authorization. This is a fixture correction, not an established 0.166.0 defect. Successful native verdict persistence does not waive this task's explicit marker requirement.

| Evidence | Observed |
| --- | --- |
| Tested source head | `894a590fd0c1312adb165ace5b49f0d542185b41` |
| Native version / production binary identity | 0.166.0 / `sha256:77c2eae1013cec5acaa8a2d980bb760a7ca7657ebb9cb3033550cad787ab2fdd` |
| Backend source SHA-256 | `8e6ce4e64c6787a81e48a97172d25bbf1876ae5bc24a54934e7a107075a72214` |
| Stdio plugin SHA-256 | `2cc09f4fd8916861586fe2d962e6520437b555bc4590df319fde0b614a43a879` |
| Startup profile SHA-256 | `cf0eded7535d42f115de1675929c889fc9ccae3aebb451f2a922e02dea4ce3da` |
| Actual review profile SHA-256 | `dcadeea11ba12471f6a2f7cfd30a86c362758d846d50e2ccaf7347a17c9ca148` |
| Fixture task / reviewer | 1 / `codex-review` |
| Fixture head | `9ef3805146367c58d391afb25816056107433e9d` |
| Persisted state / verdict count | `approved` / 1 |
| Stored refs and running review head matched | true |
| Required marker matched | **false** |
| Marker SHA-256 | `a62118802585320868c5432c031e3c40c841a8a7e92674e700eefaaf476abea6` |
| History SHA-256 | `aac0fab5efe89e27cfe14fb186e04df0d24c011d80f9156ca0a9b9083645e069` |
| Review attempts / delivery states / final peer state | 1 / accepted, completed / idle |
| Fixture start / verdict readback, UTC | 03:54:18.164 / 03:54:36.045 |

## Isolation, authorization and cleanup

The controller acquired the local repository lock before creating fresh HOME/CODEX_HOME and one auth.json symlink to the configured account. No personal configuration or credential value was copied or read by the harness. 17 bounded private roots covered the original account and the original HOME's credential locations, in addition to production's private state and native canaries. No production task, daemon, PR assignment or personal machine trust was changed by the fixture.

The actual review receipt retained `readOnly: true`, `strictMcp: true`, `ephemeral: true` and all 14 model-free evidence markers. Effective Apps/plugins/hooks and legacy notify remained disabled; only the two hub review tools were configured, with per-tool approval overrides. The existing public-read, private/glob/symlink, portable-core, credential-root and write-denial native canaries passed. No separate effective network-isolation or web-search model-turn readback is claimed.

A persistent exclusive authorization file and a wrapper around the original production review entry prohibited a second review attempt. The trace observer delegated to the original method and recorded only tool names, refusal booleans and the immutable running head. It did not grant tool or verdict authority. The immutable backend object and production source were not changed. The fixture deadline remained 110 seconds and controller deadline 120 seconds.

Before the actual run, a setup-only attempt failed while installing an observer on the immutable backend, before daemon startup, an auth link or any model review. The corrected setup-only attempt passed with zero native preparations and zero model requests, without an auth symlink. This did not consume the actual model authorization.

After the one actual attempt, production daemon/process-group teardown was awaited, the driver group was absent and an additional fixture-root argv scan found zero matching processes. The controller released only its own inode/owner-bound lock. The auth symlink, fresh homes, project, task state and temporary directory were removed. This is bounded cleanup evidence, not universal orphan detection. The fail path did not separately read back the synthetic source file before removing it, so no measured unchanged-source claim is made for this attempt.

The source-account auth metadata was unchanged before/after: both hashes were `09a890fea6df1c2c40e746b479336e26d74482127916449126e37930bba9b62f`, without reading credential contents. Private proof metadata was mode 0600, 3477 bytes, SHA-256 `680ed4ee54b7c7825a6472e14c66e74295b7aa84c689f67421c5e01c9676a252`; the harness output log was empty. Account paths, token values, marker value and model prose are omitted here.

## Decision and limits

The connector finding is addressed by removing automatic version admission. Verified versions remain 0.146.0, 0.163.0 and 0.164.0; the ordinary person-owned exact-version trust path and all runtime proofs remain unchanged. This failed receipt is preserved alongside the positive model-free inventory. Any later model attempt needs a new authorization; none is implied by this record.

This establishes that a native 0.166.0 verdict reached the temporary production host boundary. It does not establish the complete required marker-bearing receipt, production deployment, Linux behavior or every reviewer workflow. The changed-source gate and hosted CI at the subsequent documentation/rollback head are separate evidence on the PR.
