# Headless Claude Bash context probe

Date: 2026-10-26. Scope: #845 native context prerequisite. Binary: Claude Code 2.1.310, SHA-256 `ffb64331bc0ee1b69efb7c2c428bd3ab516bc31b75bf60886b356c97c1c25ffd`.

## Method

The installed native binary ran under isolated HOME and CLAUDE_CONFIG_DIR directories, with explicit fixture settings, a strict fixture MCP inventory and a deterministic loopback provider. The provider supplied two Bash tool calls and a completion response. No account, real provider request, model inference or personal authentication file was used. Each case had an external 25-second deadline and an owned process group that was stopped and reaped.

The launch used the permission transport described in [the earlier receipt](2026-10-23-headless-claude-permissions.md), with `--permission-mode default`, `--permission-prompts host` and `--permission-prompt-tool mcp__fixture__approve`. The fixture settings asked for every Bash call. This probe tested native execution, rather than a fake Claude process or the production daemon's grant policy.

The first call was `cd sub && pwd`; the second original input was `pwd`. In the control case both permission replies returned the original input. In the rewritten case the second reply returned a fresh `updatedInput` whose command was a shell-quoted fixed `cd -- <root>` followed by a shell-quoted absolute executable resolved by the host. The executable printed its identity and working directory as JSON. A different executable with the same name was placed on native PATH. Both the root and the selected executable path contained spaces and apostrophes.

## Observations and evidence classes

| Leg | Result |
| --- | --- |
| Native version and binary identity | Observed 2.1.310 and the SHA-256 above before launch |
| Persistent working directory control | Both commands reported the `sub` directory |
| Fresh host-rewritten input | The second command reported the fixed root and the absolute host executable, rather than the PATH fixture |
| Native completion | Both cases exited 0, without the external deadline firing; each made three loopback requests and two MCP permission calls |
| Exact request/reply and execution assertions | Subsequent offline verification passed against native stream-json `tool_use_result.stdout` and the exact MCP input/reply records |
| Corrected producer end-to-end rerun | Deferred by resource admission; not established |
| Native execution environment equal to host read-only proof | Not established |

The original producer reported failure because it compared the provider-facing tool-result text, which native Claude augments with system reminders, to raw command output. That failed receipt is retained. The subsequent verifier reads the native stream's structured `tool_use_result.stdout`; it also requires the corresponding native tool-result content to equal that stdout, empty stderr, no interruption, both expected tool ids, and the exact original requests and fresh rewritten reply. It does not strip arbitrary text or relax the expected directory or executable identity. This offline result is distinct from a successful corrected producer run.

Evidence hashes:

| Artifact | SHA-256 |
| --- | --- |
| Executed producer | `e1db40c7ce86f4f892cad189cc68abec0f31e2e572264801132aad021ed01861` |
| Strict offline verifier | `7b9a852a045c93c066f83011ee7be036f65eb3ee90d442b6768fdc132bfdfdb8` |
| Offline semantic verification result | `cfebce098c73d6718796508615777b69b1d52d23fc4866674a4547197dde26ac` |
| Control native stdout | `0aa567092b4b7052267ac3c403424dca76dc7c9fe894958472c7d71b65912fe7` |
| Control MCP record | `7ff441721f48e3bb23837fd8dbf0d1f1b8c446f5efd07d05afd51cb51ea659a6` |
| Rewritten native stdout | `675265796a6df71ce0bf552609b427f77178126c034cf39e93f8fa7a27672f14` |
| Rewritten MCP record | `cb800617c19fb1bec85e0e5eada6e030f640be4da99ee53eb613573bd2f23d91` |

Raw local artifacts were retained under the diagnostic directory `claude513-native-310-ujolnas6`; the producer and verifier are local diagnostics, not shipped runtime dependencies. Fixture paths are omitted from this document.

## Authorization ceiling

The observed rewrite establishes the tested directory and executable selection on this binary. It does not establish equivalence between native Bash's inherited environment and the fixed environment used by `proveReadOnlyShell`. Variables such as ripgrep configuration and Git repository selectors can affect a selected executable even when its path and working directory are fixed. Clearing the environment also needs a contract for security preloads, ownership markers and authentication; copying arbitrary inherited values into a native command could expose secrets.

No automatic read-only or task-command grants are connected by this probe. The existing person-approval path remains in effect while the execution environment contract is unresolved. This receipt claims neither complete #845 acceptance nor a package gate, CI result, real-account turn or filesystem sandbox guarantee.
