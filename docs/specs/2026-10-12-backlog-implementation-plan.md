# Remaining implementation plan and issue audit

## Scope and evidence snapshot

- Owner request: audit all open issues, close completed work, correct partial work, plan the remaining implementation and retain the research track with a research label.
- Repository: STAIxBWLB/agent-hub. Source baseline: main 7759ee8a3c5471e434ea6e0a7b73596a96bdf451, 2026-10-12 KST. The intake contains 27 open issues and one ready open PR, #346.
- Nineteen delivery PRs have merged since the #324 intake: #325, #326, #328, #329, #330, #331, #333, #334, #335, #336, #337, #338, #339, #340, #341, #342, #343, #344 and #345. Do not equate source merges with release, installation or native acceptance.
- Solo implementation continues under the existing owner constraint. No ahub coordination, delegated implementers, release, installation or live hub activation is part of this audit.
- Repository issue bodies remain the acceptance contracts. This document orders their remaining slices; it does not replace their original criteria or authorize new research experiments.
- Full vault enrichment is skipped for this repository-local audit: GitHub contracts, source and verification receipts resolve the scope without a person or institution ambiguity.

## Phase 0: documentation and API discovery

Read the applicable area notes before editing. Read every docs/agent-notes file before editing daemon.ts, main.ts or launch.ts. Re-read the issue and current source before each slice; this snapshot will drift.

| Existing boundary | Confirmed source or pattern | Use in later work |
| --- | --- | --- |
| Task mutations | src/hub/tasks.ts, Board.propose/update in src/hub/board.ts | Extend Tasks, then persist; never mutate Board from an adapter, tool or CLI. |
| Lifecycle | sdlcConfig, sdlcReceipt, readSdlcPr in src/hub/sdlc.ts; src/hub/workflow.ts; test/sdlc.test.ts and test/workflow.test.ts | Retain exact-head readbacks, bounded receipt claims and existing phase ownership. Custom stage definitions currently refuse. |
| Profiles | projectProfile, profileClass in src/hub/profiles.ts; docs/profiles.md; test/profiles.test.ts | Reuse base-class mapping. PR #346 adds resolveProfile/mergeProfileOverrides; confirm its merged status before using those APIs. |
| Roles | loadRoleCatalog, catalogAssignments, selectedRoles, catalogSection in src/hub/roles.ts; docs/roles.md | Guidance adds no authority. Reuse person settings and original proposal identity. |
| Data policy | docs/data-policy.md; existing declared-path policy and local/Pi managed-tool tests | Extend one matcher, preserving lexical/real-path, alias and hardlink defenses. |
| Document projection | src/hub/text-projection.ts, projection-exec.ts; docs/text-projection.md; test/projection-surfaces.test.ts | Bounded read-only conversion, scoped historical blobs and sanitized previews. |
| Shadow Git | docs/profiles.md; test/shadow-repo.test.ts, shadow-cli.test.ts, shadow-daemon.test.ts | Explicit opt-in, protected bare metadata, no preview HEAD/index writes. |
| Assignment | src/hub/routing.ts assign and route explain | One pure decision for execution policy and explanations. |
| Evidence and memory | src/hub/research.ts, src/memory/client.ts, brief.ts, capture.ts, src/hub/ask.ts | Keep event identities, unknown observations, fail-open memory and PII exclusion. |
| Native peers | docs/agent-notes/adapters.md; test/qwen-peer.test.ts; docs/verification/2026-10-11-jcode-peer-contract.md | Per-version capability and identity proof; no invented permission mode or restoration claim. |
| Dashboard | src/hub/ui.ts and current settings/role controls | Preserve loopback, Origin refusal, CSP, keyboard access and existing public projections. |
| Verification | docs/agent-notes/tests.md, scripts/check.sh, scripts/seeded-check.ts | Original assertion green, mutation assertion fails; guards run sequentially. |

Allowed APIs are the existing names above and the source confirmed at the start of a slice. Proposed modules and commands below require a spec amendment before implementation; their appearance in this plan is not proof they already exist.

## Audit disposition of every open issue

