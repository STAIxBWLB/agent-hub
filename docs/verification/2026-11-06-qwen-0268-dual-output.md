# Qwen 0.26.8 dual-output attempt, not qualified

Date: 2026-11-06. Task #749, Refs #888, the separate `qwen-dual` row. The [ACP receipt](2026-11-06-qwen-0268-acp.md) does not qualify the TUI. This repeats the [0.26.5 attempt](2026-11-03-qwen-0265-dual-output.md) using the same corrected v2 producer, fixed OpenAI-compatible loopback responses and a private 0.26.1 matched control. No account, real credential or model inference was used.

**Decision: do not add 0.26.8 to `COMPAT["qwen-dual"].verified`.** Required Q2 did not pass. Exactly 0.26.1 stays verified for this entry, and the qwen-dual row is unchanged. This is not qualified, even though the other selected legs passed.

## Artifact and controls

The exact candidate is the ACP receipt's private-prefix `@qwen-code/qwen-code@0.26.8`, npm/upstream commit `21ed8f1efbb351b973d96e2bc9efa78f278df99c`. The control is a separately installed private `@qwen-code/qwen-code@0.26.1`; neither control nor candidate uses the person's global prefix. Both entry files have SHA-256 `113efe4104a9fc66f507d34bfd6abbd896ceb77de47f4b468a0825a327fdc6a5`. Entry equality is not program equality; the runtime is in version-specific chunks.

The runs used a dgx02 Linux x86_64 container and Node 24.22.0. Each case had a PTY, private HOME/cwd, input/event files, scratch git project, synthetic key and deterministic loopback server. The guard positive control passed, every observed Node process loaded the guard, every owned process group was confirmed gone and every fixture root was removed. Model inference calls: 0. Preload evidence is not a kernel network sandbox or an independent audit of arbitrary native subprocess sockets.

The real macOS configuration/global-install snapshot was unchanged across these remote runs: 9,576 entries, same aggregate manifest SHA-256 `7c8dfc2ddfbaf1fdadfbcc78881918d225aeca1393a230fdfb5e0216fcfc97a3`, with the previous receipt's documented snapshot exclusions. No real HOME or global installation was targeted. The optional audio-capture install lifecycle was subsequently replayed in both private prefixes and exited 0, as tracked in the ACP receipt; it cannot make the failed Q2 a pass.

## Observed outcomes

| Check | 0.26.8 | Matched 0.26.1 control |
| --- | --- | --- |
| Q7 version and network-guard positive control | pass, 0.26.8 | pass, 0.26.1 |
| Q2 second submit becomes a separate user turn after the first completes | **fail**: `Q2 fewer than two user events` | **fail**, same error and workload |
| Q3 shell/native MCP `can_use_tool`, allow/deny, TUI Enter, duplicate refusal and read-only control | pass | not selected |
| Q4 external cancel/SIGINT leaves the turn running; person Esc stops it and next turn works | pass, existing ceiling retained | not selected |
| Q5 unread event FIFO does not block the TUI answer | pass | not selected |
| Q6 resume id, no old-submit replay, prior context in resumed request | pass | not selected |

Q2 recorded `prematureSecondUser: false` and `userCount: 1` in both versions. The final assistant contained both submitted markers, followed by one `message_stop`; the required second distinct user event was absent. The matched failure prevents attribution as a new 0.26.8 regression. It also prevents this workload from establishing the queued-submit observation in the [original 0.26.1 receipt](2026-10-25-qwen-dual-output-t0.md). No assertion, workload or timeout was weakened to make Q2 pass.

Q3 observed actual shell and `mcp__t0__t0_echo` requests with exact input, tool-use id and permission suggestions. Allow and TUI Enter produced the one intended effect; duplicate responses were errors without a second effect. Deny left its marker absent and a later turn worked. Read-only commands ran without approval. The tiny native MCP fixture handler ran exactly once and only after allow.

Q4 bound the native TUI PID and process identity before signalling it. It records the same report-only cancellation ceiling, not permission for the hub to signal a person's terminal. Q6 preserved the session id, rotated the event file like the host adapter, retained old input without replay and observed the prior context token in a resumed fixed provider request; model recall quality is unverified.

## Not verified

Q2 on any version with this producer, macOS and other platforms, real account/provider, model choices/quality, token/quota behavior, and a new qwen-dual admission. A scoped native result does not review every upstream source change. Explicit failed and unselected legs remain as recorded. Host tests and exact-head hosted CI are separate PR evidence. No TUI adapter, queue, cancellation policy, real install or existing 0.26.1 admission changed.

## Evidence fingerprints

The corrected producer and JSON results remain outside git under `scratchpad/temp/agent-hub-749`.

| File | SHA-256 |
| --- | --- |
| `qwen-dual-probe-v2.py` | `57714a102ce61083eda04dd092bc837704362428c133f34f6772744508965f93` |
| `qwen-dual-0268-result.json` | `c52155b7338bce515c77aaad1582dc39aed71cca62aebc53eb851b226b073e0a` |
| `qwen-dual-0261-control-result.json` | `867a223826a4e6e8fe31934269649bee90dce26478044a0ef5534202f190211e` |
