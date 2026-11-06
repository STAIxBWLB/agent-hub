# Claude Code 2.1.319 headless implementer receipt

Date: 2026-11-06. Scope: #888 (claude-implementer row), hub task #750. This repeats the procedures of the [2.1.318 receipt](2026-11-05-claude-implementer-2.1.318.md) on the installed Claude Code 2.1.319, with 2.1.318 run through the same producers as the control: the permission transport (Write, production-name Bash, Bash `updatedInput` rewrite) and the host shell wrapper. Source base: `f7cbefda` (0.32.0). Platform: macOS arm64, host Bun 1.4.3.

Result: every case passed on both binaries. `2.1.319` is added to `COMPAT["claude-implementer"].verified`.

| Native version | Binary SHA-256 |
| --- | --- |
| Claude Code 2.1.318 (control) | `677a2ea7bf576cedd20e191d973914ed8a41796f53a63b1923381ddc4d5b5e7d` |
| Claude Code 2.1.319 | `1f53587e92dee8e089fa349188a4cda64fa34ace6e7b0ca2ee278ddaa3cc2ebd` |

The 2.1.318 hash matches the 2.1.318 receipt, so the control is the binary it certified.

## Upstream changes since 2.1.318

None to read: the upstream [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) had no 2.1.319 entry when this was checked (its newest heading was 2.1.318), and npm `@anthropic-ai/claude-code` latest was still 2.1.318. 2.1.319 reached this machine through the native installer. This receipt therefore rests on observed behavior only, with no changelog reading.

## Runs

Each producer ran both binaries sequentially with an isolated HOME and `CLAUDE_CONFIG_DIR`, a fixture MCP server, a deterministic loopback provider and the literal API key `synthetic-probe-not-a-credential`, from a shell with the hub's agent markers (`AGENTHUB_HOME`, `AGENTHUB_PEER_ID`, `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`) unset. No account, provider request or model inference was involved. Every native child's process group was confirmed empty afterwards, and both binary hashes were the same before and after.

```sh
python3 docs/verification/claude-permission-transport-native.py OUT/write --claude 2.1.318 --claude 2.1.319
python3 docs/verification/claude-permission-transport-native.py OUT/bash --tool Bash --server-name agent-hub --permission-tool hub_permission_request --require-tool-use-id --claude ... --claude ...
python3 docs/verification/claude-permission-transport-native.py OUT/rewrite --tool Bash --rewrite-bash --server-name agent-hub --permission-tool hub_permission_request --require-tool-use-id --claude ... --claude ...
python3 docs/verification/claude-shell-wrapper-native.py OUT/wrapper --bun ABSOLUTE_BUN --claude ... --claude ...
```

(binary arguments are the absolute installed paths under `~/.local/share/claude/versions/`; `--bun` was the Homebrew Bun 1.4.3 path resolved with `readlink -f`).

| Producer | Cases per binary | 2.1.318 | 2.1.319 |
| --- | --- | --- | --- |
| Write transport (allow, deny, missing tool, hook deny/allow, MCP error, disconnect, pending, deadline) | 9 | 9 pass | 9 pass |
| Bash transport, production server and tool names, `tool_use_id` required | 9 | 9 pass | 9 pass |
| Bash `updatedInput` command replacement (allow, deny) | 2 | 2 pass | 2 pass |
| Host shell wrapper (persistent-cwd control, fixed-wrapper rewrite with replay refusal) | 2 | 2 pass | 2 pass |

Per-case shapes on 2.1.319 match the control: pending stopped externally at the deadline; wrapper control 3 requests and 2 permission calls, wrapper rewrite 4 requests and 3 permission calls with the effect counter at exactly 1 after replay.

The only producer change is the version allow-list in `claude-shell-wrapper-native.py`, which now admits `2.1.319`.

| Artifact | SHA-256 |
| --- | --- |
| Permission producer (unchanged) | `8f8885f7153b3a236f3b3f8ce49a344b908f2af3b3aba8b064762d82d1ecf12a` |
| Wrapper producer (this change) | `ce4b9fdd06e393656155a3bd767e899a445abaec4313d832f1a4a519a42c155d` |
| Wrapper host fixture (unchanged) | `616e6711e392f0eee7e3fa1c7bdc47a537dfa86bcc8ffb30e549ca94e5a71cef` |
| Fixed CLI wrapper (unchanged) | `8ff56514a6e3f25bce0784775d396df199b58b1b93f55ad0e8747bbc729d2fd8` |
| Write receipt JSON | `ed55c32bb86de8326251c63250b3bb90138e299558822f57fba19cb97231ddfb` |
| Bash receipt JSON | `a07501001835a7bcfb90bd4f6f546eb1e358bcad4be79b0e5b7f7d9b7c3d9e2d` |
| Rewrite receipt JSON | `1e3364f4925e098d34d9b7245a1b93bdd7815cb6d3e23138de2c25c7cede6238` |
| Wrapper receipt JSON | `f1708b427ae166cfc95e33e6c1c2ffc7d57acfae04cc6e2f394c9249292cab16` |

The receipt JSON files stay in the local diagnostic directory; they carry local paths and are not committed.

## Evidence boundaries

Unchanged from the earlier receipts: no real provider authentication, model tool selection, person approval interaction, task-session resume or production-daemon task binding is proved, and this is not a runtime receipt gate. With no public changelog for 2.1.319, a behavior change outside these producers' cases would not be seen here. Native version admission and binary fencing remain required. The Monitor tool is still an unrewritten prompt-tool path. Exact-head package gate and CI are recorded on the PR.
