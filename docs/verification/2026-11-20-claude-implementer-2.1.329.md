# Claude Code 2.1.329 headless implementer receipt

Date: 2026-11-20 UTC. Scope: #888, hub task 1023. This repeats the [2.1.323 procedure](2026-11-13-claude-implementer-2.1.323.md), using 2.1.323 as control and installed 2.1.329 as candidate. Source base: `8714659d2877a38b7ffecbf21302e5389f167070`. Platform: macOS arm64, Bun 1.4.4.

Result: all 44 cases passed, 22 on each binary. The case results match after excluding version, binary hash and elapsed time. Add exact `2.1.329` to `COMPAT["claude-implementer"].verified`.

## Identity and unchanged producers

The control was obtained from the npm `@anthropic-ai/claude-code-darwin-arm64` 2.1.323 package in a private scratch directory. The package SHA-512 matched npm's integrity value, and the control binary SHA-256 matches the 2.1.323 receipt. Both binaries and all producers had the same hashes before and after the runs.

| File | SHA-256 before and after |
| --- | --- |
| Claude Code 2.1.323 control | `5432918d904a9b6afef7bb79d20df24d76052eabc1f41bceb84091d21f8889a7` |
| Claude Code 2.1.329 candidate | `8c1729568b19cdadedd0a978bf692f9f279ef554c8a333c4e132b94fd8725550` |
| `claude-permission-transport-native.py` | `c8e82c66a8cf2faf4f4930da21ca81e36166381fd932219cb60e3cec541af10b` |
| `claude-shell-wrapper-native.py` | `ad891f5b9663e14e3f44febd787500a8ced815125c489adadddcdeb279f64826` |
| `claude-shell-wrapper-host.ts` | `616e6711e392f0eee7e3fa1c7bdc47a537dfa86bcc8ffb30e549ca94e5a71cef` |

## Serial model-free runs

Each run used resource admission on the Mac with one native job at a time. The producer parent received an empty inherited environment plus an isolated HOME, config directory and fixed PATH. Each native child had its own fresh fake HOME and config directory, strict fixture MCP configuration, deterministic loopback provider and a synthetic key. No real credentials or ambient agent markers were inherited. There was no account authentication or external provider inference.

| Producer leg | Additional arguments | 2.1.323 | 2.1.329 |
| --- | --- | --- | --- |
| Write transport | default Write case table | 9/9 pass | 9/9 pass |
| Production-name Bash transport | `--tool Bash --server-name agent-hub --permission-tool hub_permission_request --require-tool-use-id` | 9/9 pass | 9/9 pass |
| Bash command replacement | Bash arguments above plus `--rewrite-bash` | 2/2 pass | 2/2 pass |
| Host shell wrapper | `--bun` naming Bun 1.4.4 | 2/2 pass | 2/2 pass |

The transport cases cover allow, deny, missing tool, hook deny/allow, MCP error, disconnect, pending and deadline. Both pending cases reached their bounded external stop without writing a file. The rewrite cases did not execute the original command. The wrapper context case observed three requests, two permission calls and persistent cwd. The normalized case observed four requests, three permission calls, environment isolation, quoted paths, replay refusal and exactly one effect. All 44 native process groups were reported empty; all wrapper helpers reported stopped.

## Local artifact hashes

The JSON artifacts remain in the private local diagnostic directory and are not committed.

| Receipt JSON | SHA-256 |
| --- | --- |
| Write, control | `ba94969fdd8eb5b9c4920c65bb9a95f6604407035a86ae8f481f127d750e562b` |
| Write, candidate | `08cf06993fe05ec3cec129aa2884b80221aa5112845df3266995b695a2b050f5` |
| Bash, control | `4f4a0d45083726d729b7882dfc59a83b73dff0878e7f4bbd03bb6f4bf403ba4d` |
| Bash, candidate | `619207a9bf42e6edb9ac8d08f0289d1583004f99b8fb19688c01e99f9c99d961` |
| Rewrite, control | `ae59877765425adc25ef1ab8a532ecab6f893b21e96b99e1cfc9b95fa6e10b52` |
| Rewrite, candidate | `3972ae5a2f5e8c8f448e23c44a495d968f7e2cada50b5c103e7f8bc82679b65b` |
| Wrapper, control | `1d11519cb14758c072f0467d609434752e2eddec4ee2e9522767e5564e0650b9` |
| Wrapper, candidate | `5408eaf84570c5b01eff7d02b3aebebd933edf4e71110be97c41460e776d9ad8` |

## Evidence boundaries

This is isolated native transport and host-wrapper evidence. It does not prove real provider authentication, model-selected tools, person approval interaction, task-session resume, production-daemon task binding or complete native sandbox confinement. Monitor, mod-initiated calls and opt-in Code Mode were not exercised. This is not a runtime receipt gate. Binary fencing and the existing exact-version admission policy remain required; other versions receive no qualification from this receipt.