| Issue | Disposition | Remaining closure evidence |
| --- | --- | --- |
| #1 | Keep open, native infrastructure | Authorized off-campus Access leg and natural attached Codex budget pause; never manufacture quota pressure. |
| #8 | Keep open, research | Normal-use overlap count, conflict attribution and owner decision; review around 2026-10-14, extend if usage is insufficient. |
| #30 | Keep open, research tracker; correct stale maturity checkboxes | L1-L5 and measured T1-T6, with separate research gates. #185-#189 are already closed. |
| #41 | Keep open, research | Capability-led isolated transaction, quiescence, fenced two-part resolution, fault injection and actual supported native readback. |
| #42 | Keep open, research | Versioned executable commitments and all five preregistered pilot arms after #41. |
| #43 | Keep open, research | Documented development/held-out dataset, predictor and regime outcomes after #42. |
| #44 | Keep open, research | Telemetry quality, trace replay, then optimizer/live week and review-routing comparison. |
| #45 | Keep open, research | Adapter observability profiles first, then lattice/model/protocol analysis. |
| #109 | Keep open, research | Current-version routing-time calibration and held-out errors; automatic rerouting remains gated. |
| #198 | Keep open, research measurement | Actual PII model recall against fixed 0.90 bound, precision and unknown rate; existing screen is shipped. |
| #199 | Keep open, research measurement | Mixed Pi/digest workload wait-time comparison; existing load/cooldown source is shipped and absent threshold stays off. |
| #248 | Keep open, research | Tooling fingerprints, controlled arms, intervals and adopt/optional/drop decisions. |
| #252 | Correct stale status; keep open, research measurement | GSD analysis and optional gsd-lite are merged; default versus gsd-lite measurement remains. |
| #256 | Close completed optional implementation after transfer to #273 | AC3 allows explicit native unverified. Preserve identity/provider/tool/stop/recovery/quota obligations in #273; no default replacement. |
| #257 | Correct partial status; keep open | Custom lifecycle schema, full merge/release readiness and actual advise cycle. Built-in gates/checklists already shipped. |
| #258 | Keep open | Store/tiers/graph/retrieval, private sync/tombstones/leases, dashboard, import and controlled measurement. |
| #259 | Correct partial checkboxes; keep open | Glob policy/Claude-grant interaction and PR #346 overrides. Native research-profile run remains explicitly unverified. |
| #263 | Keep open | Backlog state, person/planner mutations, releases/dates, board/legend and optional read-only GitHub import. |
| #264 | Keep open | Static Flat view, snapshot motion, optional ids, Isometric and backlog/release scene. |
| #266 | Keep open, mixed implementation/research | Native capability table, task execution policy, matrix/recommendation and evidence-led escalation. |
| #273 | Correct and expand owed native ledger; keep open | Dated actual receipts, including merged Kimi #328 and Qwen #331 follow-ups. |
| #280 | Keep open | Attention model/console line, selected artwork and variants, then status/dashboard. |
| #285 | Keep open | Owned Kimi wire usage, count windows, source-labelled budget surfaces; credential probe remains a separate decision. |
| #286 | Keep open | Watch is shipped; terminal-provider integration and gated Qwen dual-output TUI/native coverage remain. |
| #295 | Correct partial checkboxes; keep open | Reconcile original AC3 byte baseline and finish AC13 task-role board card after #263. Catalog/task/settings/session records already shipped. |
| #324 | Correct master status; keep open | This ordered backlog and per-slice source/native/research receipts. |
| #332 | Keep open | Jcode native project MCP tool receipt, remaining PII/native log proof and independently verified restored identity; current 0.94.0 cannot prove automatic restoration. |

Research label set: #8, #30, #41, #42, #43, #44, #45, #109, #198, #199, #248, #252 and #266. A research project profile (#259) and research role definitions (#295) are product features, not themselves experiments. #1 and #273 are native verification ledgers. Mixed #266 remains labelled research while its independently reviewable source slices can proceed.

## Delivery sequence

Each numbered phase is a sequence of small PRs, not one large implementation branch. Work begins only from the current verified main. Preserve unrelated worktrees and unknown dirty work. Dependency arrows refer to completed source contracts, not assumed native success.

### Phase 1: finish the active profile slice and data policy

- Scope: #259; open PR #346 project overrides, then bounded pii.paths/data.readonly glob matching and Claude scoped-grant interaction.
- PR #346 snapshot: head 384a222e77c74c9e37e6c238dd943da519a9e5aa, local full 2249/0 with check: OK, macOS and Linux platform checks successful after one limited Linux sidecar retry. The 133-guard job is still running at planning time. Both review findings are fixed/resolved. Do not merge before the complete exact-head receipt.
- Read docs/profiles.md, docs/data-policy.md, docs/agent-notes/tasks.md, local-worker.md, adapters.md and tests.md. Follow the existing resolved-profile propagation and path-policy tests.
- Specify accepted glob grammar, normalization, directory containment and limits before code; reject ambiguous/unbounded patterns. Use the same lexical/resolved matcher for private task classification, facts exclusion and managed write refusal. Unknown resolution remains conservative. A pattern cannot widen a protected grant.
- Verify unchanged default dev bytes; isolated shared/local overrides; custom alias/base persistence; disjoint document sections across different owners; all native/local tool schemas; glob symlink/case/parent/hardlink tests; no marker in events/memory; Claude grant refusal for protected paths.
- Exit: PR #346 merged with cleanup, then glob AC7 proved. Record native/model ingestion as unknown until actual receipts exist. Do not run a multi-agent research pilot as a source test.

