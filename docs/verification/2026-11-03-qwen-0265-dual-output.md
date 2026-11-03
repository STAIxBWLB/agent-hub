# Qwen 0.26.5 dual-output attempt, not qualified

Date: 2026-11-03. Task #684, Refs #888, the separate `qwen-dual` row. The [0.26.5 ACP receipt](2026-11-03-qwen-0265-acp.md) does not qualify the TUI contract. This repeats the corrected [0.26.4 attempt](2026-10-31-qwen-0264-dual-output.md) (the v2 producer, fixed OpenAI-compatible loopback responses, no real model, account or credential) on `@qwen-code/qwen-code@0.26.5`.

**Decision: do not add 0.26.5 to `COMPAT["qwen-dual"].verified`.** Q2 did not pass. Exactly 0.26.1 stays verified for this entry, and `src/adapters/compat.ts` is unchanged for it.

## Artifact and controls

The candidate is the private-prefix package described in the ACP receipt (upstream tag and `gitHead` `db0e4e24a0d89b211b2a15f4af2be22adac71dfc`, Node 24.18.1, macOS arm64). The retained global 0.26.1 install (`cli-entry.js` SHA-256 `113efe4104a9fc66f507d34bfd6abbd896ceb77de47f4b468a0825a327fdc6a5`) served as a read-only matched control, always with a fresh temporary HOME and cwd and the same producer. Each fixture used a PTY, private input and event files, a scratch git project, a synthetic key and a loopback server. The Node network guard's positive control passed; every observed Node process loaded the guard; every owned process group was confirmed gone; the temporary roots were removed. Model inference calls: 0.

Real configuration: the person's `~/.qwen`, `~/.pi/agent` and the global qwen install hashed the same before and after (9550 entries, together with the ACP runs).

## Observed outcomes

| Check | 0.26.5 | Matched 0.26.1 control |
| --- | --- | --- |
| Q7 version and guard positive control | pass, 0.26.5 | pass, 0.26.1 |
| Q2 second submit becomes a separate user turn after the first completes | **fail**: `Q2 fewer than two user events` | **fail**, the same error, same fixture |
| Q3 shell and native MCP `can_use_tool`, allow, TUI Enter, duplicate refused, read-only control | pass | not selected |
| Q4 external SIGINT leaves the turn running; person Esc stops it and the next turn works | pass | not selected |
| Q5 unread output FIFO does not block the TUI answer | pass | not selected |
| Q6 resume id, no old-submit replay, prior context in the resumed request | pass | not selected |

Q2 fails identically on the already-verified 0.26.1 with this producer, so it is a limit of the held-stream workload the corrected fixture uses and not a 0.26.5 regression: the same outcome the 0.26.4 receipt recorded. It also means this fixture cannot reproduce the queued-submit observation the [original 0.26.1 receipt](2026-10-25-qwen-dual-output-t0.md) rests on. The task gate (promote only when every model-free leg passes) does not allow a `qwen-dual` bump while a required leg is unestablished, and no TUI adapter, queue, cancellation policy or existing admission is changed.

## Source note

Upstream `DualOutputBridge.ts` and `RemoteInputWatcher.ts` have the same blob ids at v0.26.1 (`b475278c`), v0.26.4 (`715a550c`) and v0.26.5 (`db0e4e24`): `1e1a4e71fafd0c29c62e4ca60243449bd698d20a` and `8a3eabf4e29804ce5f63d40d4a083d14f489dbb3`. That is scoped supporting evidence about those two files, not native acceptance.

## Not verified

Q2 on any version with this producer, a real account or provider, model choices and quality, token and quota behavior, Linux and Intel macOS. Explicitly failed and unselected legs above are not relabelled as passes.

## Evidence fingerprints

| File | SHA-256 |
| --- | --- |
| `qwen-dual-probe-v2.py` | `114c032afce5caef4f59072f0a1730bc78a70788fd49ad17e5ff2f1eef4c947e` |
| `qwen-dual-v2-0265-result.json` | `1062244e51f5c1aab71f2778d08116c3c00f81929be9aa209fc3467763cc0471` |
| `qwen-dual-v2-0261-control-result.json` | `d4384d0b54f42e789f09f44346201b75285b1afafc78eb3d22ff3271b38ce72a` |
