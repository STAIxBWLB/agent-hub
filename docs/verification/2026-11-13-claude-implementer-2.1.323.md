# Claude Code 2.1.323 headless implementer receipt

Date: 2026-11-13 UTC. Scope: #888, hub task 921. This repeats the [2.1.322 procedure](2026-11-10-claude-implementer-2.1.322.md), using installed 2.1.322 as control and installed 2.1.323 as candidate. Source base: `7458f87f5db0bc2bdbaefaa32440fcd29dcb27a3`. Platform: macOS arm64, Bun 1.4.4.

Result: all 44 cases passed, 22 on each binary. Add only exact `2.1.323` to `COMPAT["claude-implementer"].verified`. No producer or allow-list change was needed: both producers already accept `--expected-version`, which bound each separate invocation to its exact version.

## Identity and unchanged producers

Every value below was hashed before the first leg and again after the last leg; all hashes were unchanged. The control hash also matches the earlier 2.1.322 receipt.

| File | SHA-256 before and after |
| --- | --- |
| Claude Code 2.1.322 control | `a9d237949db816a0b7afd88a9a8e1df36b3a597a30f5a41d1c0539eb180a3450` |
| Claude Code 2.1.323 candidate | `5432918d904a9b6afef7bb79d20df24d76052eabc1f41bceb84091d21f8889a7` |
| `claude-permission-transport-native.py` | `c8e82c66a8cf2faf4f4930da21ca81e36166381fd932219cb60e3cec541af10b` |
| `claude-shell-wrapper-native.py` | `ad891f5b9663e14e3f44febd787500a8ced815125c489adadddcdeb279f64826` |
| `claude-shell-wrapper-host.ts` | `616e6711e392f0eee7e3fa1c7bdc47a537dfa86bcc8ffb30e549ca94e5a71cef` |

## Relevant upstream changes

The official [2.1.323 changelog](https://github.com/anthropics/claude-code/blob/89eb88e3357be13ae7fcf8966144ad32f44def33/CHANGELOG.md#21323) describes Bash permission-check fixes involving wrappers, wildcard rules, working directories and commands whose execution differed from their checked form. It also changes error handling after hook allow decisions and permission-hook rewrites, adds long-hook progress heartbeats for print/SDK runs, and fixes several headless MCP edge cases. Experimental opt-in Code Mode adds another tool-calling surface.

These entries motivate repeating the existing transport and wrapper cases. They do not establish that those cases exercise every changed path; Code Mode, long-hook heartbeats and the broader sandbox changes were not exercised.

## Serial model-free runs

Each leg ran through resource admission on the Mac, with only one native job at a time. The producer parent received an empty inherited environment plus an isolated HOME, config directory and fixed PATH. Each native child received its own fresh fake HOME and `CLAUDE_CONFIG_DIR`, strict fixture MCP configuration, a deterministic loopback provider and the literal key `synthetic-probe-not-a-credential`. Ambient agent markers and real credentials were absent. Nonessential traffic and native auto-update were disabled. No account authentication, external provider inference, installation or update occurred.

Both versions ran each leg separately with `--claude` naming its absolute installed binary and `--expected-version` naming that exact version:

| Producer leg | Additional arguments | 2.1.322 | 2.1.323 |
| --- | --- | --- | --- |
| Write transport | default Write case table | 9/9 pass | 9/9 pass |
| Production-name Bash transport | `--tool Bash --server-name agent-hub --permission-tool hub_permission_request --require-tool-use-id` | 9/9 pass | 9/9 pass |
| Bash command replacement | Bash arguments above plus `--rewrite-bash` | 2/2 pass | 2/2 pass |
| Host shell wrapper | `--bun` naming the resolved Bun 1.4.4 binary | 2/2 pass | 2/2 pass |

The nine transport cases cover allow, deny, missing tool, hook deny/allow, MCP error, disconnect, pending and deadline. Both pending cases reached their bounded external stop without writing a file. The rewrite cases never executed the original command. Wrapper control observed three requests/two permission calls and persistent cwd; normalized execution observed four requests/three permission calls, correct host cwd/environment and quoted paths, replay refusal, and exactly one effect.

Every one of the 44 native process groups was confirmed empty by the producer. Both wrapper helpers stopped successfully; independent readback also confirmed both observed host execution temporary directories had been removed. The producers signal only their owned unreaped process groups. No unrelated process was stopped.

## Local artifact hashes

The JSON artifacts and before/after identity records remain in the owned local diagnostic directory. Their local paths and native output are not committed.

| Receipt JSON | SHA-256 |
| --- | --- |
| Write, control | `be977fddc44506069098aa38cf7779bd85c784b48e382d454ceb0ab3ea3cb5b8` |
| Write, candidate | `4eb1c96f30d6dca9f211e18f55320061d9beb9e9cbabd7bb0ce835e25c0c3335` |
| Bash, control | `f114c3df3d63e56407336e58adebac00e3482fd5bf54ac3d40e38facbbe0554d` |
| Bash, candidate | `90c129baaaa49bac6890ddcfaa62ed4da9cc0057eadcd71439570f57d6a225bf` |
| Rewrite, control | `7f0a4d84d27ad4364305cb3f43640607cde3a2895bec71eb27d88b0ba41ca5e4` |
| Rewrite, candidate | `b30656074cf0f9bd4c3642528d9c47a2bcbc2d0c927b5720d8ec53d001a3b7e7` |
| Wrapper, control | `0a8db5c053774c4b19229db9cc5ec5de9a0bbdce60d6976190dd07f8d79d15ed` |
| Wrapper, candidate | `1d11519cb14758c072f0467d609434752e2eddec4ee2e9522767e5564e0650b9` |

## Evidence boundaries

This is isolated native transport and host-wrapper evidence. It does not prove real provider authentication, model-selected tools, person approval interaction, task-session resume, production-daemon task binding or complete native sandbox confinement. Monitor, mod-initiated calls and opt-in Code Mode were not exercised. This is not a runtime receipt gate. Binary fencing and the existing exact-version admission policy remain required; versions outside the verified list receive no qualification from this receipt.
