# Always-ask adapter receipt (#636 slice 3)

The host sees and gates received Codex command approvals and every local/Pi model tool call. Codex remains listed as `always-ask not enforceable`: a native call can execute without sending an approval request. This is a capability ceiling, not a statement that all native calls were observed.

## Native Codex boundary

On 2026-10-24, the installed `codex-cli 0.163.0` ran under an isolated HOME and CODEX_HOME with a fresh project directory. The environment contained only the explicit executable PATH and those two isolated homes. Version, schema generation and app-server initialize completed with zero stderr bytes. No login, provider request, model turn or real personal Codex home was used. Native initialization confirmed 0.163.0 and the isolated home. Host and installation identifiers are omitted here.

The generated ServerRequest schema SHA-256 is `f339be472737a0003efa25fba2e6e6c9237e621cd065b6d6995c51256e9dc1fb`. It defines:

- `item/commandExecution/requestApproval`: threadId, turnId, itemId and startedAtMs; command/cwd may be null; kind may be command or writeStdin. The gate handles a reported command, excluding writeStdin, and binds its answer to the observed live turn. Its response is accept or decline.
- `execCommandApproval`: conversationId, callId, command argv and cwd. The gate preserves argv for classification and answers approved or abort.
- File-change and permission-profile approvals carry different payload contracts. They remain native, as do absent/unknown command payloads.
- Native approval policy includes `never`. The existing hub mode mapper sends approvalPolicy never for never-ask. The proxy has no pre-tool path when no RPC is emitted. Received-RPC tests prove gating in all hub modes, not interception of an absent request. No authenticated native never-ask execution was attempted.

Codex and ACP approval copy stays privacy-screened; a cut, withheld or changed command is deny-only. The local/Pi on-prem console receives the complete tool title as described below. An intercepted id is answered once and suppresses guessed, duplicated or late TUI replies. Thread/turn replacement, completion, interruption, disconnect and stop invalidate pending decisions before effects. A missing current native turn denies. `ponytail:` each socket retains at most 1024 intercepted ids; reaching the cap closes both sides instead of evicting late-reply fences. The upgrade is an explicit reattachment/session-lifetime protocol.

## Local and Pi boundary

The shared tool runner passes its parsed arguments into the existing host permit callback. The host fixes cwd/workdir to the execution root it actually uses and runs the same action classifier before never-ask, ask-when-needed and Pi's per-tool grant. A classed call waits for a person's allow-once or denial even in an unattended daemon. Only the separately labelled explicit class-budget option opens a bounded allowance. Unknown calls still follow their existing mode. All existing path revalidation, readonly and sandbox checks remain in place after approval.

Pi's persisted call receipt contains the classification and approval operation, so replaying the same call id spends no second allowance. Its verified person-authored idle shell retains its existing person-command path. No model tool is relabelled as a person command.

The managed terminal and headless Claude forms remain in the status table: terminal evidence must match a live hooked generation; the owned headless form installs the managed hook and accepts only current-child allow-once/denial through its native prompt tool. Native requirements are never relaxed by a cached class budget.

A cut approval command is marked `[cut, N chars]` and offers only denial, with no allow-once or multi-call budget. Whole-command privacy screening precedes the cut. `ponytail:` startup still reads untracked machine-local action policy without retained person confirmation. Weakening defaults is visible as attention in status; the upgrade is a retained person-bound startup confirmation.

## Verification

The dedicated tests use loopback fake transports and fresh temp projects with no git remote. The harmless marker before `git push` proves whether a denied or stale call executed without requiring network activity. Native sandbox-exec provides the allowed-effect leg on macOS; Linux preserves the explicit unavailable-sandbox refusal rather than widening execution.

Pinned Bun 1.4.2 typecheck and 74 focused tests passed (670 assertions), including real daemon Local/Pi approvals, managed headless Claude status, shared ACP/Claude regressions and the registry guard. Replacing the shared host gate with an unconditional native fallback made both new real-daemon tests fail named assertions, with no timeout; the original source was restored byte-for-byte. The full changed gate is recorded in the PR handoff. Real provider/model turns remain unverified. PR #749's budget kind/source fields and its token counters are separate from these per-session action allowances; its daemon and documentation hunks are retained when rebasing.


## Rebase onto 0.15.0 and crash-status regression

The branch keeps the 0.15.0 release changelog section and its Jcode/headless-Claude documentation recheck, with this feature under Unreleased. The generated bundle was rebuilt with frozen dependencies and Bun 1.4.2. Runtime and test code were unchanged by the rebase itself.

A subsequent bot finding exposed an unexpected-exit status gap: Pi.fail marks the peer offline without setting its requested-stop flags, so acceptingTools alone could still report active enforcement. The status projection now requires both a non-offline state and acceptingTools. A real daemon regression makes its fake native Pi process exit with code 7; before the fix it fails the named enforceable=false assertion, and after the fix status is not enforceable and the stopped tool endpoint performs no effect. Typecheck, the 12 relevant tests (187 assertions), and bundle freshness pass. All test/gate invocations clear inherited AGENTHUB_HOME per the current area note. The interrupted pre-fix gate is not counted as passing proof; the final changed gate is reported separately.


## Round-one presentation and status boundaries

The person's on-prem local/Pi console now receives the complete host tool title after the class line, even for a private turn. The host-only optional presentation port must match the exact executed bash/git form. A shortened, withheld or mismatched view is deny-only and carries no class-budget choice. ACP/Codex consumers also enforce the deny-only flag against forged answers. Their unknown/unclassed native flow is unchanged. A public positive budget control remains covered; the former private-command budget-acceptance expectation is replaced with denial because approval of hidden commands is the rejected behavior.

Red-first real daemon controls reproduced both failures: a 793-character command lost its significant tail at the public 512-character cut, and a PII-turn command became wholly withheld. They now verify full console visibility, denied effects and allow-once behavior, plus absence of private material from logs, status, ordinary peer messages and subsequent model history. Pi has its own long-command control. Incomplete host-title, native cut/withheld and forged grant controls deny.

Managed Claude implementer status requires a current busy child generation. An idle instance with no process is not enforceable (also fixes #402); the idle assertion failed before that correction, while the existing active-child positive control remains. Local action allowances now use a dedicated session port and no longer widen contextSession for checkpoints, telemetry or supervision.

Legacy Codex execCommandApproval has a conversation/call id but no provable native turn id by itself. Without an observed active turn from turn/started it is auto-declined, without a person request; no turn identity is invented. A dedicated legacy no-turn control pins this fail-closed compatibility ceiling. Native 0.163.0 command payload shapes were probed model-free; real legacy-provider behavior remains unverified.

All actual conflict markers in operations.md were removed, preserving the intended local-policy text and its open startup-confirmation ceiling. The first-party tracked/untracked tree scan (excluding .git and node_modules) returns zero markers. Relevant focused checks pass 59 tests / 648 assertions; final gate results are in the PR handoff.
