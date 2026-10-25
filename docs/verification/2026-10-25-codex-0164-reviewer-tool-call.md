# Codex 0.164.0 reviewer tool-call receipt

Result: one real model review recorded one approved verdict through the production stdio MCP and `Tasks` boundary. Date: 2026-10-25, macOS arm64. Hub task: 465; Refs #783. The successful run took approximately 30 seconds, from 04:26:28 UTC to 04:26:58 UTC. No production task, PR, daemon or personal MCP configuration was changed.

## Execution and identity

The fixture used production `startDaemon`, `ReviewerPrintPeer`, `codexReviewerBackend`, the stdio hub plugin and `Tasks`. A builder proposed and accepted one temporary task, the fixture console assigned its reviewer, and builder completion triggered the actual native model process. The fixture never called `hub_review` itself or substituted a fake tool result. Success required a persisted reviewer verdict containing the task's private synthetic marker; a model chat answer would not satisfy the check.

| Evidence | Observed value |
|---|---|
| Native version | `0.164.0` |
| Backend-reported binary identity SHA-256 | `5b9983835177b544bba49d54b6679faf2f833a8b278068a158698f5c4eef1395` |
| Tested backend-source SHA-256 | `0f76a216b51884909987e64af08ff92d2c90b8d28086ed523fefe211e4feb78e` |
| Tested stdio plugin SHA-256 | `55b8b41c2e78b038d8422f9680ef7895f711cfaf8c83fbe849f9d280bb6edee9` |
| Startup admission profile SHA-256 | `cbfe3fc42ebe09064e0c03c64e69913c9c348f07d0617f040144abccd2d50519` |
| Fixture head | `fe03a0ab4147be4ccfce8226fbc679aa9e3580e2` |
| Fixture task / reviewer | `1` / `codex-review` |
| Persisted state / reviewer verdicts | `approved` / `1` |
| Synthetic marker matched | `true` |
| Synthetic marker SHA-256 | `293f1e5564e058979d2d4e1586d2bf4f8e9581eceaccd17346627e48a0b9e6b6` |
| Persisted history SHA-256 | `0301f21d7f02b4c8635abffa0701f965b935793047771c1db1d653798c684ed4` |
| Delivery states / final reviewer state | `accepted`, `completed` / `idle` |

The plugin hash identifies the stdio server artifact used in the native run. The backend ran from the modified TypeScript source with the hash above; the plugin was subsequently rebuilt for packaging. The packaging gate checks that regenerated artifact separately. No model run of the subsequently regenerated artifact is claimed.

The readonly database readback checked the persisted actor, approved state, verdict count and marker. The head was bound to the request and enforced by the production running-child/`Tasks.reviewBindingCurrent` authority checks; the fixture did not perform a separate final SQL head/refs readback. The profile hash above is the initial startup admission receipt. `ReviewerPrintPeer` performs production preparation again for the actual review child; that second profile hash was not separately retained.

## Isolation and native policy

The backend inherits its host environment and does not itself create an isolated home. The fixture supplied fresh HOME and CODEX_HOME directories and only one auth.json symlink to the configured account. It copied no personal configuration or credential value. Eighteen additional absolute private roots covered the original account root and the original HOME's bounded credential locations, because replacing HOME would otherwise hide those locations from the backend's standard credential-root enumeration.

The native preparation receipt reported `readOnly: true`, `strictMcp: true`, `ephemeral: true` and all 14 existing evidence markers. Effective Apps, plugins and hooks were disabled; legacy notify and web search were disabled; the project was untrusted; only the two hub review tools were allowed. The existing native public-read, exact private-path, glob, symlink, portable-core, host-credential and write-denial canaries remained required and passed.

The source change supplies explicit `approval_mode: "approve"` overrides for the two allowed tools. The [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) documents `mcp_servers.<id>.tools.<tool>.approval_mode` with `auto | prompt | writes | approve` values. That reference establishes the format; the actual 0.164.0 native/model result is the runtime evidence here. Native 0.164.0 `mcp get --json` does not echo those approval fields; the inventory proves the enabled-tool and transport contract, not approval-policy readback. The real persisted verdict establishes that the tested model could invoke the allowed review tool through that configuration. Native MCP call-frame counts and a separate `hub_task_show` call count were not retained.

## Admission and cleanup

The controller atomically acquired the repository's existing local heavy-job lock before creating auth links or running native preparation. An existing lock would have caused immediate exit 75 without retry or reaping. Remote-job admission was checked separately by the coordinator; this is not global enforcement.

The fixture deadline was 110 seconds and the controller deadline 120 seconds. The one actual model review finished within both. Cleanup awaited the production daemon and `OwnedPrintChild` process-group teardown. The driver group was subsequently absent, and an additional scan found zero new processes whose argv named the fixture root. That extra scan is limited to the fixture root and is not universal orphan detection.

The source-account auth metadata comparison was unchanged before and after the successful run, without reading credential values. Both metadata hashes were `fa8d925c16ed3503eda3a0cbcb037101fbde4d6bc3b448a9693a39d6ec84fe81`. Temporary auth link, HOME, CODEX_HOME, project and task state were removed, and the controller's own lock was released after cleanup confirmation. The synthetic source file remained unchanged during review.

Private proof metadata remained at mode 0600, 2612 bytes, SHA-256 `eff722e3085acf1a0a21cc6569a793f1eb51e152cfd4a3d57e8d168ce94b9d32`. The mode-0600 harness output log was empty. No credential value, control token, private path, marker value or model prose is reproduced here.

## Earlier attempts and limits

The initial admitted attempt selected PATH's `codex-cli 0.146.0` rather than the separately installed 0.164.0 launcher. Reviewer startup returned successfully, then the fixture's explicit version guard refused before a model-review request. The failure-message hash was `f8b54e55485eb602d97d36e3705a749b21695a3ba3705ce79cb90dec92a9d1c0`, later matched to the harness's own static version-guard error. Positive cleanup was recorded; source-account metadata comparison was not retained on that initial failure path and remains unverified for that attempt.

A separately authorized setup-only diagnosis passed daemon startup and console connection in 0.25 seconds, with zero native preparations and zero model requests. It confirmed unchanged account metadata and cleanup. The harness then selected the retained 0.164.0 launcher explicitly, and the coordinator authorized the single actual model run documented above. There was no automatic model retry.

This receipt proves the tested source/native/model/tool/host round trip in the temporary fixture. It does not prove production deployment, native Linux behavior, an effective network-isolation probe, or every possible reviewer workflow. The installed 0.16.0 runtime remained unchanged; production use still requires a separate release and runtime upgrade.
