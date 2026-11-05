# Claude Code 2.1.318 headless implementer receipt

Date: 2026-11-05. Scope: #888 (claude-implementer row). This repeats the procedures of the [2.1.316 receipt](2026-10-31-claude-implementer-2.1.316.md) on the installed Claude Code 2.1.318, with 2.1.316 run through the same producers as the control: the permission transport (Write, production-name Bash, Bash `updatedInput` rewrite) and the host shell wrapper. Source head: `801c6453`. Platform: macOS arm64, host Bun 1.4.3.

Result: every case passed on both binaries. `2.1.318` is added to `COMPAT["claude-implementer"].verified`. 2.1.317 is installed but was not run and is not verified by this receipt.

| Native version | Binary SHA-256 |
| --- | --- |
| Claude Code 2.1.316 (control) | `64c327e92b2c5e0f78c0a980c5a518121e1f0d140ca771ca5dd4488d1a2dcb3f` |
| Claude Code 2.1.318 | `677a2ea7bf576cedd20e191d973914ed8a41796f53a63b1923381ddc4d5b5e7d` |

The 2.1.316 hash matches the 2.1.316 receipt, so the control is the binary it certified.

## Upstream changes since 2.1.316

Read from the upstream [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) entries for 2.1.317 and 2.1.318. Items that touch permissions, MCP, hooks, settings sources, process lifetime or the Bash tool:

- **2.1.317, a check that asks before a web or shell tool call sends the account email address to the network**: a new ask. It fires only when a command carries the signed-in account's email; the model-free runs have no account, so this receipt does not exercise it. A real-account run that triggers it goes through the same permission prompt tool as any other ask.
- **2.1.317, child processes of a stopped shell command sent SIGTERM twice**: fixed. The producers still require every native child's process group to be empty afterwards; this tightens cleanup and loosens nothing.
- **2.1.317, edits to settings files in the first second after launch not taking effect** and **old transcripts not cleaned up for runs using `--setting-sources`**: fixed. The hub passes `--settings` with permission rules only before launch and an isolated `CLAUDE_CONFIG_DIR`, so neither changes the child's settings or permission inputs.
- **2.1.317, `claude -p` exiting 0 when a full disk lost its transcript or `~/.claude.json` writes**: it now exits 1. That makes a storage failure visible as a failed turn, not a silent success.
- **2.1.317, `claude -p` inside a cloud or self-hosted runner session sharing that session's ID** (`CLAUDE_CODE_DISABLE_NESTED_SESSION_ID`): the hub's implementer child is not started inside a runner session and gets the hub-built environment.
- **2.1.318, stdio MCP servers that exit on the version probe re-probed on every start; a server that dies in under 3s is pinned to the legacy handshake for 7 days**: the implementer child's MCP server (`--strict-mcp-config`, the hub permission server) does not exit on the probe; the transport runs below still negotiate and answer on 2.1.318.
- **2.1.318, a message sent right after a model change still running after Stop in headless sessions**: Stop now cancels it. The hub does not change models mid-turn in the implementer child.
- **2.1.318, MCP tool errors**: a call made before the tool is loaded now returns its input schema. This changes error text only; the permission tool is loaded before the first tool call in every run below.
- **2.1.318, unattended runs no longer rewrite `~/.claude.json` when nothing changed**, and a non-valid `~/.claude.json` now fails the start: the child runs with an isolated HOME and a fresh config.
- **2.1.318, git commits and PR creation when the Bash tool runs macOS's `/bin/bash`**: reliability only; the wrapper's persistent-cwd control below still passes.

Nothing in these entries changes `--permission-prompts host`, `--permission-prompt-tool`, `--strict-mcp-config`, `--setting-sources` or the `updatedInput` reply contract. This reading is of the changelog text, not the binary's source, which is not public.

## Runs

Each producer ran both binaries sequentially with an isolated HOME and `CLAUDE_CONFIG_DIR`, a fixture MCP server, a deterministic loopback provider and the literal API key `synthetic-probe-not-a-credential`. No account, provider request or model inference was involved. Every native child's process group was confirmed empty afterwards and every binary hash was unchanged.

```sh
python3 docs/verification/claude-permission-transport-native.py OUT/write --claude 2.1.316 --claude 2.1.318
python3 docs/verification/claude-permission-transport-native.py OUT/bash --tool Bash --server-name agent-hub --permission-tool hub_permission_request --require-tool-use-id --claude ... --claude ...
python3 docs/verification/claude-permission-transport-native.py OUT/rewrite --tool Bash --rewrite-bash --server-name agent-hub --permission-tool hub_permission_request --require-tool-use-id --claude ... --claude ...
python3 docs/verification/claude-shell-wrapper-native.py OUT/wrapper --bun ABSOLUTE_BUN --claude ... --claude ...
```

(binary arguments are the absolute installed paths; `--bun` was the Homebrew Bun 1.4.3 path resolved with `readlink -f`, since `command -v bun` names a shell function in an interactive zsh).

| Producer | Cases per binary | 2.1.316 | 2.1.318 |
| --- | --- | --- | --- |
| Write transport (allow, deny, missing tool, hook deny/allow, MCP error, disconnect, pending, deadline) | 9 | 9 pass | 9 pass |
| Bash transport, production server and tool names, `tool_use_id` required | 9 | 9 pass | 9 pass |
| Bash `updatedInput` command replacement (allow, deny) | 2 | 2 pass | 2 pass |
| Host shell wrapper (persistent-cwd control, fixed-wrapper rewrite with replay refusal) | 2 | 2 pass | 2 pass |

Per-case shapes on 2.1.318 match the control: pending stopped externally at the deadline; wrapper control 3 requests and 2 permission calls, wrapper rewrite 4 requests and 3 permission calls with the effect counter at exactly 1 after replay.

The only producer change is the version allow-list in `claude-shell-wrapper-native.py`, which now admits `2.1.318`.

| Artifact | SHA-256 |
| --- | --- |
| Permission producer (unchanged) | `8f8885f7153b3a236f3b3f8ce49a344b908f2af3b3aba8b064762d82d1ecf12a` |
| Wrapper producer (this change) | `af61fcd08df7da42708226d73949646581d4b9d66d5c243de2c9d2c80afccb23` |
| Wrapper host fixture (unchanged) | `616e6711e392f0eee7e3fa1c7bdc47a537dfa86bcc8ffb30e549ca94e5a71cef` |
| Fixed CLI wrapper (unchanged) | `8ff56514a6e3f25bce0784775d396df199b58b1b93f55ad0e8747bbc729d2fd8` |
| Write receipt JSON | `c0977198860c5a5141f7d49e8a52616aa4556b406975de8adb25f3ef1d0dbc52` |
| Bash receipt JSON | `14a44372f3b44b32956aecd37e50836fb39f9a2847ad7b33e6185fb9784fac55` |
| Rewrite receipt JSON | `ee3d66252006581a0481fe326313b674b1437d27b9adc8e617690c0efc45d3af` |
| Wrapper receipt JSON | `2996280113526fd41a005a510656f47c0f20d4dba46d11611191238ed9576a4f` |

The receipt JSON files stay in the local diagnostic directory; they carry local paths and are not committed.

## Evidence boundaries

Unchanged from the earlier receipts: no real provider authentication, model tool selection, person approval interaction, task-session resume or production-daemon task binding is proved, and this is not a runtime receipt gate. The 2.1.317 account-email ask is not exercised (no account). Native version admission and binary fencing remain required. The Monitor tool is still an unrewritten prompt-tool path. Exact-head package gate and CI are recorded on the PR.
