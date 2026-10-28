# Claude implementer permission triage

Date: 2026-10-28. Scope: agent-hub task 544, source inspection, isolated fake fixtures and a model-free native transport comparison. Reported target: Claude Code 2.1.312, explicitly trusted but not receipt-verified, using `ask-when-needed`.

The reported symptoms are a permission-tool harness error before `bun test test/ci-watch.test.ts` executes, and approval-waiting notices when the person's console appears empty, followed by expiry. This report does not treat those observations as a reproduced native defect. No production source, permission ceiling, COMPAT entry, installed native binary or account configuration changes in this triage.

## Evidence status

| Evidence | Status and limit |
| --- | --- |
| Version admission, wrapper and approval source paths | Read at the triage base `f7450129` |
| Opt-in deterministic fake diagnostic cases | Corrected committed-head run at `9263ff67db8273a7f0b71c83d63a843ae5a628e0`: 15 pass, 0 fail, 116 assertions across the diagnostic and two related suites. Initial fixture-only assertion failures are corrected |
| Installed native generic permission transport | 2.1.311 and 2.1.312 each 9/9 pass using the existing Python fixture MCP and loopback provider; no production-daemon or host-wrapper rewrite claim |
| Native production-daemon task/host-wrapper rewrite at 2.1.312 | Unverified |
| Person's reported incident and console connection identity | Not independently reproduced |
| Real provider, model, credentials or account interaction | Not run |
| Exact-head gate and hosted CI | Recorded separately by the implementer after verification |

## Source-backed conclusions

There is no verified-only host-wrapper gate. `assessVersion` in `src/adapters/compat.ts` admits the person's exact machine trust as `ok: true, state: "trusted"`. `proveClaudeImplementer` in `src/adapters/claude-implementer.ts` checks that admission and the binary fingerprint; it does not require the verdict's state to be `verified`. The adapter's native argv retains `default`, the strict MCP inventory and the permission prompt tool for both admitted states.

`automaticImplementerShell` in `src/hub/daemon.ts` has no independent native-version predicate. Its gates are current child/generation, isolated execution root, an owned public task, `ask-when-needed`, closed command/input shape, current branch/default-branch evidence, public metadata, action-policy checks and the required host confinement. `taskShellCommand` recognizes `bun test test/ci-watch.test.ts` lexically. Recognition alone grants nothing. Executable test/build/check requests require `sandboxAvailable()`; an unsupported host follows the ordinary person approval path. This is expected behavior, not evidence that the trusted version was silently disabled.

A failure can occur before any console approval exists. The production MCP handler in `src/adapters/claude-channel.ts` requires `tool_name`, an object `input` and a nonempty `tool_use_id`; invalid arguments return a fixed denial before requesting the daemon. The daemon also refuses an unavailable or stale owned-child/root binding before entering `requestPermission`. The 2.1.309/2.1.310 receipts prove their observed native schema and rewrite behavior, not 2.1.312's behavior. The generic native transport probe below observes the expected request schema, but a production-daemon or host-wrapper incompatibility in the reported incident remains unverified.

Approval transport uses one shared daemon map. `requestPermission` registers the row before `writeStatus` and the `permission` push, and a fresh console's `tail` request replays all still-pending pushes. The console-role `status` RPC exposes body-free approval ids/times through `status.attentionItems`; the console-role `ui_snapshot` RPC exposes the full pending rows as `permissions`, projected from the same map. The internal attention input has an `approvals` array, but that is not a field of the ordinary status RPC. Expiry removes the row before emitting closure and resolving the native request as a denial.

The console keeps actionable approval rows from `permission` and `permission_closed` pushes. Status attention metadata does not contain the full title/options needed to reconstruct those rows. A deliberately omitted push therefore leaves the controlled fixture's approval panel empty until a valid push is supplied. This is a push-omission characteristic, not a reproduced product defect or the established cause of the reported incident. Source ordering shows `runConsole` installs `client.onPush` before sending `tail`, and the daemon replays still-pending rows on that subscription; no normal console-startup race was found. An expired/cancelled request, another project/instance connection, pre-queue native failure or an actual missing push must be distinguished using the same request id and daemon instance.

