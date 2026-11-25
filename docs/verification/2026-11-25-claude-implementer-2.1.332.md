# Claude Code 2.1.332 headless implementer receipt

Date 2026-11-25 UTC. Refs #888, hub task 1118. This repeats the [2.1.329 procedure](2026-11-20-claude-implementer-2.1.329.md) on macOS arm64 with Bun 1.4.4. Source base `ce27e60535955674747f3a77fe1a1b619f20a257`.

Both binaries passed all 44 cases, 22 per binary. The case results were identical after excluding the version, binary hash and elapsed time. This qualifies exact `2.1.332` for `claude-implementer`.

## Binary and producer identity

The 2.1.329 control came from the npm `@anthropic-ai/claude-code-darwin-arm64` package. Its package SHA-512 matched the npm integrity value, and its binary SHA-256 matched the previous receipt. The installed 2.1.332 binary was resolved before the run and checked by exact version. All five files retained these SHA-256 hashes across the runs.

| File | SHA-256 |
| --- | --- |
| `Claude Code 2.1.329 control` | `8c1729568b19cdadedd0a978bf692f9f279ef554c8a333c4e132b94fd8725550` |
| `Claude Code 2.1.332 candidate` | `5b8214f8f082f3187420b27b4063b9b4f4d9412cd66ea436d6d1966ad582700f` |
| `claude-permission-transport-native.py` | `c8e82c66a8cf2faf4f4930da21ca81e36166381fd932219cb60e3cec541af10b` |
| `claude-shell-wrapper-native.py` | `ad891f5b9663e14e3f44febd787500a8ced815125c489adadddcdeb279f64826` |
| `claude-shell-wrapper-host.ts` | `616e6711e392f0eee7e3fa1c7bdc47a537dfa86bcc8ffb30e549ca94e5a71cef` |

## Model-free runs

Resource admission allowed one native job at a time. The producer ran with an empty inherited environment, scratch `HOME`, `AGENTHUB_HOME` and Claude config, and a fixed PATH. The native children had fresh fixture homes and configs, strict MCP settings, and a deterministic loopback provider with a synthetic API key. The scratch hub home stayed empty.

| Leg | 2.1.329 | 2.1.332 |
| --- | --- | --- |
| Write permission transport | 9/9 | 9/9 |
| Bash transport with `mcp__agent-hub__hub_permission_request` and required tool-use ID | 9/9 | 9/9 |
| Bash transport with `--rewrite-bash` | 2/2 | 2/2 |
| Host shell wrapper | 2/2 | 2/2 |

On both binaries, pending Write and Bash approvals reached the bounded stop without writing a file. The rewrite cases did not execute the original command. The wrapper context case recorded three provider requests and two permission calls with persistent cwd. The normalized wrapper case recorded four provider requests and three permission calls, verified environment isolation and quoted paths, refused replay and wrote exactly one effect. All 44 native process groups were empty at cleanup, and the wrapper helpers stopped.

## Receipt artifact hashes

| Local JSON receipt | SHA-256 |
| --- | --- |
| write, 2.1.329 | `0995e3e5ba2a4ea317486b4d7ff751ddd670c17b41472dc460dc1c9fe574db24` |
| write, 2.1.332 | `02e54a4772305446f10add9de55387365f965ad95be9d1ca492cea4ccb249a5f` |
| bash, 2.1.329 | `a3570d0efe04d443139e363313dc0d94e1eb0ff83f44d026e784156260646ae8` |
| bash, 2.1.332 | `d983787b67f28be0dc908b59523969c193330ba4fd24fef31cccaabe2d44bfc7` |
| rewrite, 2.1.329 | `744c5769f8be87f3a0ea33663066a24f9d3f8589f86bc5418d998913323d517a` |
| rewrite, 2.1.332 | `9e0b0c6209b68d20d2fc9cff824f54f5e6c8a4feb5f303ef63c380516452a7e7` |
| wrapper, 2.1.329 | `5408eaf84570c5b01eff7d02b3aebebd933edf4e71110be97c41460e776d9ad8` |
| wrapper, 2.1.332 | `a562d1e52159f6171d1a60bb0fec99670d506df0db1c9d4005ee23e25957be64` |

## Evidence boundaries

The run covers the native transport and host-wrapper contract on macOS arm64. Account authentication, real provider inference, person approval interaction, session resume, production-daemon task binding and native sandbox confinement remain unverified. Monitor, mod-initiated calls and opt-in Code Mode were outside the fixture scope. The existing launch-time binary fence still applies.