### Phase 2: lifecycle completion

- Scope: #257 and the remaining specification boundaries informed by #252.
- Read docs/sdlc.md, docs/gsd-collaboration-analysis.md, sdlc.ts, workflow.ts and their fake-gh suites. Reuse readSdlcPr, current head fences and existing reviewer/person ownership.
- Slice A: bounded custom stages, actors and named gates, with cycle/duplicate/unknown validation and versioned persistence. Amend the spec first. Keep built-in default bytes and mode off/advise/enforce semantics.
- Slice B: read-only merge ordering and release readiness: exact merged/head identities, required checks, unresolved requests/threads, docs stale/nonancestor status and owed native receipts. Every unavailable readback is unknown.
- Slice C: shared CLI/console/dashboard projections with actor, blocker and next action; no auto-advance, merge/release, capability grant or second writable plan store.
- Verify stale-head/late-read/reassignment races, missing check set, changes requested, custom gate cycle rejection, PII projection and old row compatibility. A fake GitHub is source evidence only.
- Exit: source criteria implemented. AC6 actual advise cycle through merge/release remains a separately owed native/operational gate. #252 comparison stays open; full bidirectional GSD import needs its own authority/import contract.

### Phase 3: project board and role card completion

- Scope: #263, then #295 AC13 and AC3 baseline reconciliation.
- Read docs/agent-notes/tasks.md and daemon.md, current Tasks/Board/routing and role settings controls. Add mutations only through Tasks.
- Slice A: backlog state and validated promotion/demotion; prove backlog never routes, claims, offers, sweeps or escalates. Migrate legacy rows without rewriting history.
- Slice B: planner grooming, bounded split/pull, batched notices, pinned/frozen release fences, reason/history and undo. Refuse non-planners and preserve private stubs.
- Slice C: release create/allocate/freeze/ship and dates. Actual timestamps derive from history, not user input; ship requires all tasks approved or deliberately removed.
- Slice D: five-column dashboard, ready/waiting distinction, status-backed peer legend, keyboard equivalent for person drag actions, task-role card and optional idempotent read-only GitHub import.
- Reconcile #295 original 1cbbc57 baseline against the shipped d83cb8dd contract fixture before checking AC3. If an intentional contract amendment is needed, document the exact comparison and reason rather than changing the assertion silently.
- Verify all state transitions, undo, scope freezes, old rows, actor refusal, marker privacy, keyboard/phone layout and CSP/Origin headers. Use one shared palette and projection.
- Exit: board contracts and source role surfaces complete; an actual planner/two-release cycle remains unverified until separately run or explicitly recorded as unverified where allowed.

### Phase 4: person attention and agent office views

- Scope: #280 console attention, #264 office, then their dashboard integrations after Phase 3.
- Read the full original visual contracts and existing console/dashboard models before frontend skills or assets. Use the approved design language and retain list/key paths.
- Attention slice A: pure needs model from existing approval/default/delivery/storage/message/budget/recovery states; plain console line, count, configuration and --no-pet. No daemon change.
- Attention slice B: mini/full and ascii/blocks STAI artwork with owner-selected alternatives and license/attribution. Unselected variants remain decisions; do not invent an asset adoption.
- Attention slice C: optional ids/counts in status and ahub pet commands, then inline SVG/dashboard title count. Never expose task/approval/message bodies beside the pet.
- Office slice A: officeModel, stable peer slots, static Flat SVG, Off default, keyboard/list highlighting, phone and theme proof; no scene actions.
- Office slice B: snapshot-triggered motion with reduced-motion static equivalent and settle rules; unchanged snapshots cause no DOM writes. No polling animation loop.
- Office slice C: bounded optional turn/checking/links id fields, old-page compatibility and no schema bump unless separately justified; then Isometric from the same model/focus order.
- Office slice D: backlog wall/release docks/planner desk after #263. Measure each served-page size delta against the 30 KB budget.
- Verify marker privacy, source-labelled attention counts, no outside/data requests, CSP unchanged, no inline handlers/style attributes, no-colour/phone/reduced-motion/keyboard behavior. Live browser/terminal looks remain separately recorded.