`OwnedPrintChild` ignores native stderr, and `ClaudeImplementerPeer` reduces an unsuccessful native result to the fixed `Claude implementer turn failed` outcome. Consequently the generic delivery failure alone does not establish which native permission-harness stage failed. Do not infer a host wrapper refusal, a missing person answer or a native compatibility defect from that generic outcome.

## Isolated fake fixture

The opt-in diagnostic producer uses a fresh HOME, CLAUDE_CONFIG_DIR, AGENTHUB_HOME and AMEM_HOME; a disposable Git repository and separate non-default-branch worktree; an outside-project Git shim with system/global config disabled; a fake native executable answering only its synthetic version and recording argv/launch metadata; and actual daemon, control-client, MCP channel and console code. Memory, inference, MLX and automatic Pi startup are disabled. A fixed host default-branch test port prevents a GitHub query. No installed Claude binary, personal authentication file or provider is selected, and an issued wrapper ticket is never redeemed.

The fake reports 2.1.312 while that version is unverified. If a later dated receipt verifies it, the fixture uses a synthetic unverified version to retain its admission-policy test without blocking legitimate COMPAT updates. This is not a native compatibility assertion.

| Case | Required observation |
| --- | --- |
| Trusted, unverified fake version | Startup admitted with native `default` and the fixed prompt-tool argv; no bypass mode |
| Closed test command | On a sandbox-capable host, host protocol 1 rewrites the command; without the host sandbox, ordinary approval expires as deny, with no rewrite |
| Real daemon manual approval | Same request id appears in the live console push, `ui_snapshot.permissions`, status attention metadata and a fresh console's tail replay, then is withdrawn on its fixture deadline |
| Missing `tool_use_id` | Actual production source MCP handler returns `invalid native permission request`, with no approval row or permission push |
| Deliberately withheld console push | Real-shaped fake `status.attentionItems` alone supplies no actionable approval row; a later valid push makes the request visible |

The console case deliberately omits a permission push. It lives outside the automatic regression suite and is not evidence of a normal transport or startup failure. It adds no production repair or broader authorization. The host command case tests policy using a fake native. Neither certifies the installed 2.1.312 permission dispatcher, real model tool selection or a person's live approval interaction.

## Installed native transport comparison

The original Write mode of `claude-permission-transport-native.py` ran sequentially on the
installed 2.1.311 control and 2.1.312 target with fresh private homes and a synthetic
loopback provider. Each passed all 9 allow/deny/hook/MCP-error/disconnect/pending/
deadline cases. All 18 owned native groups were established empty and all binary
hashes were unchanged. No account or inference call occurred. The sanitized
[transport receipt](2026-10-28-claude-2.1.311-2.1.312-permission-transport.json)
contains counts, fixed outcomes and binary hashes only.

| Version | SHA-256 | Cases |
| --- | --- | --- |
| 2.1.311 | `85d8c08707fcfd1e78ffa0204eefbc6ec9e4fe22f375fb2767ef85d957ed3161` | 9/9 |
| 2.1.312 | `6b5ec691195e551b02c41df9f7d723f4ea61eaa03c2df90acefe3736f1aeb620` | 9/9 |

Host admission observed memory-pressure level 1, zero swap, thermal state 0 and
76.4% CPU idle on 18 logical CPUs; no other local build/test job was running.
Each native case retained the producer's 25-second bound and owned-group cleanup.
This reproduced normal permission behavior, not the reported harness error. The
fixture MCP is deliberately separate from the production SDK channel and daemon
policy. No COMPAT value is changed and no new host-wrapper receipt is claimed.

## Prepared Bash transport and rewrite follow-up

The producer now accepts optional `--tool Write|Bash`, `--rewrite-bash`, `--server-name`, `--permission-tool` and `--require-tool-use-id` flags. The default remains the original nine-case Write table, original request/response checks, permission mode, isolated environment, 25-second external deadline, owned-group cleanup and binary fence. The optional modes have been prepared for review; no result is claimed for them here.

| Mode | Cases per supplied binary | Prepared behavior |
| --- | --- | --- |
| Default or `--tool Write` | 9 | Original Write allow/deny/hook/MCP-error/disconnect/pending/deadline behavior |
| `--tool Bash` | 9 | Same case table using an explicitly asked Bash command that only prints `probe` into the fixture target |
| `--tool Bash --rewrite-bash` | 2 | Allow and deny only; original native command is exactly `bun test test/ci-watch.test.ts` |

