# Qwen 0.26.4 dual-output attempt, not qualified

Date: 2026-10-31. Scope: issue #888, task 578, the separate `qwen-dual` row. The [ACP receipt](2026-10-31-qwen-0264-acp.md) does not qualify the TUI contract. This attempted the [earlier Q2-Q7 procedure](2026-10-25-qwen-dual-output-t0.md) using fixed OpenAI-compatible loopback responses, no real model, account or credential. Exactly 0.26.1 remains in `COMPAT["qwen-dual"].verified`; 0.26.4 is not admitted.

## Artifact, scope and controls

The candidate is the private-prefix npm `@qwen-code/qwen-code@0.26.4`, upstream tag/gitHead `715a550cfca0135e00d4015d1ca82a8167e81fff`, Node 24.18.1 on macOS arm64. Artifact integrity and entry/chunk hashes are in the ACP receipt. The retained global 0.26.1 executable was used only as a read-only matched control, always with a fresh temporary HOME/cwd and the same producer/flags; no code was injected into that installation. Its `cli-entry.js` SHA-256 `113efe4104a9fc66f507d34bfd6abbd896ceb77de47f4b468a0825a327fdc6a5` matches the earlier receipt.

Each fixture used PTY 120x40, private input/event files, a scratch git project, synthetic OpenAI-compatible key/model, and a loopback server emitting fixed text/tool-use responses. Native shell and stdio-MCP effects were confined to synthetic marker files. Node builtin TCP/DNS/fetch/UDP guards allowed only loopback and fixture-local IPC. Positive controls passed, every launched native Node PID and observed Node child had a preload record, every owned process group was confirmed gone, and temporary roots were removed. These are application-preload and bounded process observations, not a kernel network sandbox or universal subprocess audit.

## Corrected fixture and observed outcomes

The first producer reported Q2/Q4/Q6 failures on both 0.26.4 and matched 0.26.1. Its Q2 error combined two conditions without retaining which failed; its Q4 required bootstrap-leader survival in addition to the original turn-continuation criterion and signalled the entire group; its Q6 stopped at assistant text before the documented message_stop/persistence boundary and selected the first matching fixture marker from provider input. Those results did not establish new-version regressions and were retained.

The second producer kept the required assertions and added causal observations: wait for a native stream delta before the second submit; require final assistant plus following message_stop; wait until the owned session recording contains the final assistant before restart; classify the latest matching fixture marker and retain all marker matches; bind SIGINT to the actual native TUI PID by input-file argv, process group and start identity. It recorded the separate Q2 diagnostics and event chronology. No timeout was increased and no assertion for a separate queued user turn was removed.

| Check | 0.26.4 corrected producer | Matched 0.26.1 control |
| --- | --- | --- |
| Q7 version and guard positive control | pass, 0.26.4 | bound separately to installed 0.26.1; not selected in diagnostic run |
| Q2 second submit becomes a separate user turn after the first completes | **not reproduced** | **not reproduced with the same fixture** |
| Q3 shell allow/deny, TUI Enter, duplicate reply, read-only control | pass | not selected |
| Q3 native MCP can_use_tool, exact input and one handler effect after allow, duplicate refused | pass | not selected |
| Q4 external cancel/SIGINT leaves turn running; person Esc stops it and next turn works | pass, existing ceiling retained | pass |
| Q5 unread output FIFO does not block the TUI answer | pass | not selected |
| Q6 resume id, no old-submit replay and prior context present in resumed provider request | pass | pass |

For Q2 the corrected results in both versions report `prematureSecondUser: false` and `userCount: 1`. The one final assistant carries responses to both submitted markers and one completion boundary; the required second distinct user event is absent. This supports a coalescing/steering observation for this held-stream workload, not a new 0.26.4 regression. The earlier receipt's queued-submit observation was not reproduced by this fixture, so this row cannot be called fully verified.

Q3 saw actual shell and `mcp__t0__t0_echo` requests with request id, tool_use_id, exact input and permission_suggestions. Allow and TUI Enter produced the effect and success response; duplicate responses were errors without a second effect. The denied file was absent, the legacy no-event ceiling was observed and a subsequent turn worked. The read-only command ran without approval. MCP execution reached the tiny fixture's handler only after allow and exactly once.

Q4 records an identity-bound native TUI signal, not a promise that the hub may signal a person's terminal. The hub's existing report-only watchdog remains unchanged. Q6 rotated the event file like the production adapter, retained old input bytes without replay and observed the remembered token in the resumed provider request. Model recall quality is unverified because all responses were deterministic fixtures.

## Source review and decision

At 0.26.1 `b475278c4a300acebe6cfc990a9e1b1d18819bfc` and 0.26.4 `715a550cfca0135e00d4015d1ca82a8167e81fff`, `DualOutputBridge.ts` and `RemoteInputWatcher.ts` were byte-identical. The installed UI callback/queue regions also retain direct addMessage and mid-turn steering paths. This is scoped supporting source evidence; the matched native control above determines the attribution limit.

Because Q2 is not established, the conditional task gate does not permit a qwen-dual bump. Only the independently passing ACP and Kimi rows are changed. No TUI adapter, queue, cancellation policy or existing 0.26.1 admission is modified. Resolving this stronger queued-turn workload is separate from declaring a new-version regression.

Real account/provider, inference, model choices/quality, token/quota behavior and non-macOS platforms remain unverified. The evidence includes explicit failed and unselected diagnostic legs; none is relabelled as a pass. Host unit tests/changed gate and exact-head CI are separate PR evidence.

## Evidence fingerprints

Files remain outside git under `scratchpad/temp/agent-hub-578`.

| File | SHA-256 |
| --- | --- |
| `qwen-dual-probe.py` | `6111ed0364a498b15d8abbf5353d00ec9289add7dcbc8a57ac0441a2c815af3c` |
| `qwen-dual-result.json` | `247e7ade2eb001e14b6492cdeb570e6a899b7b83c4873571e5624821d1f0f44b` |
| `qwen-dual-0261-control-result.json` | `fa47606403a642bda78ea71d810b837c807bc5a36f7b1097ec54c9d7f64d099f` |
| `qwen-dual-probe-v2.py` | `114c032afce5caef4f59072f0a1730bc78a70788fd49ad17e5ff2f1eef4c947e` |
| `qwen-dual-v2-0261-control-result.json` | `9b3a9940e43d73c2223d51aec8826053ff24a13b08e1fee4db854d2197053564` |
| `qwen-dual-v2-0264-result.json` | `15f9b3971f0de3eb48cd6f5735927592b6a20a782641fddb5ca070846b628844` |