### Phase 5: native memory foundations

- Scope: #258. This changes the current hub-does-not-own-a-memory-store architecture; amend spec decisions 9/10 before source changes.
- Read docs/agent-notes/local-worker.md, tasks.md, daemon.md, src/memory and ask.ts. Reuse privacy filtering and evidence-only answer identities; never include hub-model answers as fresh evidence.
- Slice A: bounded append-only long-term store, short-term expiry, approval promotion of decision/contract/fail only, deterministic refs/plan/path/issue graph and supersession-aware retrieval. Establish schema/identity/version/tombstone rules first.
- Slice B: memory CLI and CSP-local dashboard list/neighborhood/detail; incremental index equals rebuild. Suggested model edges stay excluded from briefs/ask until person-confirmed.
- Slice C: private-remote git sync with two simulated AGENTHUB_HOMEs, immutable segments, concurrent writes and forget propagation. Verify remote privacy; missing/unreadable remote fails open with one notice.
- Slice D: machine identity, long-term task leases, expiry/person force and explicit concurrent-claim conflict. A synchronized lease is not an atomic distributed lock; preserve uncertain ownership.
- Slice E: bounded claude-mem import and optional proposed edges, retaining provenance/privacy and confirmed authority. Do not duplicate or mutate the existing claude-mem database.
- Verify marker absence in store/index/remote, malformed/truncated segment recovery, supersession/linked fail ordering, replay equivalence, concurrent tombstones and lease conflicts.
- Exit: source contracts and simulated sync proven. AC11 memory-off/claude-mem/native-graph study stays research evidence, not a synthetic acceptance claim.

### Phase 6: execution policy and source-labelled usage

- Scope: independently reviewable #266 source slices and #285 usage/budget surfaces.
- Read docs/agent-notes/adapters.md, budget.md, models.md and benchmarks.md, routing.ts, research.ts and existing ACP occupancy/wire boundaries.
- Policy slice A: source/version capability table for model and effort (launch/turn/none/unknown), then bounded per-task/role exec identity with planned/actual records. Unsupported changes refuse or remain visibly unavailable.
- Policy slice B: trusted policy configuration through the same assign decision as explain; planner overrides only inside the allowed set with a reason; no permission/sandbox changes.
- Policy slice C: bounded escalation ladder and reviewer risk rules, at most max_steps, unsupported steps recorded and ceiling sent to the person. No performance recommendation is auto-applied.
- Usage slice A: owned Kimi session wire reader with offsets/rotation/truncation/schema/index fences and sub-agent attribution. Read only usage.record fields; never retain prompt/tool bodies, paths or session ids in public events.
- Usage slice B: cache-excluded count-window function, fake-clock reset/pause/handoff, native/manual precedence and kind/source/age across budget/status/console/dashboard/doctor. Occupancy never becomes consumption.
- Usage slice C: optional OAuth quota probe stays off pending the original exact authorization; no tracked token or inferred credential use. Probe failure remains unknown.
- Verify unknown native cells, pure policy/explain equivalence, PII on-prem restriction, no policy-to-permission coupling, wire rotation/shrink/truncation markers, cache ceiling and old-client behavior.
- Exit: source policy and usage proved. #266 matrix/Pareto/recommendation quality and native small matrix remain research gates. #285 live source timing/provider quota remain #273 receipts.

### Phase 7: remaining native adapter and watch follow-ups

- Scope: #286 and #332; #256 native obligations live in #273 after implementation closure.
- Reuse the shipped watch ring/console-only side channel and Qwen/jcode identity fences. Read docs/verification/2026-10-11-acp-watch-t0.md and 2026-10-11-jcode-peer-contract.md.
- Slice A: fixed-command terminal-provider integration for headless watch and peer-panel shortcut. No caller text, approval or command enters the watch scene.
- Slice B: Qwen dual-output TUI only after real T0 Q2-Q6 proof; fail/unknown retains explicit refusal. Kimi stays its shipped pull-only TUI, not watch-driven TUI control.
- Slice C: jcode-specific PII/marker/native log proof and project MCP tool-call receipt. Preserve foreign project entries, unmanaged policy, default-off roster and owned private daemon/socket.
- Jcode 0.94.0 native session/load does not echo actual restored identity. Do not implement guessed automatic recovery. Wait for a separately proven interface/upstream capability; controlled recovery refuses before effects and manual reopening stays explicit.
- Verify wrong runtime identity, foreign socket/override, stale entry, late native acknowledgement, owned process teardown and no new-conversation-as-restored claim. Native model/tool/stop/readback remains account-gated.
- Exit: independently implementable source fixes merged; real native receipts either recorded or still open in #273/#332/#286. No accounts or live instances are started by this plan.

