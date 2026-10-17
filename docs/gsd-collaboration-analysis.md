# GSD-shaped collaboration in agent-hub (#252)

Source review: 2026-10-11, agent-hub 5647038. Recommendation: preserve the default flow; offer a bounded gsd-lite checklist/dependency presentation through #257's opt-in lifecycle. Defer a bidirectional GSD artifact bridge until it has a separately reviewed import contract and measured value.

## Evidence boundary

This is source-based analysis, not a measured claim that GSD improves quality or cost. No matched default/GSD comparison or add-on arm ran in this solo implementation. Research records (#247, docs/research.md) store task outcomes, counts, tokens and timings, not task/plan text. The #251 bench infrastructure can compare configurations on a common suite, but infrastructure existence does not provide an effect estimate.

The inspected local adapter is `~/.agents/skills/gsd-execute-phase/SKILL.md`, SHA-256 `b10610df4d9b55bdf39141cbf469525f1429cea4ae774dc4cd486520a62cae51`. Its installation revision was not recorded, so it is not asserted to equal an upstream release. Independently reviewed upstream [execute-phase command](https://github.com/gsd-build/get-shit-done/blob/bdcaab2c752d9a33a1a1ca9acf3a3c81fb991815/commands/gsd/execute-phase.md), [workflow](https://github.com/gsd-build/get-shit-done/blob/bdcaab2c752d9a33a1a1ca9acf3a3c81fb991815/get-shit-done/workflows/execute-phase.md) and [installer](https://github.com/gsd-build/get-shit-done/blob/bdcaab2c752d9a33a1a1ca9acf3a3c81fb991815/bin/install.js) at full commit `bdcaab2c752d9a33a1a1ca9acf3a3c81fb991815` establish Codex support, dependency waves and context handoff. Codex worktree isolation is explicitly refused by that workflow; support is not a blanket guarantee of runtime parity. Therefore the issue's older claim that non-Claude runtimes cannot use GSD is too broad: Codex integration exists. Kimi/Pi/local runtime coverage was not established. The skill was inspected as reference material; its delegation/autonomous workflow was not invoked.

## Benefits and costs (qualitative)

| GSD idea | Current hub mechanism | Potential value | Cost or failure boundary |
| --- | --- | --- | --- |
| Shared written plan | Issue spec plus Task.plan signatures/paths/insertion points | More consistent implementation scope and fewer context rediscoveries | Copying the issue into an independently editable PLAN creates spec drift; derive it and preserve issue precedence |
| Dependency waves | Tasks.after waits for approval; overlap/cohort guards already protect integration | Expose safe concurrency and explain why work waits | A whole-wave barrier can idle independent successors; use exact predecessor edges, not an unconditional global wave barrier |
| Goal-backward verification | sendReview already renders a per-task checklist | Catch phase-level omissions that individually passing tasks miss | A checklist is not evidence; require exact artifacts/check results and permit inconclusive findings |
| Durable STATE/HANDOFF | Board/history, receipts, events, #247 records | Recover human understanding of purpose and remaining work | A second writable state authority loses or duplicates work; board remains authoritative, exports are derived |
| Codebase map/context packets | Plans, refs, briefs, facts and native context readings | Reduce repeated discovery across peers | Maps go stale; source hashes and bounded context are needed; privacy/PII rules remain at existing boundaries |
| Atomic per-task commits | Repository branch/PR conventions | Reviewable rollback and clearer scope | Additional commits are not proof of independent review; immutable head and CI gates still belong to SDLC |

These are hypotheses. There are no measured first-pass, rework, regression, token, wall-time or operator-overhead differences reported here.

## Mapping and authority

- A phase maps to an issue/release slice, not a replacement spec. Its tasks are board tasks with explicit after edges; runtime-specific executors are ordinary owners under existing roles and capabilities.
- Verification is a reviewer task with the phase's deliverable checklist. Task approval and phase verification remain distinct; a failed phase check does not silently erase completed task history.
- STATE/HANDOFF are board-derived readbacks with artifact ids, current heads, pending gates and next actors. Import is a validated proposal, never an overwrite of accepted work.
- GSD's workspace-pinned no-auto-advance and branch-first rules are retained. This comparison grants no extra command, permission, tool, sandbox, native restart or coordinator authority.
- PII stays local/on campus, untrusted text is sanitized by existing output boundaries, and model-written guidance is not evidence merely because it is in a plan.

## Recommended delivery contract (specified before implementation)

The initial option is gsd-lite, off by default, implemented with #257's lifecycle rather than a second scheduler:

- `workflow: none | gsd-lite` is a data choice, with none the default. It changes guidance/presentation only unless SDLC enforcement is separately selected.
- Planner input is a bounded list of task ids and predecessor ids. It resolves to exact existing after edges, validates acyclic dependencies, preserves accepted owners/reservations and rejects private text on cloud surfaces. No model-generated wave bypasses Tasks.
- A phase reviewer checklist stores criterion ids and evidence refs. The reviewer may pass, request changes or mark an item unverified; the parent slice is not complete while a required item remains unverified.
- route explain, console and dashboard show the active workflow and blocking predecessor/verification gates from the same data; defaults remain unchanged.
- No extra STATE/PLAN/HANDOFF authority is introduced. Explicit exports contain safe derived state and source hashes. No auto-advance or autonomous merge/release.

This bounded option is covered by a dated amendment to #257 before code. A full `workflow: gsd` bridge is not recommended for implementation yet: it needs bounded import size, source/phase identity, idempotency, conflict handling, authority and PII rules defined in a separate contract. That distinction prevents calling a partial bridge done.

## Measurement plan

Use #251 on the same sealed suite, native/model/effort profiles, role set, tools, permission modes and resource limits. Compare default versus gsd-lite checklist/dependency presentation. Preregister the task-family split and attempt/token/wall-time budget; include failed/time-limited attempts, abstentions and operator interventions. Report approved-task rate, first-pass rate, rework/regressions, observed conflicts/idle time and normalized token/time measures with family-cluster intervals. Missing activity or provider costs stay unknown. #248 separately measures add-ons; they are not credited to the workflow without their own controlled condition.

No measurement was run here. AC1 is answered qualitatively and AC2 has the bounded #257 contract; #252 stays open for the built option and AC3 comparison. Native multi-agent research is outside this turn's solo/no-ahub execution.
