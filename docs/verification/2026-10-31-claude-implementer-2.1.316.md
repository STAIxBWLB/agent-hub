# Claude Code 2.1.316 headless implementer receipt

Date: 2026-10-31. Scope: #888 (claude-implementer row). This repeats the procedures of the [2.1.314 receipt](2026-10-31-claude-implementer-2.1.314.md) on the installed Claude Code 2.1.316, with 2.1.314 run through the same producers as the control: the permission transport (Write, production-name Bash, Bash `updatedInput` rewrite) and the host shell wrapper. Source head: `65d4a4fe`. Platform: macOS arm64, host Bun 1.4.3.

Result: every case passed on both binaries. `2.1.316` is added to `COMPAT["claude-implementer"].verified`. 2.1.315 is published on npm but was not run and is not verified by this receipt.

| Native version | Binary SHA-256 |
| --- | --- |
| Claude Code 2.1.314 (control) | `21d6e7b9a6f07b4cfcb7df13760b3b72aa25e084e13a5354413382987ba832ed` |
| Claude Code 2.1.316 | `64c327e92b2c5e0f78c0a980c5a518121e1f0d140ca771ca5dd4488d1a2dcb3f` |

The 2.1.314 hash matches the 2.1.314 receipt, so the control is the binary it certified.

## Upstream changes since 2.1.314

Read from the upstream [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md); it has no 2.1.315 entry. Items in 2.1.316 that touch permissions, MCP, hooks, settings sources, process lifetime or the Bash tool:

- **Shell commands left running when Claude Code exits by itself**: fixed on macOS and Linux. The producers already require every native child's process group to be empty afterwards; this tightens cleanup and loosens nothing.
- **Bash tool shell: multi-line alias values, dash-named functions and an exported `SHELLOPTS`** no longer garble the shell or stop scripts after their first command. The hub's implementer child gets an isolated HOME without the person's rc files, and the wrapper's persistent-cwd control below still passes on 2.1.316.
- **Managed `autoMode.allow` without `"$defaults"` regaining built-in exceptions from a host app's `--settings`**: fixed. The hub passes `--settings` with permission rules only, runs in `default` permission mode and does not use auto mode.
- **Server-managed settings for Team and Enterprise logins apply without an approval prompt**: these come from an account login, which the model-free runs do not have. As before, managed settings from a real account are outside this receipt.
- **`--restricted` uploads and plugin MCP `headersHelper` environment**: the hub uses neither `--restricted` nor plugin MCP servers in the implementer child (`--strict-mcp-config`).

Nothing in these entries changes `--permission-prompts host`, `--permission-prompt-tool`, `--strict-mcp-config`, `--setting-sources` or the `updatedInput` reply contract. This reading is of the changelog text, not the binary's source, which is not public.

## Runs

Each producer ran both binaries sequentially with an isolated HOME and `CLAUDE_CONFIG_DIR`, a fixture MCP server, a deterministic loopback provider and the literal API key `synthetic-probe-not-a-credential`. No account, provider request or model inference was involved. Every native child's process group was confirmed empty afterwards and every binary hash was unchanged.

```sh
python3 docs/verification/claude-permission-transport-native.py OUT/write --claude 2.1.314 --claude 2.1.316
python3 docs/verification/claude-permission-transport-native.py OUT/bash --tool Bash --server-name agent-hub --permission-tool hub_permission_request --require-tool-use-id --claude ... --claude ...
python3 docs/verification/claude-permission-transport-native.py OUT/rewrite --tool Bash --rewrite-bash --server-name agent-hub --permission-tool hub_permission_request --require-tool-use-id --claude ... --claude ...
python3 docs/verification/claude-shell-wrapper-native.py OUT/wrapper --bun ABSOLUTE_BUN --claude ... --claude ...
```

(binary arguments are the absolute installed paths). `--bun` must be the absolute path of the Bun executable. A first wrapper run here was given an empty path, because `command -v bun` names a shell function in an interactive zsh, and failed the `normalized` case on both binaries with `PermissionError`; the rerun with the Homebrew Bun 1.4.3 path is the result below.

| Producer | Cases per binary | 2.1.314 | 2.1.316 |
| --- | --- | --- | --- |
| Write transport (allow, deny, missing tool, hook deny/allow, MCP error, disconnect, pending, deadline) | 9 | 9 pass | 9 pass |
| Bash transport, production server and tool names, `tool_use_id` required | 9 | 9 pass | 9 pass |
| Bash `updatedInput` command replacement (allow, deny) | 2 | 2 pass | 2 pass |
| Host shell wrapper (persistent-cwd control, fixed-wrapper rewrite with replay refusal) | 2 | 2 pass | 2 pass |

Per-case shapes on 2.1.316 match the control: pending stopped externally at the 25-second deadline; wrapper control 3 requests and 2 permission calls, wrapper rewrite 4 requests and 3 permission calls with the effect counter at exactly 1 after replay.

The only producer change is the version allow-list in `claude-shell-wrapper-native.py`, which now admits `2.1.316`.

| Artifact | SHA-256 |
| --- | --- |
| Permission producer (unchanged) | `8f8885f7153b3a236f3b3f8ce49a344b908f2af3b3aba8b064762d82d1ecf12a` |
| Wrapper producer (this change) | `92dde3d32d290ee4e64447957e2c760726467e3597f5a436b960f7dbe71f9219` |
| Wrapper host fixture | `616e6711e392f0eee7e3fa1c7bdc47a537dfa86bcc8ffb30e549ca94e5a71cef` |
| Fixed CLI wrapper | `8ff56514a6e3f25bce0784775d396df199b58b1b93f55ad0e8747bbc729d2fd8` |
| Write receipt JSON | `1eb6c30ad7c18258f204610e37c61a5b2fff128ba98017c74d59686cd9646c37` |
| Bash receipt JSON | `6a4e5a478e751a6040383eb0d7a520ebe0b89ad693ebe76eab0353dcde4d8eed` |
| Rewrite receipt JSON | `ac5b574115d9afe0f93f9c1f7ed63df155cdc3ec5cc991ebf0c9b6b14a98f73a` |
| Wrapper receipt JSON | `1e8d280ce6dbe66b30184b9abd68b9947057d9d87dfd3fb42e352edc136a6a50` |

The receipt JSON files stay in the local diagnostic directory; they carry local paths and are not committed.

## Evidence boundaries

Unchanged from the earlier receipts: no real provider authentication, model tool selection, person approval interaction, task-session resume or production-daemon task binding is proved, and this is not a runtime receipt gate. Native version admission and binary fencing remain required. The Monitor tool is still an unrewritten prompt-tool path. Exact-head package gate and CI are recorded on the PR.