## Preserved research and measurement sequence

These items keep research labels and remain open. Existing issue-specific go-aheads, preregistration, real-account/resource requirements and study validity rules still apply; this planning request does not satisfy a missing experiment authorization.

| Sequence | Issue and required work | Dependencies / exit evidence |
| --- | --- | --- |
| R1 | #109 calibration and held-out routing-time prediction assessment | Current-version profile and sealed outcomes; no evaluator leakage or rerouting enablement from source alone. Reuse #329 controlled study as its recorded evidence, not proof of unrun criteria. |
| R2 | #45 T1 per-adapter observability/capability declarations | Version-specific tests and actual capability gaps; no exactly-once from snapshots or conversation revert alone. |
| R3 | #41 isolated workspace transactions | R2; supported effect scope/quiescence, durable resolution phases, separate workspace/native rollback readbacks and late-effect fault suite. |
| R4 | #42 executable commitments | R3; five complete preregistered regimes, target-bound validation/certificates and every requested attempt retained. |
| R5 | #43 headroom predictor/regime selection | R4; documented dataset, held-out AUROC and always-solo/always-team comparison. |
| R6 | #44 telemetry quality and trace-replay simulator, then optimizer | Can prepare independently of R3-R5; simulation error first, enough review outcomes, then actual live-week comparison. |
| R7 | #45 remaining lattice/status, protocol/TLA+ model and five-vendor analysis | Composition reflects the limiting member and #41 conditional guarantees. |
| R8 | #8 normal-use overlap measurement and owner decision | Review around 2026-10-14; low usage extends the window. It determines default isolation, not an opt-in #41 prerequisite. |
| R9 | #198 and #199 shipped-system evaluations | Actual authorized local/on-campus screen and mixed load, fixed recall bound 0.90, uncertainty/precision/wait outcomes; defects get follow-up source slices. |
| R10 | #252 gsd-lite, #248 add-ons, #258 memory and #266 model/effort comparisons | Sealed #251/#247 fingerprints, independent arms, failures/unknowns, effect sizes/intervals and inconclusive counts. No native adoption/default policy without data. |

#30 tracks measured targets T1-T6 and stays open. #1 and #273 retain all infrastructure/native legs, including conditions that cannot safely be manufactured. Research measurement may find a regression; preserve the result and create/fix the actual defect rather than adjusting the target or calling unknown zero.

## Verification and completion contract

- Before heavy local work, read host pressure/current jobs and the resource policy, then use dot admission. One heavy job per repo across all worktrees. Exit 75 is a defer; wait or use already-authorized CI, never bypass or kill an unrelated job.
- Every source slice gets focused regression checks appropriate to its contract, typecheck, generated plugin rebuild when imported inputs/version change, full scripts/check.sh ending check: OK, exact-head Linux/macOS CI and sequential seeded guards. Preserve original test assertions; a test failure is repaired in source.
- Gate receipts name full source SHA, run URL, test/guard counts and outcomes. A rerun is an additional attempt, not deletion of the initial failure. Current PR #346's isolated sidecar failure and limited same-head retry remain in its receipt.
- Refresh current-head source review and resolve/answer every actionable thread. Before merge read gh pr view --comments and unresolved threads plus pending changes requested. Quota-skipped review is not evidence.
- After confirmed merge, fast-forward main, verify the merged tree, delete only the owned merged branch/worktree. Preserve any foreign/dirty checkout; do not force-remove it.
- Issue closure requires every original acceptance criterion completed, or its explicitly allowed unverified disposition. Transfer an implementation issue's still-owed native leg to a named open survivor before closing, with exact criteria and no loss of scope. Research issues are retained under the owner's instruction.
- A full release, installation, live hub activation and paid/account experiments are outside this audit. When separately authorized, use release merge commits, fresh/ancestor doc stamps, exact tag and actual installation/runtime readback. Never label code/CI as native success.
- Re-read all remaining issue states after each phase; update #324 and the canonical claude-mem work state with completed source, open research/native criteria and the next independent slice.

## Immediate next actions

- Finish #346's 133-guard exact-head gate and fresh review readback; merge/clean only if all required checks pass.
- Implement #259 glob policy/Claude-grant slice, then #257 custom lifecycle and release-readiness slices.
- Proceed through board/roles, attention/office, memory and policy/usage phases in dependency order.
- Keep all research-labelled items open, and record native prerequisites as unknown rather than manufacturing live conditions.
