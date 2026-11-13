# Claude Code 2.1.322 headless implementer receipt

Date: 2026-11-10. Scope: #888 (claude-implementer row), hub task 868. This repeats the procedures of the [2.1.319 receipt](2026-11-06-claude-implementer-2.1.319.md) on the installed Claude Code 2.1.322, with 2.1.319 run through the same producers as the control: the permission transport (Write, production-name Bash, Bash `updatedInput` rewrite) and the host shell wrapper. Source base: `73920818` (main after 0.35.0). Platform: macOS arm64, host Bun 1.4.4.

Result: every case passed on both binaries. `2.1.322` is added to `COMPAT["claude-implementer"].verified`. 2.1.320 and 2.1.321 are not qualified by this receipt.

| Native version | Binary SHA-256 |
| --- | --- |
| Claude Code 2.1.319 (control) | `1f53587e92dee8e089fa349188a4cda64fa34ace6e7b0ca2ee278ddaa3cc2ebd` |
| Claude Code 2.1.322 | `a9d237949db816a0b7afd88a9a8e1df36b3a597a30f5a41d1c0539eb180a3450` |

The 2.1.319 hash matches the 2.1.319 receipt, so the control is the binary it certified.

## Upstream changes since 2.1.319

The upstream [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) has entries for 2.1.321 and 2.1.322 (none for 2.1.320). The entries that touch what these producers exercise:

- Bash permission checks: a read-only Bash command that ran outside the sandbox without a prompt, and a file write judged from the wrong folder, are fixed. Bash commands sent together no longer run in the wrong folder after an earlier one changed folders. The wrapper's persistent-cwd and prior-`cd` cases cover the folder path and passed.
- PreToolUse hooks: an `ask` reason or an `ask` lost to another hook's `defer` is fixed; an `mcp_tool` hook answer over 16 MiB now refuses the call. The hook allow and deny cases passed; multi-hook ordering is not exercised.
- Mods: a mod's own `$.tool.call` and `$.mcp.call` raise no permission prompt, even in `-p` runs (deny rules and organization policy still apply), and headless sessions reload mods in `.claude/skills` when their files change. A mod-initiated tool call therefore does not reach the hub's permission-prompt tool. The producers load no mod, so this path is not exercised; it joins the Monitor tool as an unrewritten prompt-tool path.

## Runs

Each producer ran both binaries sequentially with an isolated HOME and `CLAUDE_CONFIG_DIR`, a fixture MCP server, a deterministic loopback provider and the literal API key `synthetic-probe-not-a-credential`, from a shell with the hub's agent markers (`AGENTHUB_HOME`, `AGENTHUB_PEER_ID`, `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`) unset. No account, provider request or model inference was involved. Every native child's process group was confirmed empty afterwards, and both binary hashes were the same before and after.

```sh
python3 docs/verification/claude-permission-transport-native.py OUT/write --claude 2.1.319 --claude 2.1.322
python3 docs/verification/claude-permission-transport-native.py OUT/bash --tool Bash --server-name agent-hub --permission-tool hub_permission_request --require-tool-use-id --claude ... --claude ...
python3 docs/verification/claude-permission-transport-native.py OUT/rewrite --tool Bash --rewrite-bash --server-name agent-hub --permission-tool hub_permission_request --require-tool-use-id --claude ... --claude ...
python3 docs/verification/claude-shell-wrapper-native.py OUT/wrapper --bun ABSOLUTE_BUN --claude ... --claude ...
```

(binary arguments are the absolute installed paths under `~/.local/share/claude/versions/`; `--bun` was the Homebrew Bun 1.4.4 path resolved with `readlink -f`).

| Producer | Cases per binary | 2.1.319 | 2.1.322 |
| --- | --- | --- | --- |
| Write transport (allow, deny, missing tool, hook deny/allow, MCP error, disconnect, pending, deadline) | 9 | 9 pass | 9 pass |
| Bash transport, production server and tool names, `tool_use_id` required | 9 | 9 pass | 9 pass |
| Bash `updatedInput` command replacement (allow, deny) | 2 | 2 pass | 2 pass |
| Host shell wrapper (persistent-cwd control, fixed-wrapper rewrite with replay refusal) | 2 | 2 pass | 2 pass |

Per-case shapes on 2.1.322 match the control: pending stopped externally at the deadline; wrapper control 3 requests and 2 permission calls, wrapper rewrite 4 requests and 3 permission calls with the effect counter at exactly 1 after replay.

The only producer change is the version allow-list in `claude-shell-wrapper-native.py`, which now admits `2.1.322`.

| Artifact | SHA-256 |
| --- | --- |
| Permission producer (unchanged) | `c8e82c66a8cf2faf4f4930da21ca81e36166381fd932219cb60e3cec541af10b` |
| Wrapper producer (this change) | `ad891f5b9663e14e3f44febd787500a8ced815125c489adadddcdeb279f64826` |
| Write receipt JSON | `d47f9c082e5681647ddf4fa4939e7224951a7af63dae26de4413a87d3c5ff5bd` |
| Bash receipt JSON | `58acda0fc03489acdfb31bec27e4bf174a79d95afc156157c45724eb2bffcfa7` |
| Rewrite receipt JSON | `817fc15da7d774b14ad9a19d7fe3a4696025898f7fa5bcf6ec4e273776a39836` |
| Wrapper receipt JSON | `fd27bc46ef8d0b1bbc7aba71b9c66aa4a8781c540b21b4234f8fd65afaa371be` |

The receipt JSON files stay in the local diagnostic directory; they carry local paths and are not committed.

## Evidence boundaries

Unchanged from the earlier receipts: no real provider authentication, model tool selection, person approval interaction, task-session resume or production-daemon task binding is proved, and this is not a runtime receipt gate. A behavior change outside these producers' cases would not be seen here. Native version admission and binary fencing remain required. The Monitor tool and, from 2.1.322, mod-initiated tool calls are unrewritten prompt-tool paths.
