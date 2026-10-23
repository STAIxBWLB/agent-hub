# Always-ask adapter receipt (#636 slice 3)

The host sees and gates received Codex command approvals and every local/Pi model tool call. Codex remains listed as `always-ask not enforceable`: a native call can execute without sending an approval request. This is a capability ceiling, not a statement that all native calls were observed.

## Native Codex boundary

On 2026-10-24, the installed `codex-cli 0.163.0` ran under an isolated HOME and CODEX_HOME with a fresh project directory. The environment contained only the explicit executable PATH and those two isolated homes. Version, schema generation and app-server initialize completed with zero stderr bytes. No login, provider request, model turn or real personal Codex home was used. Native initialization confirmed 0.163.0 and the isolated home. Host and installation identifiers are omitted here.

The generated ServerRequest schema SHA-256 is `f339be472737a0003efa25fba2e6e6c9237e621cd065b6d6995c51256e9dc1fb`. It defines:

- `item/commandExecution/requestApproval`: threadId, turnId, itemId and startedAtMs; command/cwd may be null; kind may be command or writeStdin. The gate handles a reported command, excluding writeStdin, and binds its answer to the observed live turn. Its response is accept or decline.
- `execCommandApproval`: conversationId, callId, command argv and cwd. The gate preserves argv for classification and answers approved or abort.
- File-change and permission-profile approvals carry different payload contracts. They remain native, as do absent/unknown command payloads.
- Native approval policy includes `never`. The existing hub mode mapper sends approvalPolicy never for never-ask. The proxy has no pre-tool path when no RPC is emitted. Received-RPC tests prove gating in all hub modes, not interception of an absent request. No authenticated native never-ask execution was attempted.

The console always sees screened public approval copy. An intercepted id is answered once and suppresses guessed, duplicated or late TUI replies. Thread/turn replacement, completion, interruption, disconnect and stop invalidate pending decisions before effects. A missing current native turn denies. `ponytail:` each socket retains at most 1024 intercepted ids; reaching the cap closes both sides instead of evicting late-reply fences. The upgrade is an explicit reattachment/session-lifetime protocol.

## Local and Pi boundary

The shared tool runner passes its parsed arguments into the existing host permit callback. The host fixes cwd/workdir to the execution root it actually uses and runs the same action classifier before never-ask, ask-when-needed and Pi's per-tool grant. A classed call waits for a person's allow-once or denial even in an unattended daemon. Only the separately labelled explicit class-budget option opens a bounded allowance. Unknown calls still follow their existing mode. All existing path revalidation, readonly and sandbox checks remain in place after approval.

Pi's persisted call receipt contains the classification and approval operation, so replaying the same call id spends no second allowance. Its verified person-authored idle shell retains its existing person-command path. No model tool is relabelled as a person command.

The managed terminal and headless Claude forms remain in the status table: terminal evidence must match a live hooked generation; the owned headless form installs the managed hook and accepts only current-child allow-once/denial through its native prompt tool. Native requirements are never relaxed by a cached class budget.

A cut approval command is marked `[cut, N chars]` and cannot offer a multi-call budget. Whole-command privacy screening precedes the cut. `ponytail:` startup still reads untracked machine-local action policy without retained person confirmation. Weakening defaults is visible as attention in status; the upgrade is a retained person-bound startup confirmation.

## Verification

The dedicated tests use loopback fake transports and fresh temp projects with no git remote. The harmless marker before `git push` proves whether a denied or stale call executed without requiring network activity. Native sandbox-exec provides the allowed-effect leg on macOS; Linux preserves the explicit unavailable-sandbox refusal rather than widening execution.

Pinned Bun 1.4.2 typecheck and 74 focused tests passed (670 assertions), including real daemon Local/Pi approvals, managed headless Claude status, shared ACP/Claude regressions and the registry guard. Replacing the shared host gate with an unconditional native fallback made both new real-daemon tests fail named assertions, with no timeout; the original source was restored byte-for-byte. The full changed gate is recorded in the PR handoff. Real provider/model turns remain unverified. PR #749's budget kind/source fields and its token counters are separate from these per-session action allowances; its daemon and documentation hunks are retained when rebasing.
