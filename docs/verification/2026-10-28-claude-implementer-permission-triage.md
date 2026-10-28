# Claude implementer permission triage

Date: 2026-10-28. Scope: agent-hub task 544, source inspection and isolated fake fixtures only. Reported target: Claude Code 2.1.312, explicitly trusted but not receipt-verified, using `ask-when-needed`.

The reported symptoms are a permission-tool harness error before `bun test test/ci-watch.test.ts` executes, and approval-waiting notices when the person's console appears empty, followed by expiry. This report does not treat those observations as a reproduced native defect. No production source, permission ceiling, COMPAT entry, installed native binary or account configuration changes in this triage.

## Evidence status

| Evidence | Status and limit |
| --- | --- |
| Version admission, wrapper and approval source paths | Read at the triage base `f7450129` |
| Opt-in deterministic fake diagnostic cases | Prepared in `docs/verification/claude-implementer-permission-triage.ts`; execution result not yet recorded |
| Native 2.1.312 permission dispatch and `updatedInput` rewrite | Unverified; no native run performed by this triage |
| Person's reported incident and console connection identity | Not independently reproduced |
| Real provider, model, credentials or account interaction | Not run |
| Exact-head gate and hosted CI | Recorded separately by the implementer after verification |

## Source-backed conclusions

There is no verified-only host-wrapper gate. `assessVersion` in `src/adapters/compat.ts` admits the person's exact machine trust as `ok: true, state: "trusted"`. `proveClaudeImplementer` in `src/adapters/claude-implementer.ts` checks that admission and the binary fingerprint; it does not require the verdict's state to be `verified`. The adapter's native argv retains `default`, the strict MCP inventory and the permission prompt tool for both admitted states.

`automaticImplementerShell` in `src/hub/daemon.ts` has no independent native-version predicate. Its gates are current child/generation, isolated execution root, an owned public task, `ask-when-needed`, closed command/input shape, current branch/default-branch evidence, public metadata, action-policy checks and the required host confinement. `taskShellCommand` recognizes `bun test test/ci-watch.test.ts` lexically. Recognition alone grants nothing. Executable test/build/check requests require `sandboxAvailable()`; an unsupported host follows the ordinary person approval path. This is expected behavior, not evidence that the trusted version was silently disabled.

A failure can occur before any console approval exists. The production MCP handler in `src/adapters/claude-channel.ts` requires `tool_name`, an object `input` and a nonempty `tool_use_id`; invalid arguments return a fixed denial before requesting the daemon. The daemon also refuses an unavailable or stale owned-child/root binding before entering `requestPermission`. The 2.1.309/2.1.310 receipts prove their observed native schema and rewrite behavior, not 2.1.312's behavior. A 2.1.312 native schema, MCP startup or rewritten-result incompatibility remains a hypothesis until the isolated native probe captures the actual request and response.

Approval transport uses one shared daemon map. `requestPermission` registers the row before `writeStatus` and the `permission` push, and a fresh console's `tail` request replays all still-pending pushes. Status exposes pending ids/times; the dashboard's `permissions` collection projects the same map. Expiry removes the row before emitting closure and resolving the native request as a denial.

The console has a narrower information source: `runConsole` updates `state.approvals` on `permission` and `permission_closed` pushes. Its status refresh reads peer/task/attention facts but does not reconstruct the approval rows from `status.approvals`. Therefore a deliberately omitted push leaves its local approval panel empty even when the fake status says a request exists. This is a source-backed observability gap, not proof that the real WebSocket lost the reported push. An expired/cancelled request, another project/instance connection, pre-queue native failure or a missing push must be distinguished using the same request id and daemon instance.

`OwnedPrintChild` ignores native stderr, and `ClaudeImplementerPeer` reduces an unsuccessful native result to the fixed `Claude implementer turn failed` outcome. Consequently the generic delivery failure alone does not establish which native permission-harness stage failed. Do not infer a host wrapper refusal, a missing person answer or a native compatibility defect from that generic outcome.

## Isolated fake fixture

The opt-in diagnostic producer uses a fresh HOME, CLAUDE_CONFIG_DIR, AGENTHUB_HOME and AMEM_HOME; a disposable Git repository and separate non-default-branch worktree; an outside-project Git shim with system/global config disabled; a fake native executable answering only its synthetic version and recording argv/launch metadata; and actual daemon, control-client, MCP channel and console code. Memory, inference, MLX and automatic Pi startup are disabled. A fixed host default-branch test port prevents a GitHub query. No installed Claude binary, personal authentication file or provider is selected, and an issued wrapper ticket is never redeemed.

The fake reports 2.1.312 while that version is unverified. If a later dated receipt verifies it, the fixture uses a synthetic unverified version to retain its admission-policy test without blocking legitimate COMPAT updates. This is not a native compatibility assertion.

| Case | Required observation |
| --- | --- |
| Trusted, unverified fake version | Startup admitted with native `default` and the fixed prompt-tool argv; no bypass mode |
| Closed test command | On a sandbox-capable host, host protocol 1 rewrites the command; without the host sandbox, ordinary approval expires as deny, with no rewrite |
| Real daemon manual approval | Same request id appears in the live console push, status inventory and a fresh console's tail replay, then is withdrawn on its fixture deadline |
| Missing `tool_use_id` | Actual production source MCP handler returns `invalid native permission request`, with no approval row or permission push |
| Deliberately withheld console push | Positive fake status alone leaves the console panel empty; a later valid push makes the request visible |

The console case deliberately characterizes the current missed-push bug. It lives outside the automatic regression suite, so it does not require that bug to persist. It adds no production repair or broader authorization. The host command case tests policy using a fake native. Neither certifies the installed 2.1.312 permission dispatcher, real model tool selection or a person's live approval interaction.

## Commands for the implementer

Explicit fake diagnostic command, after committing the intended files and taking the permitted remote slot. Whether this Bun version accepts the explicit regular `.ts` path remains to be checked by the implementer:

```sh
env -u AGENTHUB_HOME bun test ./docs/verification/claude-implementer-permission-triage.ts
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
- Native 2.1.312 compatibility and a real person's account-backed approval leg.