The server/tool names default to `fixture`/`approve` and accept only bounded ASCII letters, digits, underscores and hyphens with an initial letter. `--server-name agent-hub --permission-tool hub_permission_request` selects the exact production namespace `mcp__agent-hub__hub_permission_request`. The strict-schema flag adds required `tool_use_id`, the production name/id length bounds and `additionalProperties: false`; the default keeps the original two-field requirement. Bash settings ask for Bash with no newly granted `permission.allow` entry, matching the earlier wrapper fixture. These flags prepare a production-name/schema comparison without claiming the fixture is the production MCP implementation.

In rewrite mode a private executable named `bun` is prepended to the native fixture PATH. A dummy `test/ci-watch.test.ts` exists under the disposable work directory for command-shape fidelity. If the original command runs, the shim records an execution marker and fails. Only the allow MCP server receives the replacement command, a harmless `printf` writer to the fixture target. The returned `updatedInput` is retained and checked exactly, the original `tool_name`, input and `tool_use_id` remain required, the original-execution marker must stay absent in both cases, and the target may contain `probe` only for allow. The final cleanup rechecks the original-execution marker. No repository test command or real Bun test is intended to run, and this probe imports neither `HostShellWrapper` nor the current daemon.

This isolates native Bash argument replacement from the host's command-admission and sandbox policy. A successful optional run would establish only that specific fixture exchange on its supplied binary, not production SDK/daemon behavior, a new trusted/verified version, real account behavior or a complete host-wrapper receipt.

## Commands for the implementer

Explicit fake diagnostic command, after committing the intended files and taking the permitted remote slot. The first remote run accepted this explicit regular `.ts` path; the corrected diagnostic passed the committed-head rerun above:

```sh
env -u AGENTHUB_HOME bun test ./docs/verification/claude-implementer-permission-triage.ts
```

Prepared native Bash follow-up commands, after host-resource admission and review of the explicit installed paths, using two different new private output directories:

```sh
python3 docs/verification/claude-permission-transport-native.py "$BASH_TRANSPORT_OUTPUT" --tool Bash --server-name agent-hub --permission-tool hub_permission_request --require-tool-use-id --claude "$CLAUDE_CONTROL_BINARY" --claude "$CLAUDE_2312_BINARY"
python3 docs/verification/claude-permission-transport-native.py "$BASH_REWRITE_OUTPUT" --tool Bash --rewrite-bash --server-name agent-hub --permission-tool hub_permission_request --require-tool-use-id --claude "$CLAUDE_CONTROL_BINARY" --claude "$CLAUDE_2312_BINARY"
```

The required repository gate remains `scripts/check.sh --changed` at that committed head. Any macOS host-wrapper positive branch must be reported separately from the Linux branch that deliberately asks without `sandbox-exec`.

Isolated model-free native probe, after host-resource admission, using explicit reviewed installed paths and a new private output directory:

```sh
python3 docs/verification/claude-shell-wrapper-native.py "$TRIAGE_OUTPUT" --bun "$BUN_BINARY" --claude "$CLAUDE_CONTROL_BINARY" --claude "$CLAUDE_2312_BINARY"
```

Repeat `docs/verification/claude-permission-transport-native.py` as well as the wrapper producer before proposing a verified-version bump. Read the existing [permission transport receipt](2026-10-23-headless-claude-permissions.md) and [host-wrapper receipt](2026-10-26-headless-claude-shell-context.md) for the exact strict MCP, empty settings sources, synthetic loopback provider, isolated homes, external 25-second deadline, original request/rewritten reply checks, replay effect count, owned-process-group cleanup and binary-fingerprint checks. The command above is a proposed local diagnostic, not a run receipt. It uses no account or real provider.

## Remaining unknowns

- The exact 2.1.312 native permission request, schema validation result, MCP reply and native tool-result error from the reported incident.
- Whether the failing command reached `permission_request` and the wrapper proof, reached the manual queue, or failed before either.
- Whether the reportedly empty console was attached to the same daemon instance and request id while the row was still pending.
- Whether a controlled missed-push case occurs in normal use, beyond the deterministic console fixture.
- Production-daemon/native host-wrapper behavior on 2.1.312 and a real person's account-backed approval leg. Generic transport passed the isolated comparison above.
