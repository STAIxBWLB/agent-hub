# Headless Claude host shell wrapper receipt

Date: 2026-10-26. Scope: #845 AC6-AC8. A fresh model-free native run passed on both binaries below.

| Native version | Binary SHA-256 |
| --- | --- |
| Claude Code 2.1.309 | `5eadc0009cdcdbc0d06e58110d7b2baf88ced6088b1c33a60a21217fe410619c` |
| Claude Code 2.1.310 | `ffb64331bc0ee1b69efb7c2c428bd3ab516bc31b75bf60886b356c97c1c25ffd` |

## Method

The installed native binaries ran sequentially with isolated HOME and CLAUDE_CONFIG_DIR directories, empty settings sources, explicit fixture settings asking for Bash, a strict fixture MCP inventory and a deterministic loopback provider. The provider supplied Bash calls and a final completion response. No personal authentication files, real provider request, account or model inference was used. Each native case had an external 25-second deadline. Native leaders were reaped, remaining live group members were checked, and the host fixture shut down the production wrapper through its owned cleanup path. Binary hashes were unchanged after every case.

The producers are [claude-shell-wrapper-native.py](claude-shell-wrapper-native.py) and [claude-shell-wrapper-host.ts](claude-shell-wrapper-host.ts). The host fixture imports the actual `HostShellWrapper` and fixed CLI entry from production source. It supplies synthetic task, generation and branch bindings and a current-root predicate; it does not simulate a real task-board assignment or certify the daemon's authorization policy. Real daemon fixtures separately cover task/child/root/branch, mode, privacy and action-policy admission.

For each version, the control ran `cd sub && pwd` followed by `pwd`, returning the original input in both permission replies. Both outputs named `sub`, demonstrating persistent native shell cwd. The wrapper case first performed the same `cd`, then requested `pwd` twice. Both later permission replies returned fresh `updatedInput` objects containing the same issued fixed-wrapper command and single-use ticket. The selected host executable, outside the worktree, printed its identity, cwd and environment fields and incremented an effect counter. Root and executable paths included spaces and apostrophes.

Native HOME, PATH and cwd differed from the host execution context. Native `GIT_DIR` and `RIPGREP_CONFIG_PATH` were injected with poison paths. The actual target received the host's fixed PATH/HOME/LANG/TERM and peer identity, with its owned command TMPDIR. Helper startup uses fixed private HOME/cwd, config and dotenv suppression. The host supervisor receives exact target argv/env over private fd4 rather than shell interpolation or argv serialization, and preserves the target environment without adding shell variables.

## Native observations

| Leg | 2.1.309 | 2.1.310 |
| --- | --- | --- |
| Persistent-shell control reports `sub` twice | pass | pass |
| Fresh rewritten input executes the fixed root after the earlier `cd` | pass | pass |
| Target identity equals the absolute host-selected executable | pass | pass |
| Injected native GIT_DIR and RIPGREP_CONFIG_PATH are absent | pass | pass |
| Target HOME/PATH/TERM and peer identity equal the host fixture values | pass | pass |
| Owned TMPDIR replaces native state | pass | pass |
| Same ticket's second execution returns the fixed refusal and native tool error | pass | pass |
| Effect counter remains exactly 1 after replay | pass | pass |
| Spaces and apostrophes in root/executable paths | pass | pass |
| Native exit 0, host stopped, no remaining live native group members | pass | pass |
| Binary unchanged across the case | pass | pass |

All four cases passed. Each control made three loopback requests and two MCP permission calls; each wrapper case made four requests and three permission calls. The verifier requires exact original native permission arguments and exact rewritten replies. Successful output comes from native stream-json `tool_use_result.stdout`, with the corresponding tool-result block equal to that stdout, empty stderr and no interruption. Replay must be a native error containing the fixed refusal, and the counter must still be 1. Provider-facing text with native system reminders is not treated as raw command output.

## Reproduction and retained evidence

Run from the repository with explicit installed binary paths and a new private output directory:

```sh
python3 docs/verification/claude-shell-wrapper-native.py NEW_OUTPUT --bun ABSOLUTE_BUN --claude INSTALLED_2.1.309 --claude INSTALLED_2.1.310
```

The successful local diagnostic directory is `claude513-wrapper-native-20261026-r1`. It retains native stdout/stderr, exact MCP request/reply records, loopback request bodies, the host fixture diagnostics and `receipt.json`. No actual account credentials are in those fixtures. The framework used host Bun 1.4.3; separate Linux fixtures exercised the same wrapper on pinned Bun 1.4.2. Package and CI evidence remain separate.

| Artifact | SHA-256 |
| --- | --- |
| Native producer | `ecf818acd4b4d42db87416a83dc3f5d2dfbfff3a07c70915fabd25abd8ed2649` |
| Host fixture | `616e6711e392f0eee7e3fa1c7bdc47a537dfa86bcc8ffb30e549ca94e5a71cef` |
| Production wrapper service | `a573956e9c408546aa618afe6b776932fb0d5dd462c089e02993e2629adaf675` |
| Fixed CLI wrapper | `8ff56514a6e3f25bce0784775d396df199b58b1b93f55ad0e8747bbc729d2fd8` |
| Four-case receipt JSON | `3db74019a71be0b556d88e21b8273da93e1fdbeace200190e1a5c801a23b6ea8` |

The earlier direct-rewrite diagnostic and its initial provider-text parsing failure are preserved in this document's Git history and retained raw artifacts. This receipt uses a fresh run of the strict structured-output verifier, not a restamp of that earlier failed producer result.

## Host fixtures and ceilings

Mac fixtures separately passed the existing #816 Seatbelt recursive-deny boundary, profile/read-only-data mutation refusal and actual environment parity against `sandboxedExec`. The sandbox source remains byte-identical to its accepted baseline. Automatic read-only and executable task commands require the local-worker Seatbelt profile; unsupported hosts ask. Only closed push/gh remain outside it. Additional daemon fixtures cover a model-written test that cannot read the live control token or SSH key even when the canonical checkout is readable. These authorization fixtures are separate from this generic native wrapper fixture. Portable fixtures cover binary fd output, numeric status, expiry/replay/quotas, helper config/env isolation, current proof/root/argv/env mutation, cancellation, deadline, disconnection and descendant pipe cleanup. Task and daemon fixtures cover persistent branch binding, action-policy asks, unchanged ask behavior and old-client protocol refusal.

The [earlier permission transport receipt](2026-10-23-headless-claude-permissions.md) remains evidence for its original allow/deny/error/hook cases. A native version upgrade repeats both this wrapper procedure and the original permission-transport procedure before extending the verified set. This wrapper receipt adds no version to COMPAT and does not prove real provider authentication, model tool selection, task-session resume, a person's approval interaction or isolation of the entire native Claude process. The executable task-code profile is host policy verified separately by Darwin fixtures. It is not a runtime receipt gate. Native version admission and binary fencing remain required. Exact-head package gate and CI results are recorded separately in the PR handoff.
