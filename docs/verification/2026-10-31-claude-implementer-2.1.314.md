# Claude Code 2.1.314 headless implementer receipt

Date: 2026-10-31. Scope: #888 (claude-implementer row). This repeats both model-free procedures that `COMPAT["claude-implementer"]` rests on, on the installed Claude Code 2.1.314 with 2.1.310 run through the same producers as a control: the permission transport of the [2.1.310 receipt](2026-10-26-claude-implementer-2.1.310.md) (including the production-name Bash variants of the [2026-10-28 triage](2026-10-28-claude-implementer-permission-triage.md)) and the host shell wrapper of the [wrapper receipt](2026-10-26-headless-claude-shell-context.md). Source head: `24d685b9` (0.23.0). Platform: macOS arm64, host Bun 1.4.3.

Result: every case passed on both binaries. `2.1.314` is added to `COMPAT["claude-implementer"].verified`. 2.1.311 and 2.1.312 are not verified by this receipt.

| Native version | Binary SHA-256 |
| --- | --- |
| Claude Code 2.1.310 (control) | `ffb64331bc0ee1b69efb7c2c428bd3ab516bc31b75bf60886b356c97c1c25ffd` |
| Claude Code 2.1.314 | `21d6e7b9a6f07b4cfcb7df13760b3b72aa25e084e13a5354413382987ba832ed` |

The 2.1.310 hash matches both earlier receipts, so the control is the binary they certified.

## Upstream changes since 2.1.310

Read from the upstream [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) for 2.1.311, 2.1.312 and 2.1.314 (no 2.1.313 entry). Items that touch permissions, MCP, hooks, settings sources or the Bash tool:

- **2.1.314, `--setting-sources` excluded file still supplied some settings** (auto mode rules, saved permission consents): fixed. The hub launches with `--setting-sources ''`, so this tightens the isolation the hub already assumes; it loosens nothing.
- **2.1.314, hooks matching Bash now run on shell commands started by the Monitor tool**, able to block or ask but not approve or rewrite. The 2.1.310 receipt already records that Monitor reaches the host prompt tool as `tool_name: "Monitor"`; this changes hook coverage, not the prompt-tool path. A Monitor command is still never rewritten by the host wrapper, which binds Bash only (ceiling unchanged).
- **2.1.314, `permissions.blockWritesOutsideWorkingDirectories`**: a new opt-in setting the hub does not set.
- **2.1.314, stream-json acknowledgement of prompts containing `<bash-stdout>`-style tags**: host output framing; the producers parse structured `tool_use_result` frames, not prompt text.
- **2.1.312, prompt and agent hooks capped at 24 concurrent per session**: the hub runs no prompt or agent hooks in the implementer child.
- **2.1.311, Bash tool description no longer claims the working directory always persists**: a description change. The wrapper's persistent-cwd control below still observes persistence on 2.1.314.
- **2.1.311, subagents can use MCP tools from servers that connect late**, and interrupt no longer waits on an unanswered MCP resource read: neither changes the prompt-tool request or reply shape, and the MCP error, disconnect and pending legs are unchanged in outcome.

Nothing in these entries changes `--permission-prompts host`, `--permission-prompt-tool`, `--strict-mcp-config` or the `updatedInput` reply contract. This reading is of the changelog text, not the binary's source, which is not public.

## Runs

Each producer ran both binaries sequentially with an isolated HOME and `CLAUDE_CONFIG_DIR`, a fixture MCP server, a deterministic loopback provider and the literal API key `synthetic-probe-not-a-credential`. No account, provider request or model inference was involved. Every native child's process group was confirmed empty afterwards and every binary hash was unchanged.

```sh
python3 docs/verification/claude-permission-transport-native.py OUT/write --claude 2.1.310 --claude 2.1.314
python3 docs/verification/claude-permission-transport-native.py OUT/bash --tool Bash --server-name agent-hub --permission-tool hub_permission_request --require-tool-use-id --claude ... --claude ...
python3 docs/verification/claude-permission-transport-native.py OUT/rewrite --tool Bash --rewrite-bash --server-name agent-hub --permission-tool hub_permission_request --require-tool-use-id --claude ... --claude ...
python3 docs/verification/claude-shell-wrapper-native.py OUT/wrapper --bun ABSOLUTE_BUN --claude ... --claude ...
```

(binary arguments are the absolute installed paths; `--bun` must be an absolute path, a bare `bun` fails the host fixture with `FileNotFoundError`).

| Producer | Cases per binary | 2.1.310 | 2.1.314 |
| --- | --- | --- | --- |
| Write transport (allow, deny, missing tool, hook deny/allow, MCP error, disconnect, pending, deadline) | 9 | 9 pass | 9 pass |
| Bash transport, production server and tool names, `tool_use_id` required | 9 | 9 pass | 9 pass |
| Bash `updatedInput` command replacement (allow, deny) | 2 | 2 pass | 2 pass |
| Host shell wrapper (persistent-cwd control, fixed-wrapper rewrite with replay refusal) | 2 | 2 pass | 2 pass |

Per-case shapes on 2.1.314 match the control: allow/deny 2 requests and 1 permission call; missing tool 1 request, 0 calls, native exit 1; pending stopped externally at the 25-second deadline; wrapper control 3 requests and 2 permission calls, wrapper rewrite 4 requests and 3 permission calls with the effect counter at exactly 1 after replay.

The only producer change is the version allow-list in `claude-shell-wrapper-native.py`, which now admits `2.1.314` beside `2.1.309` and `2.1.310`.

| Artifact | SHA-256 |
| --- | --- |
| Permission producer | `8f8885f7153b3a236f3b3f8ce49a344b908f2af3b3aba8b064762d82d1ecf12a` |
| Wrapper producer (this change) | `6834da808c8cd6615a841234ef2e1dfff152cfd2e637908c4542d0bdacdfb053` |
| Wrapper host fixture | `616e6711e392f0eee7e3fa1c7bdc47a537dfa86bcc8ffb30e549ca94e5a71cef` |
| Fixed CLI wrapper | `8ff56514a6e3f25bce0784775d396df199b58b1b93f55ad0e8747bbc729d2fd8` |
| Write receipt JSON | `efea5aa3ec86a6673c5ecfbff051f05591603b8a54b8f78a7e4c672c9e3dc332` |
| Bash receipt JSON | `9184559d28482dca4a53267cb4b43af7c189fc9105f50708df34b40c23caa3b2` |
| Rewrite receipt JSON | `c3839e5a3bd612552f6155c960b3bd4cc64df3d937c8fda896f730b6a09f893f` |
| Wrapper receipt JSON | `6ef5a42e971af4a5c8b6db17449782d38dc0c0b94bf9a93276a9a7caf4324c8b` |

The receipt JSON files stay in the local diagnostic directory; they carry local paths and are not committed.

## Evidence boundaries

Unchanged from the earlier receipts: no real provider authentication, model tool selection, person approval interaction, task-session resume or production-daemon task binding is proved, and this is not a runtime receipt gate. Native version admission and binary fencing remain required. The Monitor tool is still an unrewritten prompt-tool path. Exact-head package gate and CI are recorded on the PR.
