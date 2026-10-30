# Operational settings deferred decisions

Decision table for issue #489, task #566, with the final planner disposition recorded below. Docs only, no code/config/constant changes. The original table was sent to the planner before any new issue, conversion card or PR. Evaluated C01/S01-S04 alternatives are retained for traceability, not scheduled work.

Final deferred-group decision: **all1089 identities stay constant at their current owners and bounds**. No C01 conversion card and no S01-S04 design issue is to be filed. H7 #987 merged as `ba54684ddc9a9925ee98e03bce5efd0090317a15` after green exact-head CI at `8452d254025ca413b74dbf81f53cdcdf0d9e5c7f`; the closure PR may now complete #489, subject to its own review and CI.

## Provenance and reconciliation

Source/code audit: approved H7 commit `6bae3153ae5ed4fb127bb38e0fb89f584221d21a` (includes H1-H6 and merged C1). H0 identities remain from `scripts/inventory-hardcoded-values.classifications.json` and `docs/verification/2026-10-24-hardcoded-values.md`, with `scripts/inventory-hardcoded-values.ts` as the committed H0 generator. The historical H4 ledger says its generator was not committed; this task separately verifies that the committed H0 generator exists. It does not claim an H4 rendering generator was committed.

The ruling read from hub memory `mem:3dc367aa93ec5d74255e0fc387f55154` is retained: person-visible waits are raise-only at shipped minima; internal polling/batching may move within justified bounds; no new cross-process seam without reported need; split mixed roles before conversion; fixed outer budgets bound maxima rather than being reworked.

The exact requested/adjacent union is **1089 distinct identities**, with no overlap between the source sets:

- H7 outside-path list:926 (471 operational,181 safety floor,242 contract,32 seam), [H7 ledger](2026-10-30-ui-console-operational-settings.md).
- H4 explicit follow-up dispositions:82 across10 files (42 operational,16 safety floor,15 contract,9 seam), [H4 ledger](2026-10-30-recovery-wait-settings.md).
- H3 fence polling deferred to H4:2, already dispositioned keep in H4's handover paragraph, [H3 ledger](2026-10-30-bus-delivery-operational-settings.md).
- H5 explicit follow-ups:18 (14 benchmark operational identities, one review-diff budget, three local-worker context/elision identities), plus2 adjacent ownership exclusions (Pi bridge idle and terminal readiness), [H5 ledger](2026-10-30-adapter-operational-settings.md).
- H6 support files:46 (code-facts29, facts16, execution-budget1), plus13 explicit policy follow-ups (advisor2, route scores9, gateway phases2), [H6 ledger](2026-10-30-model-operational-settings.md).

Without the two explicitly labelled H5-adjacent identities, requested-ledger coverage is1087. These counts include already-resolved contract/safety/seam decisions and are coverage, not an estimate of remaining implementation work. H3's2 are referenced by H4 but are not in its82. H7's additional task-progress initializer belongs to tasks/routing and is not silently recounted here. Previously resolved H3/H5/H6 exclusions remain governed by their ledgers; this table does not reopen every contract merely because its original H0 label said operational.

Each appendix row maps exactly once to one decision group. Existing H0 classes remain provenance. Class-preserving contract/safety/seam decisions reuse the prior H0 audit; operational groups were evaluated by current role/caller, with candidate and coupled-budget source reads. This is a group decision audit, not a claim of a new independent all-line security or runtime verification.

## Planner disposition (2026-10-30)

Claude, planner and reviewer of task #566, approved the table at7039dabb with the following final decisions. The planner read the decision table, C01, S01-S04, AC section and static verification, not each of the1089 appendix rows.

- C01: keep the empty-inbox threshold constant at3. Nobody reported an operator need, and3 is part of the advisory protocol (old clients accept count>=3). The technically possible3..64 range is not a reason to add a tunable. This is a policy decision, not a conversion.
- S01-S04: file no design issues. Keep all four groups constant until a need is reported. Reopen a group only as its own issue with that concrete need; do not add speculative configuration or a cross-process seam.
- K01-K18: retain the classifications and reasons already in the table (only the used K group identifiers appear).
- Every deferred group is resolved. Final totals are1089 keep constant,0 conversions and0 design-issue filings. C/S group IDs remain solely to connect the evaluated alternatives to their membership.
- After H7 #987 merges with green exact-head CI, rebase this docs branch onto main and open the closure PR with `Fixes #489`. File no C01 card and no S issue. No implementation constant changes are authorized here.

## Consolidated decision table

Counts refer to the membership appendix, not repeated markdown display rows. Keep classes describe why no additional H1 setting is proposed; an existing configurable default may remain a constant without removing its current override.

| Group | Identities | Decision | Reason class | Source role, evidence and action |
| --- | ---: | --- | --- | --- |
| C01: Empty-inbox advisory count | 1 | Keep constant (planner) | contract / advisory policy | Keep3: no reported operator need; old clients accept counts>=3. The evaluated3..64 technical range below is not adopted. Evaluated but not adopted: inbox_polling.empty_read_threshold, integer3..64, default3, restart/capture. The client rejects counts below3 (claude-channel.ts:435); the read buffer caps64 (inbox-polling.ts:17-20). Advice runs after a successful pull (daemon.ts:7449-7462) and never refuses it. No new protocol or projection. |
| K01: Formats, identifiers, schemas and derived arithmetic | 302 | Keep constant | contract | Retain reviewed H0 contract rows and explicit representation operations: protocol16, port layout/Atomics indices, JSON/role positions, hash widths, saturating zero/unit conversions, UTC days and reporting/layout widths. Operational-labelled research padStart10/projectKey16, registry id24 and CLI output tuple0/1 are not independent thresholds. H0 coordinates remain provenance, not live line claims. |
| K02: Untrusted-input, privacy, resource and proof ceilings | 290 | Keep constant | safety floor | Keep parser/diagnostic/text/path/role/instance caps, native ownership record limits and bounded proof caches. Includes profile roles, atomic config edit16 sets/5 backups and bounded backup listing, transient activity rendering and withdrawn/retained evidence. No row may make these loosenable; changing correlated retention/proof semantics is not a latency conversion. See action/path policy, config-edit.ts:22-25, activity.ts:4-36 and claude-launch-proof bounded decoder. |
| K03: Existing constructor/helper injection points | 42 | Keep constant | test seam | Retain every deferred H0 test seam and actual existing helper injection, including ProgressDeps.ttlMs. Do not add a second setting or per-call override merely because an injectable fallback is a number. Existing callers and tests retain their present bounds. |
| K04: Benchmark, smoke and controlled-study values | 104 | Keep constant | benchmark-only | Study sizes, deadlines, batching, fixture quiet windows and benchmark statistics belong to declared suites/manual probes, including native-pi-qwen, smoke scripts and bench coordination. They do not become production hub policy; moving a study bound requires its reproducible study/proof process, not project config. |
| K05: H4 package, terminal, lifecycle and global-manager waits | 35 | Keep constant | outer budget | Keep the already-scoped H4 runtime waits: package command60s/read30s/install180s roles and hard-kill grace; terminal600s/command30s/exit5s/map1s; lifecycle start12s/shutdown15s/stopped10s; manager global3s/readiness8s/forward10s/start35s; lock/contention and snapshot budgets. Several are already helper seams. Raising inner waits needs coordinated outer budgets; shortening person-visible waits is forbidden. 82 H4 identities are still accounted for across this table, including their separately classified contracts/safety/seams and global progress notices. |
| K06: H3 recovery fence polling handed to H4 | 2 | Keep constant | outer budget | These2 are already dispositioned by H4, not unresolved new work: bus.fenceRecovery has an existing5s seam and1ms initial/50ms capped exponential polling. Preserve its hold/queue rollback and fixed recurrence; no new tuning demand or independent wait exists. |
| K07: Native/control/SQLite/probe and command deadline guards | 56 | Keep constant | outer budget | Keep project bootstrap/native probes, setup/launch RPCs, permission/attachment/lease guards, DB contention bounds and the4s gateway phases. A gateway base may take two4s rounds under the fixed8s PII screen; bridge idle60s covers25s command long-poll. SQLite waits must not multiply through retries. H1 does not rework the caller clock or global command owner. |
| K08: Host facts, bounded reads and completeness-sensitive evidence | 96 | Keep constant | safety floor / outer budget | Keep the46 H6 host-support identities and bounded spec/GitHub/dogfood/diff/cost evidence readers. Examples: code-facts4096 files/256 symbols/5s native ceiling; facts2s racy timestamp window and4/16MiB hash budgets; dogfood read counts/deadlines return incomplete/unknown; Kimi1s floor slack/16 passes protect native usage attribution. Widening or lowering these independently can change coverage, authority or completeness rather than only runtime cost. |
| K09: CI, seed and repository-verification budgets | 11 | Keep constant | outer budget / contract | CI admission/read caps, check/hang/seed watchdogs, citation/docs/parity checks and agent-compat workflow reads belong to verification invocation/workflow policy. A candidate project config must not tune the gate that verifies it. Existing documented CLI/env test seams remain unchanged; no new env knob is proposed. |
| K10: Cohort integration and lost-answer acknowledgement | 3 | Keep constant | contract | Keep MAX_REQUESTS3, RETRY_MS2000 and pair-cardinality2. Tasks checks retry status before acknowledging the facts offer (tasks.ts:4826-4834). A shorter guard can turn a lost-answer retry into confirmation; a smaller/live request cap permits earlier unresolved+done while another owner remains active (cohorts.ts:248-285). No source-supported raised cap exists; any requested policy change needs a separate coordination-proof spec, not H1 now. |
| K11: Already-configurable defaults and accepted API/unit contracts | 41 | Keep constant | contract (existing configuration/interface) | Defaults and unit conversions already follow accepted budget/context/memory/queue/check/task/model configuration or existing command/read-limit APIs. Preserve those keys, defaults, schema clamps and apply boundaries; do not create parallel controls. This verdict does not remove their existing configurability. Examples are config.memory.sync_interval_min/short_ttl_days, config.checks.timeout_s and task WIP/release settings. |
| K12: Quota reset, native-window and hysteresis policy | 5 | Keep constant | safety floor | Keep reset drop0.5, hysteresis0.1,15min jitter and300min/5h fallback/window interpretation. These decide whether native evidence permits pause/resume/reset, not just when a display refreshes. Existing configurable quota/staleness leaves stay at their current owner; unknown must never become zero or fresh by tuning these policy constants. |
| K14: Owned check-runner isolation, command and lease mechanics | 25 | Keep constant | test seam / safety floor / outer budget | RunnerOptions explicitly calls timeoutMs/lockWaitMs/lockPollMs/schedule test seams, never tool/config inputs (check-runner.ts:42-46). Keep the600000ms child ceiling, existing15s command budgets,30min lock wait/10s polling, minute cleanup and source/output/file/volume bounds. Resource/admission ownership must remain one lifecycle; no generic project control is added to a global/remote mechanic. |
| K15: Usage ingestion/completion/read coverage | 18 | Keep constant | safety floor / contract / test seam | Keep usage completion1200ms/40ms polling under its existing helper seam; transcript scan/input bounds; rollup8MiB pass and4MiB line ceilings/20ms clamp. LIMITS_DEFAULT200/MAX5000 are the existing limits read API with total/shown/truncated/omitted metadata. UTC/index/arithmetic literals remain representations. A new retention or deadline knob must not make partial usage look complete. |
| K16: Bounded memory/project projection frontiers | 13 | Keep constant | safety floor / contract / test seam | Keep MemoryClient exact-project paging256*16=4096, explicit truncated coverage, search30 cap, curated context30, UI rows50/graph200 and token/text framing; keep optional symbol start2s and stale-scan page64. They couple complete screened rows, page cursors, privacy gates and model context, not independent service timers. Existing read-limit/capture seams and configured injection budgets remain authoritative. |
| K18: Published physical model context/output defaults | 6 | Keep constant | contract | Keep8192/2048/context declarations and their fixed output ceilings where published to Pi. Existing mlx/routing declarations already own selectable physical budgets; changing capability claims requires model/context evidence and routing promotion, not a second operational alias. |
| S01: Native terminal readiness heuristic | 1 | Keep constant until a need is reported | planner policy: no reported need | No issue now; reopen only with a concrete need. terminal-open.ts SETTLE_MS1500 is a documented readiness heuristic (terminal-open.ts:14-16/52). Decide provider/handle readiness proof and bounded failure behavior first. A larger arbitrary settle setting is not proof and no safe new maximum is established. |
| S02: Calibrated route/progress state and score policy | 15 | Keep constant until a need is reported | planner policy: no reported need | No issue now; reopen only with a concrete need. Keep present values pending a routing/progress policy study: severity0.3/0.7/1, window3, stall depth8/gain5/unit0.1, advisor1024-entry state and progress observation28/text500/state256/turn minimum2. These affect judge inputs, routing or escalation meaning. Use the existing model-routing corpus/live receipt and eviction/privacy proof before defining any new schema bounds. |
| S03: Daemon sampling, settlement retry and maintenance cadence | 12 | Keep constant until a need is reported | planner policy: no reported need | No issue now; reopen only with a concrete need. The12 identities include1s context observation,2s transcript usage,5/10/30/60s maintenance, startup sync5s, settlement retry30s and a frozen100ms helper interval. Identify each current owner (some H0 closures have moved), detection-latency guarantees and caller budgets before choosing separate knobs. Do not expose one global timer setting or invent maxima; lease/native evidence/unknown-state behavior must be preserved. |
| S04: Native-window and multi-project progress presentation ownership | 11 | Keep constant until a need is reported | planner policy: no reported need | No issue now; reopen only with a concrete need. The9 native pet-window/JXA timers and2 recovery follow-progress60s notices are not project-daemon waits. Define whether policy belongs to the initiating operation, selected project or device/window owner and establish a reported need before any cross-process projection. Keep all current4/5s readiness/close and redraw/poll behavior until then; layout fields remain K01. |

Final decision totals: **1089 keep constant,0 convert,0 separate-issue filings**. The original evaluated grouping was1 C01 candidate,1049 K-group keeps and39 S-group candidates; the planner disposition resolves the latter40 without adding tunables or issues. No identity is an unexplained outside-path deferral.

## Evaluated conversion option, not scheduled

### C01: empty-inbox advisory threshold (rejected as unnecessary)

- Historical owner/class proposal: codex/implement after H7. Planner disposition: no card; keep threshold3.
- Scope: `src/hub/inbox-polling.ts`, `src/hub/daemon.ts`, H1 metadata/schema/settings/docs and focused/config tests. No new RPC, file, env variable or client projection.
- Row: `inbox_polling.empty_read_threshold`, integer3..64, default3, applies `restart`. Capture accepted value when `new InboxPolling` is constructed; do not retime/renotice a current streak.
- Source-supported bounds: [client accepts count>=3](https://github.com/STAIxBWLB/agent-hub/blob/6bae3153ae5ed4fb127bb38e0fb89f584221d21a/src/adapters/claude-channel.ts#L435); [buffer stores at most64 reads and threshold currently3](https://github.com/STAIxBWLB/agent-hub/blob/6bae3153ae5ed4fb127bb38e0fb89f584221d21a/src/hub/inbox-polling.ts#L17). A value below3 is rejected by an unchanged old client and can consume the notice latch invisibly; a value above64 is unreachable. The minimum is therefore3, not1.
- Preserve the10min window,64-entry bound, assigned/nonempty/backward-clock/lapse resets, notice-once latch and unchanged count/minutes payload. [Advice follows successful bus.pull](https://github.com/STAIxBWLB/agent-hub/blob/6bae3153ae5ed4fb127bb38e0fb89f584221d21a/src/hub/daemon.ts#L7449), and advice failure cannot refuse or discard a read. No routing, PII, queue, native or conductor authority.
- Proof: independent default pin3 and H0 mapping; schema/UI/apply bounds; threshold3/64 reachability in one window; all resets/latch; immutable active snapshot; failed/held pulls never counted; old-client payload acceptance unchanged; inherit/undo and restart adoption. Search seeds before edits; affected guard checks and exact-head changed/CI evidence as H1-H7. No new per-call override.
- If the planner elects to keep this advisory policy at3 instead, record that explicit protocol/policy decision. It is the only technically clean remaining conversion proposed here, not an implementation already approved by this document.

## Evaluated separate-design options, not filed or scheduled

### S01: Prove native terminal readiness before delay tuning

- Proposed owner: native terminal/recovery planner, design then implementation if needed.
- Question: replace or justify the1500ms settle heuristic using provider/handle/generation readiness; preserve refusal on unknown or late mapping.
- AC: concrete reported readiness case; current caller timeline; provider proof port/fallback; no duplicate terminal; owned cancellation; no arbitrary H1 settle maximum. Keep current constant during design.

### S02: Model-route and progress policy parameter study

- Proposed owner: model-routing/progress planner, using the frozen model-routing corpus and live judge receipt when required.
- Question: which score/history/state-eviction values are genuine operator policy rather than calibrated algorithm or bounded prompt semantics?
- AC: preserve0.3/0.7/1 scale agreement, full conversation/no trim rules, private-turn screening, session/generation fences and prompt budget; evidence for eviction/score change; propose per-role bounds only after study. Existing values stay fixed meanwhile.

### S03: Daemon sampling and maintenance cadence contract

- Proposed owner: daemon/budget/recovery planner.
- Question: define detection/resume/settlement latency and exact current owner for each listed loop before selecting H1 keys. Do not unify the two30s loops merely because their numbers match.
- AC: map H0 closures that moved; timestamp-based staleness remains honest; no changed admission/privacy/ownership; running deadlines untouched; quiescence and shutdown ordering; measured cost and source-justified min/max per proposed row. No new client/status projection without need.

### S04: Non-project presentation timing ownership

- Proposed owner: native UI and recovery presentation planner.
- Question: identify the initiating-operation/project/device owner for pet-window/JXA cadence and global recovery progress notices before any configuration path exists.
- AC: reported operator need; selected-project/instance/privacy fences; existing positive action consent; native readiness/close outer budgets; no invented project-to-global knob or new file/env seam. A60s progress notice is not a60s recovery completion timeout.

These four evaluated alternatives are not filed or scheduled. The planner chose to keep all four groups constant because no operator need was reported. Any future reopening must carry that need as its own issue; the alternatives authorize no code change or new seam.

## AC1-AC5 and closure disposition

- AC1: H0 and generator/classification artifacts are committed in [PR #764](https://github.com/STAIxBWLB/agent-hub/pull/764). This document reconciles the deferred union, not a new inventory run against every post-H0 constant.
- AC2: H1 mechanism [#966](https://github.com/STAIxBWLB/agent-hub/pull/966), H2 [#970](https://github.com/STAIxBWLB/agent-hub/pull/970), H3 [#975](https://github.com/STAIxBWLB/agent-hub/pull/975), H4 [#979](https://github.com/STAIxBWLB/agent-hub/pull/979), H5 [#982](https://github.com/STAIxBWLB/agent-hub/pull/982) and H6 [#984](https://github.com/STAIxBWLB/agent-hub/pull/984) are merged at the readback. H7 [#987](https://github.com/STAIxBWLB/agent-hub/pull/987) merged as `ba54684ddc9a9925ee98e03bce5efd0090317a15` at final head `8452d254025ca413b74dbf81f53cdcdf0d9e5c7f`; C01 was rejected as an unnecessary tunable. No conversion is left pending by this table.
- AC3: keep existing safety floors and tighten-only conversions. This table introduces no configurable bound and makes no floor loosenable. C01 remains a protocol constant at3; its evaluated setting is not scheduled.
- AC4: retain contract constants, layouts and proof guards. No source, schema, protocol, generated bundle or seed anchor changes in this task. H7's narrowly approved startup-read test contract is already documented in its PR, not concealed as a seed edit.
- AC5: do not infer a green exact-head CI from merged state alone. Prior reviewer/PR evidence is at the linked implementation heads; H7's owner reported focused210pass, changed3216pass/30skip/0fail and affected-seed shards57/64+58/64. This planning task runs no suite, benchmark, native/account test or CI poll. A one-time post-merge readback of [H7 CI run 41069734330](https://github.com/STAIxBWLB/agent-hub/actions/runs/41069734330) confirms successful `check (ubuntu-latest)`, all four macOS shards and their aggregator, and all four seeded guards and their aggregator at final head `8452d254025ca413b74dbf81f53cdcdf0d9e5c7f`. This is hosted proof, separate from the owner's local checks. The closure PR's review and CI remain pending; no C01 implementation is required by the final policy.

**Outcome: all deferred decisions are resolved and H7 merged with green exact-head CI; the docs PR can close #489 after its own review and CI.** No C01 card or S issue is to be filed. The implementation/release evidence remains at the linked H0-H7 PRs; no new source, test or native execution is claimed by this planning document.

## Static verification

- Deferred-set membership:1089 unique manifest identities, no missing/extra/duplicate member or H0 class change; exact source sets926/82/2/18/2/46/13. All groups have a decision and the table totals reconcile; C/S membership prefixes identify historical evaluated groups, while all final decisions are keep constant.
- `git diff --check`: passed. Only this new documentation file is delivered; no source/config/seed/generated file changes.
- `node scripts/check-docs.mjs`: passed (`docs: OK`,15 permitted stale documents); no document stamp was rewritten.
- Independent group/docs review of the7039dabb draft found no concrete finding and separately reconciled membership/counts/C01 technical bounds. The final disposition is the planner's subsequent policy decision. It is not an independent re-audit of the reviewer's own H4 source analysis or an all-line security/runtime/CI audit.
- No unit/integration suite, benchmark, build, install, native/account action, CI poll, issue, conversion card or PR filing in this planning phase.

## Identity membership appendix

`origin` is the exact ledger set above; decision semantics are in the single consolidated table. IDs preserve escaped pipes from the frozen manifest. Source file names are inside each stable ID, and frozen coordinates/reasons remain in the linked original ledger.

| Stable H0 identity | H0 class | Origin | Decision group |
| --- | --- | --- | --- |
| `scripts/agent-compat-step.sh:shell:inline:head=1#0` | contract | H7-outside | K01 |
| `scripts/agent-compat-watch.ts:<module>:inline:new Date().toISOString().slice=10#0` | contract | H7-outside | K01 |
| `scripts/agent-compat-watch.ts:signal:inline:AbortSignal.timeout=15_000#0` | operational | H7-outside | K09 |
| `scripts/amem/baseline.ts:<anonymous>:inline:new Date(DAY_START + i * DAY_MS).toISOString().slice=10#0` | contract | H7-outside | K01 |
| `scripts/amem/baseline.ts:DAY_MS:constant:DAY_MS=86400000#0` | contract | H7-outside | K01 |
| `scripts/amem/baseline.ts:days:inline:days=14#0` | contract | H7-outside | K01 |
| `scripts/amem/baseline.ts:max:inline:max=13#0` | contract | H7-outside | K01 |
| `scripts/amem/baseline.ts:min:inline:min=0#0` | contract | H7-outside | K01 |
| `scripts/amem/scale-bench.ts:limit:inline:limit=50#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/evaluate.py:create_sandbox:inline:timeout=180#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/evaluate.py:main:inline:len=2#0` | contract | H7-outside | K01 |
| `scripts/benchmarks/evaluate.py:main:inline:len=7#0` | contract | H7-outside | K01 |
| `scripts/benchmarks/ledger.py:final_text:inline:slice=200#0` | safety floor | H7-outside | K02 |
| `scripts/benchmarks/native-pi-qwen.ts:ACTIVE_TRACE_CAP:constant:ACTIVE_TRACE_CAP=4096#0` | operational | H5-followup | K04 |
| `scripts/benchmarks/native-pi-qwen.ts:activeExit:inline:state.quietMs >= 1000=1000#0` | operational | H5-followup | K04 |
| `scripts/benchmarks/native-pi-qwen.ts:arm:inline:Bun.sleep=100#0` | operational | H5-followup | K04 |
| `scripts/benchmarks/native-pi-qwen.ts:arm:inline:Bun.sleep=100#1` | operational | H5-followup | K04 |
| `scripts/benchmarks/native-pi-qwen.ts:arm:inline:Bun.sleep=25#0` | operational | H5-followup | K04 |
| `scripts/benchmarks/native-pi-qwen.ts:batchMs:inline:batchMs=0#0` | operational | H5-followup | K04 |
| `scripts/benchmarks/native-pi-qwen.ts:contextWindow:inline:contextWindow=262144#0` | operational | H5-followup | K04 |
| `scripts/benchmarks/native-pi-qwen.ts:maxTokens:inline:maxTokens=4096#0` | operational | H5-followup | K04 |
| `scripts/benchmarks/native-pi-qwen.ts:max_tokens:inline:max_tokens=20#0` | operational | H5-followup | K04 |
| `scripts/benchmarks/native-pi-qwen.ts:observe:inline:this.calls.size > 128=128#0` | operational | H5-followup | K04 |
| `scripts/benchmarks/native-pi-qwen.ts:onUsageDiagnostic:inline:qwenUsageDiagnostics.length < 32=32#0` | operational | H5-followup | K04 |
| `scripts/benchmarks/native-pi-qwen.ts:signal:inline:AbortSignal.timeout=30_000#0` | operational | H5-followup | K04 |
| `scripts/benchmarks/native-pi-qwen.ts:watchdogMs:inline:watchdogMs=300_000#0` | operational | H5-followup | K04 |
| `scripts/benchmarks/native-pi-qwen.ts:watchdogMs:inline:watchdogMs=300_000#1` | operational | H5-followup | K04 |
| `scripts/benchmarks/native.ts:<anonymous>:inline:String(e).slice=200#0` | safety floor | H7-outside | K02 |
| `scripts/benchmarks/native.ts:<anonymous>:inline:String(e).slice=200#1` | safety floor | H7-outside | K02 |
| `scripts/benchmarks/native.ts:<anonymous>:inline:i.toString().padStart=2#0` | contract | H7-outside | K01 |
| `scripts/benchmarks/native.ts:<anonymous>:inline:out.trim().slice=200#0` | safety floor | H7-outside | K02 |
| `scripts/benchmarks/native.ts:arm:inline:Bun.sleep=300#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/native.ts:arm:inline:Date.now() - settled > 5000=5000#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/native.ts:arm:inline:String(e).slice=200#0` | safety floor | H7-outside | K02 |
| `scripts/benchmarks/native.ts:arm:inline:String(e).slice=200#1` | safety floor | H7-outside | K02 |
| `scripts/benchmarks/native.ts:arm:inline:String(e).slice=200#2` | safety floor | H7-outside | K02 |
| `scripts/benchmarks/native.ts:batch_max:inline:batch_max=1#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/native.ts:batch_ms:inline:batch_ms=0#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/native.ts:boundMs:inline:Math.min=30000#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/native.ts:boundMs:inline:Math.min=300000#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/native.ts:bytes:inline:regularBytes=16 * 1024 * 1024#0` | safety floor | H7-outside | K02 |
| `scripts/benchmarks/native.ts:bytes:inline:regularBytes=16 * 1024 * 1024#1` | safety floor | H7-outside | K02 |
| `scripts/benchmarks/native.ts:cmd:inline:detail.slice=350#0` | safety floor | H7-outside | K02 |
| `scripts/benchmarks/native.ts:cmd:inline:timeoutMs=180_000#0` | test seam | H7-outside | K03 |
| `scripts/benchmarks/native.ts:error:inline:String(error).replace(/(token\|secret\|api[_-]?key)(\s*[:=]\s*)[^\s,;]+/ig, $1$2[redacted]).slice=300#0` | safety floor | H7-outside | K02 |
| `scripts/benchmarks/native.ts:poll_min:inline:poll_min=1#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/native.ts:refreshInterval:inline:refreshInterval=1#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/native.ts:release_after_min:inline:release_after_min=0#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/native.ts:removeTemp:inline:String(e).slice=200#0` | safety floor | H7-outside | K02 |
| `scripts/benchmarks/native.ts:stopped:inline:Date.now() - waitCaptureAt >= 5000=5000#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/native.ts:timer:inline:setTimeout=30000#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/native.ts:timer:inline:setTimeout=60000#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/native.ts:wait:inline:Bun.sleep=250#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/native.ts:wait:inline:ms=90000#0` | test seam | H7-outside | K03 |
| `scripts/benchmarks/native.ts:waitClaudeTui:inline:Bun.sleep=250#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/native.ts:watchdog_ms:inline:watchdog_ms=360000#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/peer-bus-mcp.py:<module>:inline:slice=4000#0` | safety floor | H7-outside | K02 |
| `scripts/benchmarks/peer-bus-mcp.py:<module>:inline:timeout=5#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/probe-qwen-usage.ts:deadline:inline:deadline=65_000#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/probe-qwen-usage.ts:main:inline:Bun.sleep=50#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/probe-qwen-usage.ts:onUsageDiagnostic:inline:observations.length < 32=32#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/probe-qwen-usage.ts:timeoutMs:inline:timeoutMs=15_000#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/probe-qwen-usage.ts:watchdogMs:inline:watchdogMs=60_000#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/runner.py:actor_ok:inline:slice=5#0` | safety floor | H7-outside | K02 |
| `scripts/benchmarks/runner.py:actor_usage:inline:len=2#0` | contract | H7-outside | K01 |
| `scripts/benchmarks/runner.py:teardown_failure:inline:slice=300#0` | safety floor | H7-outside | K02 |
| `scripts/benchmarks/runner.py:teardown_failure:inline:slice=300#1` | safety floor | H7-outside | K02 |
| `scripts/benchmarks/runner.py:v3_observability:inline:len=3#0` | contract | H7-outside | K01 |
| `scripts/benchmarks/runner.py:validate_manifest:inline:len=2#0` | contract | H7-outside | K01 |
| `scripts/benchmarks/study_audit.py:_coverage_read:inline:limit=4 * 1024 * 1024#0` | test seam | H7-outside | K03 |
| `scripts/benchmarks/study_audit.py:native_fixture_binding:inline:len=1#0` | contract | H7-outside | K01 |
| `scripts/benchmarks/study_audit.py:pins:inline:len=2#0` | contract | H7-outside | K01 |
| `scripts/benchmarks/study_audit.py:source_provenance:inline:len=2#0` | contract | H7-outside | K01 |
| `scripts/benchmarks/study_audit.py:source_provenance:inline:len=3#0` | contract | H7-outside | K01 |
| `scripts/benchmarks/study_audit.py:source_provenance:inline:len=64#0` | safety floor | H7-outside | K02 |
| `scripts/benchmarks/study_audit.py:source_provenance:inline:timeout=30#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/study_audit.py:source_provenance:inline:timeout=30#1` | operational | H7-outside | K04 |
| `scripts/benchmarks/study_supervisor.py:CANCEL_SETTLE_S:constant:CANCEL_SETTLE_S=900.0#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/study_supervisor.py:FALLBACK_SETTLE_S:constant:FALLBACK_SETTLE_S=10.0#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/study_supervisor.py:PROGRESS_INTERVAL_S:constant:PROGRESS_INTERVAL_S=15.0#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/study_supervisor.py:RECOVERY_TIMEOUT_S:constant:RECOVERY_TIMEOUT_S=300.0#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/study_supervisor.py:STALE_AFTER_S:constant:STALE_AFTER_S=120.0#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/study_supervisor.py:main:inline:slice=1#0` | contract | H7-outside | K01 |
| `scripts/benchmarks/study_supervisor.py:ps_fields:inline:timeout=5#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/study_supervisor.py:read_command:inline:timeout=60#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/study_supervisor.py:spawn:inline:timeout=5#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/study_supervisor.py:wait_bounded:inline:timeout=0.2#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/teardown.ts:bytes:inline:regularBytes=256 * 1024#0` | safety floor | H7-outside | K02 |
| `scripts/benchmarks/teardown.ts:claudeUsageSnapshot:inline:Math.min=25#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/teardown.ts:claudeUsageSnapshot:inline:boundMs=1500#0` | test seam | H7-outside | K03 |
| `scripts/benchmarks/teardown.ts:fallbackMs:inline:fallbackMs=4_000#0` | test seam | H7-outside | K03 |
| `scripts/benchmarks/teardown.ts:resetsMs:inline:resets < 1e12=1e12#0` | contract | H7-outside | K01 |
| `scripts/benchmarks/teardown.ts:resetsMs:inline:resetsMs=1000#0` | contract | H7-outside | K01 |
| `scripts/benchmarks/teardown.ts:settleMs:inline:settleMs=10_000#0` | test seam | H7-outside | K03 |
| `scripts/benchmarks/teardown.ts:teardown:inline:settleFor=bounds.fallbackMs / 2#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/teardown.ts:teardown:inline:settleFor=bounds.fallbackMs / 2#1` | operational | H7-outside | K04 |
| `scripts/benchmarks/teardown.ts:timeout:inline:timeout=10_000#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/teardown.ts:timeout:inline:timeout=20_000#0` | operational | H7-outside | K04 |
| `scripts/benchmarks/teardown.ts:timeout:inline:timeout=5_000#0` | operational | H7-outside | K04 |
| `scripts/check-citations.ts:<module>:inline:statSync(bibliography).size > 4 * 1024 * 1024=4 * 1024 * 1024#0` | safety floor | H7-outside | K02 |
| `scripts/check-citations.ts:<module>:inline:statSync(document).size > 256 * 1024=256 * 1024#0` | safety floor | H7-outside | K02 |
| `scripts/check-docs.mjs:dirtiness:inline:entries.length > 4096=4096#0` | safety floor | H7-outside | K02 |
| `scripts/check-docs.mjs:dirtiness:inline:info.size > 4 * 1024 * 1024=4 * 1024 * 1024#0` | safety floor | H7-outside | K02 |
| `scripts/check-docs.mjs:timeout:inline:timeout=2000#0` | operational | H7-outside | K09 |
| `scripts/check-memory-consumer-parity.ts:timeout:inline:timeout=15_000#0` | operational | H7-outside | K09 |
| `scripts/check-roles.ts:<module>:inline:file.slice=-3#0` | contract | H7-outside | K01 |
| `scripts/check.sh:shell:inline:AHUB_CHECK_HANG_S=960#0` | test seam | H7-outside | K03 |
| `scripts/check.sh:shell:inline:AHUB_CHECK_LOCK_WAIT_S=1800#0` | test seam | H7-outside | K03 |
| `scripts/check.sh:shell:inline:bun test --timeout=20000#0` | operational | H7-outside | K09 |
| `scripts/check.sh:shell:inline:sleep=5#0` | operational | H7-outside | K09 |
| `scripts/ci-gates.mjs:page:inline:value[key].length > 100=100#0` | contract | H7-outside | K01 |
| `scripts/ci-reuse.mjs:deadline:inline:deadline=60_000#0` | operational | H7-outside | K09 |
| `scripts/hang-watch.sh:shell:inline:head=120#0` | safety floor | H7-outside | K02 |
| `scripts/hang-watch.sh:shell:inline:sample=3#0` | operational | H7-outside | K09 |
| `scripts/hang-watch.sh:shell:inline:sleep=1#0` | operational | H7-outside | K09 |
| `scripts/hang-watch.sh:shell:inline:sleep=1#1` | operational | H7-outside | K09 |
| `scripts/hang-watch.sh:shell:inline:termination attempts=10#0` | operational | H7-outside | K09 |
| `scripts/overlaps.ts:d:inline:iso.slice=10#0` | contract | H7-outside | K01 |
| `scripts/overlaps.ts:weekOf:inline:d.toISOString().slice=10#0` | contract | H7-outside | K01 |
| `scripts/pii-screen-eval.ts:RECALL_BOUND:constant:RECALL_BOUND=0.9#0` | operational | H7-outside | K04 |
| `scripts/pii-screen-eval.ts:max:inline:ms.at=-1#0` | contract | H7-outside | K01 |
| `scripts/pii-screen-eval.ts:report:inline:new Date().toISOString().slice=10#0` | contract | H7-outside | K01 |
| `scripts/seeded-check.ts:boundedOutput:inline:output.length > 2_000_000=2_000_000#0` | safety floor | H7-outside | K02 |
| `scripts/seeded-check.ts:boundedOutput:inline:output.slice=2_000_000#0` | safety floor | H7-outside | K02 |
| `scripts/seeded-check.ts:shardSeeds:inline:count > 64=64#0` | safety floor | H7-outside | K02 |
| `scripts/seeded-check.ts:timer:inline:setTimeout=70_000#0` | operational | H7-outside | K09 |
| `scripts/smoke-acp.ts:<module>:inline:setTimeout=120_000#0` | operational | H7-outside | K04 |
| `scripts/smoke-codex-hub.ts:<anonymous>:inline:JSON.stringify(m.params).slice=140#0` | safety floor | H7-outside | K02 |
| `scripts/smoke-codex-hub.ts:<anonymous>:inline:m.line.slice=160#0` | safety floor | H7-outside | K02 |
| `scripts/smoke-codex-hub.ts:<module>:inline:Bun.sleep=100#0` | operational | H7-outside | K04 |
| `scripts/smoke-codex-hub.ts:<module>:inline:Bun.sleep=2500#0` | operational | H7-outside | K04 |
| `scripts/smoke-codex-hub.ts:<module>:inline:Bun.sleep=300#0` | operational | H7-outside | K04 |
| `scripts/smoke-codex-hub.ts:<module>:inline:Bun.sleep=6000#0` | operational | H7-outside | K04 |
| `scripts/smoke-codex-hub.ts:<module>:inline:answer.body.trim().split(\n).slice(-2).join( \| ).slice=-120#0` | safety floor | H7-outside | K02 |
| `scripts/smoke-codex-hub.ts:<module>:inline:answer.body.trim().split(\n).slice=-2#0` | operational | H7-outside | K04 |
| `scripts/smoke-codex-hub.ts:<module>:inline:events.find((e) => e.t === envelope && e.env.from === codex).env.body.slice=160#0` | safety floor | H7-outside | K02 |
| `scripts/smoke-codex-hub.ts:until:inline:Bun.sleep=250#0` | operational | H7-outside | K04 |
| `scripts/smoke-codex-hub.ts:until:inline:ms=180_000#0` | test seam | H7-outside | K03 |
| `scripts/smoke-codex.ts:<anonymous>:inline:JSON.stringify(m.params).slice=300#0` | safety floor | H7-outside | K02 |
| `scripts/smoke-codex.ts:<module>:inline:setTimeout=120_000#0` | operational | H7-outside | K04 |
| `scripts/smoke-conductor.ts:<anonymous>:inline:Bun.sleep=250#0` | operational | H7-outside | K04 |
| `scripts/smoke-conductor.ts:<module>:inline:terminalText((error as Error).message).slice=1000#0` | safety floor | H7-outside | K02 |
| `scripts/smoke-conductor.ts:<module>:inline:timeoutSeconds < 60=60#0` | operational | H7-outside | K04 |
| `scripts/smoke-conductor.ts:<module>:inline:timeoutSeconds > 1800=1800#0` | operational | H7-outside | K04 |
| `scripts/smoke-conductor.ts:approval_wait_s:inline:approval_wait_s=5#0` | operational | H7-outside | K04 |
| `scripts/smoke-conductor.ts:claudeNative:inline:statSync(transcript).size > 32 * 1024 * 1024=32 * 1024 * 1024#0` | safety floor | H7-outside | K02 |
| `scripts/smoke-conductor.ts:command:inline:terminalText(err \|\| out).slice=1000#0` | safety floor | H7-outside | K02 |
| `scripts/smoke-conductor.ts:exited:inline:Bun.sleep=3000#0` | operational | H7-outside | K04 |
| `scripts/smoke-conductor.ts:idle_min:inline:idle_min=60#0` | operational | H7-outside | K04 |
| `scripts/smoke-conductor.ts:inputTimer:inline:setInterval=250#0` | operational | H7-outside | K04 |
| `scripts/smoke-conductor.ts:review_min:inline:review_min=60#0` | operational | H7-outside | K04 |
| `scripts/smoke-conductor.ts:timeoutSeconds:inline:option(--timeout-s) ?? 1800=1800#0` | operational | H7-outside | K04 |
| `scripts/smoke-conductor.ts:timeout_s:inline:timeout_s=300#0` | operational | H7-outside | K04 |
| `scripts/smoke-conductor.ts:unaccepted_min:inline:unaccepted_min=60#0` | operational | H7-outside | K04 |
| `scripts/smoke-conductor.ts:until:inline:Bun.sleep=1000#0` | operational | H7-outside | K04 |
| `scripts/smoke-ollama.ts:max_tokens:inline:max_tokens=128#0` | operational | H7-outside | K04 |
| `scripts/smoke-ollama.ts:signal:inline:AbortSignal.timeout=120_000#0` | operational | H7-outside | K04 |
| `scripts/smoke-pi-route.ts:<module>:inline:Bun.sleep=100#0` | operational | H7-outside | K04 |
| `scripts/smoke-pi-route.ts:contextWindow:inline:contextWindow=262144#0` | operational | H7-outside | K04 |
| `scripts/smoke-pi-route.ts:contextWindow:inline:contextWindow=8192#0` | operational | H7-outside | K04 |
| `scripts/smoke-pi-route.ts:contextWindow:inline:contextWindow=8192#1` | operational | H7-outside | K04 |
| `scripts/smoke-pi-route.ts:deadline:inline:deadline=120_000#0` | operational | H7-outside | K04 |
| `scripts/smoke-pi-route.ts:maxTokens:inline:maxTokens=128#0` | operational | H7-outside | K04 |
| `scripts/smoke-pi-route.ts:watchdogMs:inline:watchdogMs=120_000#0` | operational | H7-outside | K04 |
| `scripts/smoke-recovery-09-10.ts:deadline:inline:deadline=15_000#0` | operational | H7-outside | K04 |
| `scripts/smoke-recovery-09-10.ts:deadline:inline:deadline=180_000#0` | operational | H7-outside | K04 |
| `scripts/smoke-recovery-09-10.ts:main:inline:Bun.sleep=250#0` | operational | H7-outside | K04 |
| `scripts/smoke-recovery-09-10.ts:stopOwnedDaemon:inline:Bun.sleep=100#0` | operational | H7-outside | K04 |
| `scripts/smoke-recovery-09-10.ts:timeoutMs:constant:timeoutMs=45000#0` | operational | H7-outside | K04 |
| `scripts/smoke-recovery-09-10.ts:waitForControl:inline:Bun.sleep=100#0` | operational | H7-outside | K04 |
| `src/adapters/claude-print.ts:timeout:inline:timeout=15_000#0` | operational | H5-followup | K07 |
| `src/adapters/local-worker.ts:HISTORY_CHARS:constant:HISTORY_CHARS=100000#0` | operational | H5-followup | K02 |
| `src/adapters/local-worker.ts:TURN_CHARS:constant:TURN_CHARS=120000#0` | operational | H5-followup | K02 |
| `src/adapters/local-worker.ts:elide:inline:(m.content?.length ?? 0) > 200=200#0` | operational | H5-followup | K02 |
| `src/adapters/pi.ts:idleTimeout:inline:idleTimeout=60#0` | operational | H5-adjacent | K07 |
| `src/cli/agents.ts:timeout:inline:timeout=10_000#0` | operational | H7-outside | K07 |
| `src/cli/agy-mcp.ts:MAX_CONFIG_BYTES:constant:MAX_CONFIG_BYTES=256 * 1024#0` | safety floor | H7-outside | K02 |
| `src/cli/agy-mcp.ts:timeout:inline:timeout=3000#0` | operational | H7-outside | K07 |
| `src/cli/agy-mcp.ts:timeout:inline:timeout=5#0` | operational | H7-outside | K07 |
| `src/cli/agy-mcp.ts:validateOptions:inline:value.length > 4096=4096#0` | safety floor | H7-outside | K02 |
| `src/cli/bench.ts:deadline:inline:deadline=started + task.timeout_s * 1000#0` | contract | H7-outside | K01 |
| `src/cli/bench.ts:killMs:inline:killMs=500#0` | operational | H7-outside | K04 |
| `src/cli/bench.ts:metricsOf:inline:opts.pollMs ?? 2000=2000#0` | test seam | H7-outside | K03 |
| `src/cli/bench.ts:metricsOf:inline:opts.pollMs ?? 2000=2000#1` | test seam | H7-outside | K03 |
| `src/cli/bench.ts:reset:inline:paths.length > 5=5#0` | safety floor | H7-outside | K02 |
| `src/cli/bench.ts:reset:inline:paths.slice=5#0` | safety floor | H7-outside | K02 |
| `src/cli/bench.ts:run:inline:new Date(io.now()).toISOString().slice=10#0` | contract | H7-outside | K01 |
| `src/cli/bench.ts:run:inline:randomUUID().slice=8#0` | contract | H7-outside | K01 |
| `src/cli/bench.ts:runAttempt:inline:opts.pollMs ?? 2000=2000#0` | test seam | H7-outside | K03 |
| `src/cli/bench.ts:runBench:inline:commit.slice=12#0` | contract | H7-outside | K01 |
| `src/cli/bench.ts:runBench:inline:commit.slice=12#1` | contract | H7-outside | K01 |
| `src/cli/bench.ts:runBench:inline:commit.slice=12#2` | contract | H7-outside | K01 |
| `src/cli/bench.ts:runBench:inline:now.out.slice=12#0` | contract | H7-outside | K01 |
| `src/cli/bench.ts:setup:inline:opts.setupTimeoutMs ?? 300_000=300_000#0` | operational | H7-outside | K04 |
| `src/cli/bench.ts:sh:inline:Math.max=1#0` | operational | H7-outside | K04 |
| `src/cli/bench.ts:sh:inline:Math.min=200#0` | operational | H7-outside | K04 |
| `src/cli/bench.ts:until:inline:opts.settleMs ?? 600_000=600_000#0` | operational | H7-outside | K04 |
| `src/cli/bench.ts:verify:inline:opts.verifyTimeoutMs ?? 600_000=600_000#0` | test seam | H7-outside | K03 |
| `src/cli/completion.ts:value:inline:parts.length >= 3=3#0` | contract | H7-outside | K01 |
| `src/cli/console-config.ts:text:inline:(current.text + key.replace(/[\x00-\x1f\x7f]/g, )).slice=4000#0` | safety floor | H7-outside | K02 |
| `src/cli/console-review.ts:MAX_TITLE:constant:MAX_TITLE=40#0` | safety floor | H7-outside | K02 |
| `src/cli/console-review.ts:choiceTitle:inline:text.slice=3#0` | contract | H7-outside | K01 |
| `src/cli/console-symbols.ts:MAX_LINES:constant:MAX_LINES=40#0` | safety floor | H7-outside | K02 |
| `src/cli/console-symbols.ts:head:inline:task.codeSymbols.head.slice=8#0` | contract | H7-outside | K01 |
| `src/cli/console-usage.ts:resets:inline:lastResets=3#0` | safety floor | H7-outside | K02 |
| `src/cli/facts-hook.ts:factsHook:inline:timeoutMs=2000#0` | test seam | H7-outside | K03 |
| `src/cli/help.ts:DESCRIPTION:constant:DESCRIPTION=34#0` | contract | H7-outside | K01 |
| `src/cli/identity-audit.ts:MAX_BYTES:constant:MAX_BYTES=64 * 1024#0` | safety floor | H7-outside | K02 |
| `src/cli/identity-audit.ts:MAX_FILES:constant:MAX_FILES=256#0` | safety floor | H7-outside | K02 |
| `src/cli/identity-audit.ts:MAX_ROW_BYTES:constant:MAX_ROW_BYTES=512#0` | safety floor | H7-outside | K02 |
| `src/cli/identity-audit.ts:valid:inline:row.command.length <= 64=64#0` | safety floor | H7-outside | K02 |
| `src/cli/init.ts:timeout:inline:timeout=3000#0` | operational | H7-outside | K07 |
| `src/cli/init.ts:timeout:inline:timeout=3000#1` | operational | H7-outside | K07 |
| `src/cli/init.ts:timeout:inline:timeout=3000#2` | operational | H7-outside | K07 |
| `src/cli/init.ts:timeout:inline:timeout=3000#3` | operational | H7-outside | K07 |
| `src/cli/init.ts:timeout:inline:timeout=3000#4` | operational | H7-outside | K07 |
| `src/cli/kimi-mcp.ts:timeout:inline:timeout=3000#0` | operational | H7-outside | K07 |
| `src/cli/launch.ts:<anonymous>:inline:setTimeout=25#0` | operational | H7-outside | K07 |
| `src/cli/launch.ts:bytes:inline:Buffer.alloc=4#0` | contract | H7-outside | K01 |
| `src/cli/launch.ts:deadline:inline:deadline=250#0` | operational | H7-outside | K07 |
| `src/cli/launch.ts:refreshInterval:inline:tee.original?.refreshInterval ?? 10=10#0` | operational | H7-outside | K07 |
| `src/cli/launch.ts:timeout:inline:timeout=5#0` | operational | H7-outside | K07 |
| `src/cli/main.ts:"check-path":inline:hub.request=1000#0` | operational | H7-outside | K07 |
| `src/cli/main.ts:<anonymous>:inline:Number(one[--limit]) \|\| 20=20#0` | operational | H7-outside | K11 |
| `src/cli/main.ts:<anonymous>:inline:key.length > 160=160#0` | contract | H7-outside | K01 |
| `src/cli/main.ts:ask:inline:e.text.slice=150#0` | safety floor | H7-outside | K02 |
| `src/cli/main.ts:backlog:inline:args.length >= 3=3#0` | contract | H7-outside | K01 |
| `src/cli/main.ts:backlog:inline:args.length >= 4=4#0` | contract | H7-outside | K01 |
| `src/cli/main.ts:backlog:inline:args.length >= 4=4#1` | contract | H7-outside | K01 |
| `src/cli/main.ts:bench:inline:groups.length < 2=2#0` | contract | H7-outside | K01 |
| `src/cli/main.ts:connect:inline:timeoutMs=3000#0` | test seam | H7-outside | K03 |
| `src/cli/main.ts:early:inline:args.length > 2=2#0` | contract | H7-outside | K01 |
| `src/cli/main.ts:id:inline:id=2#0` | operational | H7-outside | K01 |
| `src/cli/main.ts:killOrphan:inline:Bun.sleep=100#0` | operational | H7-outside | K07 |
| `src/cli/main.ts:killOrphan:inline:Bun.sleep=100#1` | operational | H7-outside | K07 |
| `src/cli/main.ts:permission:inline:positional.length > 2=2#0` | contract | H7-outside | K01 |
| `src/cli/main.ts:recovery:inline:reason.length > 500=500#0` | safety floor | H7-outside | K02 |
| `src/cli/main.ts:request:inline:request=2#0` | operational | H7-outside | K01 |
| `src/cli/main.ts:res:inline:timeoutMs ?? (op === github_import ? 60_000 : 30_000)=30_000#0` | operational | H7-outside | K07 |
| `src/cli/main.ts:res:inline:timeoutMs ?? (op === github_import ? 60_000 : 30_000)=60_000#0` | operational | H7-outside | K07 |
| `src/cli/main.ts:resetsInMs:inline:resetsInMs=2#0` | contract | H7-outside | K01 |
| `src/cli/main.ts:role:inline:args.length > 3=3#0` | contract | H7-outside | K01 |
| `src/cli/main.ts:sdlc:inline:args.length < 4=4#0` | contract | H7-outside | K01 |
| `src/cli/main.ts:sdlc:inline:args.length < 5=5#0` | contract | H7-outside | K01 |
| `src/cli/main.ts:sdlc:inline:args.length > 2=2#0` | contract | H7-outside | K01 |
| `src/cli/main.ts:sdlc:inline:args.length > 2=2#1` | contract | H7-outside | K01 |
| `src/cli/main.ts:sdlc:inline:args.length > 34=34#0` | contract | H7-outside | K01 |
| `src/cli/main.ts:sdlc:inline:rawReason.length > 2048=2048#0` | contract | H7-outside | K01 |
| `src/cli/main.ts:sdlc:inline:size > 128 * 1024=128 * 1024#0` | safety floor | H7-outside | K02 |
| `src/cli/main.ts:settings:inline:Buffer.byteLength(JSON.stringify(result), utf8) > 131_072=131_072#0` | safety floor | H7-outside | K02 |
| `src/cli/main.ts:settings:inline:String(row.key).slice=160#0` | safety floor | H7-outside | K02 |
| `src/cli/main.ts:settings:inline:String(row.key).slice=160#1` | safety floor | H7-outside | K02 |
| `src/cli/main.ts:settings:inline:String(row.reason).slice=1000#0` | safety floor | H7-outside | K02 |
| `src/cli/main.ts:settings:inline:String(row.reason).slice=1000#1` | safety floor | H7-outside | K02 |
| `src/cli/main.ts:settings:inline:confirmation.keys.length > 200=200#0` | contract | H7-outside | K01 |
| `src/cli/main.ts:settings:inline:confirmation.token.length > 256=256#0` | safety floor | H7-outside | K02 |
| `src/cli/main.ts:settings:inline:result.rejected.slice=100#0` | safety floor | H7-outside | K02 |
| `src/cli/main.ts:settings:inline:result.rejected.slice=100#1` | safety floor | H7-outside | K02 |
| `src/cli/main.ts:settings:inline:row.min ?? 0=0#0` | contract | H7-outside | K01 |
| `src/cli/main.ts:signal:inline:AbortSignal.timeout=30_000#0` | operational | H7-outside | K07 |
| `src/cli/main.ts:startupDiagnostic:inline:message.replace(/[\p{Cc}\p{Cf}]/gu, ).replace(/\s+/g, ).trim().slice=512#0` | safety floor | H7-outside | K02 |
| `src/cli/main.ts:timeout:inline:timeout=10_000#0` | operational | H7-outside | K07 |
| `src/cli/main.ts:timeout:inline:timeout=2000#0` | operational | H7-outside | K07 |
| `src/cli/main.ts:usage:inline:flags[i]!.slice=40#0` | safety floor | H7-outside | K02 |
| `src/cli/main.ts:usage:inline:limit >= 1=1#0` | contract | H7-outside | K01 |
| `src/cli/memory.ts:cutoffMs:inline:cutoffMs=(opts.now ?? Date.now)() - days * 24 * 3600_000#0` | contract | H7-outside | K01 |
| `src/cli/memory.ts:days:inline:days=90#0` | operational | H7-outside | K11 |
| `src/cli/memory.ts:memoryCommand:inline:/^[1-9][0-9]*$/.test=2#0` | contract | H7-outside | K01 |
| `src/cli/memory.ts:memoryCommand:inline:Math.abs(cutoffMs) > 8_640_000_000_000_000=8_640_000_000_000_000#0` | contract | H7-outside | K01 |
| `src/cli/memory.ts:profileOutput:inline:profile.generation.slice=8#0` | contract | H7-outside | K01 |
| `src/cli/memory.ts:timeout:inline:timeout=1000#0` | operational | H7-outside | K07 |
| `src/cli/memory.ts:ttlMs:inline:loadConfigSafe(cwd)?.memory.short_ttl_days ?? 14=14#0` | operational | H7-outside | K11 |
| `src/cli/memory.ts:ttlMs:inline:ttlMs=(loadConfigSafe(cwd)?.memory.short_ttl_days ?? 14) * 24 * 3600_000#0` | operational | H7-outside | K11 |
| `src/cli/models-setup.ts:post:inline:result.error.slice=200#0` | safety floor | H7-outside | K02 |
| `src/cli/models-setup.ts:signal:inline:AbortSignal.timeout=10_000#0` | operational | H7-outside | K07 |
| `src/cli/models-setup.ts:signal:inline:AbortSignal.timeout=30 * 60_000#0` | operational | H7-outside | K07 |
| `src/cli/output.ts:<anonymous>:inline:text=0#0` | operational | H7-outside | K01 |
| `src/cli/output.ts:<anonymous>:inline:text=1#0` | operational | H7-outside | K01 |
| `src/cli/output.ts:<anonymous>:inline:tone=1#0` | operational | H7-outside | K01 |
| `src/cli/output.ts:itemChunks:inline:characters(split.at(-1)!).filter(unit => width(unit) > 0).length < 3=3#0` | contract | H7-outside | K01 |
| `src/cli/output.ts:pathFloor:inline:columns > 80=80#0` | contract | H7-outside | K01 |
| `src/cli/output.ts:pathFloor:inline:pathFloor=12#0` | contract | H7-outside | K01 |
| `src/cli/output.ts:shortId:inline:String(id).slice=8#0` | contract | H7-outside | K01 |
| `src/cli/output.ts:stageCode:inline:characters(next).slice=9#0` | contract | H7-outside | K01 |
| `src/cli/output.ts:units:inline:split.slice=-2#0` | contract | H7-outside | K01 |
| `src/cli/recovery-package.ts:append:inline:next.length > 2_000_000=2_000_000#0` | safety floor | H4-followup | K02 |
| `src/cli/recovery-package.ts:append:inline:next.slice=-2_000_000#0` | safety floor | H4-followup | K02 |
| `src/cli/recovery-package.ts:hardTimer:inline:options.timeoutMs ?? 60_000=60_000#0` | operational | H4-followup | K05 |
| `src/cli/recovery-package.ts:hardTimer:inline:setTimeout=(options.timeoutMs ?? 60_000) + 3000#0` | operational | H4-followup | K05 |
| `src/cli/recovery-package.ts:timeoutMs:inline:timeoutMs=180_000#0` | operational | H4-followup | K05 |
| `src/cli/recovery-package.ts:timeoutMs:inline:timeoutMs=30_000#0` | operational | H4-followup | K05 |
| `src/cli/recovery-package.ts:timeoutMs:inline:timeoutMs=30_000#1` | operational | H4-followup | K05 |
| `src/cli/recovery-package.ts:timer:inline:options.timeoutMs ?? 60_000=60_000#0` | operational | H4-followup | K05 |
| `src/cli/settings-edit.ts:runSettingsEdit:inline:argv.length > 2=2#0` | contract | H7-outside | K01 |
| `src/cli/statusline-tee.ts:timeout:inline:timeout=5000#0` | operational | H7-outside | K07 |
| `src/cli/terminal-recovery.ts:EXIT_SLICE_MS:constant:EXIT_SLICE_MS=5000#0` | operational | H4-followup | K05 |
| `src/cli/terminal-recovery.ts:MAP_POLL_MS:constant:MAP_POLL_MS=1000#0` | operational | H4-followup | K05 |
| `src/cli/terminal-recovery.ts:MAX_COMMAND_MS:constant:MAX_COMMAND_MS=30000#0` | operational | H4-followup | K05 |
| `src/cli/terminal-recovery.ts:MAX_WAIT_MS:constant:MAX_WAIT_MS=10 * 60 * 1000#0` | operational | H4-followup | K05 |
| `src/cli/terminal-recovery.ts:closeTerminal:inline:Bun.sleep=100#0` | operational | H4-followup | K05 |
| `src/cli/terminal-recovery.ts:closeTerminal:inline:timeoutMs=600_000#0` | test seam | H4-followup | K03 |
| `src/cli/terminal-recovery.ts:createTerminal:inline:Math.max=1#0` | operational | H4-followup | K05 |
| `src/cli/terminal-recovery.ts:createTerminal:inline:timeoutMs=600_000#0` | test seam | H4-followup | K03 |
| `src/cli/terminal-recovery.ts:deadline:inline:deadline=5000#0` | operational | H4-followup | K05 |
| `src/cli/terminal-recovery.ts:message:inline:argv.slice=2#0` | contract | H4-followup | K01 |
| `src/cli/terminal-recovery.ts:message:inline:argv.slice=2#1` | contract | H4-followup | K01 |
| `src/cli/terminal-recovery.ts:restoreTerminal:inline:timeoutMs=600_000#0` | test seam | H4-followup | K03 |
| `src/cli/terminal-recovery.ts:terminalLaunchCandidate:inline:JSON.stringify(value).length > 32 * 1024=32 * 1024#0` | safety floor | H4-followup | K02 |
| `src/cli/terminal-recovery.ts:terminalLaunchCandidate:inline:value.launchId.length > 128=128#0` | safety floor | H4-followup | K02 |
| `src/cli/terminal-recovery.ts:terminalLaunchCandidate:inline:value.launcherSignature.length > 256=256#0` | safety floor | H4-followup | K02 |
| `src/cli/terminal-recovery.ts:timeout:inline:timeout=0#0` | contract | H4-followup | K01 |
| `src/cli/upgrade-interactive.ts:act:inline:reason.slice=500#0` | safety floor | H4-followup | K02 |
| `src/cli/upgrade-interactive.ts:end:inline:reason.slice=500#0` | safety floor | H4-followup | K02 |
| `src/cli/upgrade-interactive.ts:follow:inline:clock(io) - lastWaitAt >= 60_000=60_000#0` | operational | H4-followup | S04 |
| `src/cli/upgrade-interactive.ts:follow:inline:clock(io) - lastWaitAt >= 60_000=60_000#1` | operational | H4-followup | S04 |
| `src/cli/upgrade-interactive.ts:planLines:inline:KINDS[peerKind(p, peer)].padEnd=8#0` | contract | H4-followup | K01 |
| `src/cli/upgrade-interactive.ts:planLines:inline:peer.state.padEnd=7#0` | contract | H4-followup | K01 |
| `src/cli/watch.ts:time:inline:new Date(item.at).toISOString().slice=19#0` | contract | H7-outside | K01 |
| `src/hub/action-class.ts:LIMIT:constant:LIMIT=16384#0` | safety floor | H7-outside | K02 |
| `src/hub/action-class.ts:boundedArgv:inline:value.length <= 256=256#0` | safety floor | H7-outside | K02 |
| `src/hub/action-class.ts:classify:inline:depth < 2=2#0` | safety floor | H7-outside | K02 |
| `src/hub/action-class.ts:classify:inline:words.length > 2=2#0` | contract | H7-outside | K01 |
| `src/hub/action-class.ts:classify:inline:words[0] ?? =0#0` | safety floor | H7-outside | K02 |
| `src/hub/action-class.ts:classifyAction:inline:tool.length > 128=128#0` | safety floor | H7-outside | K02 |
| `src/hub/action-class.ts:commands:inline:words.length + outputs.length > 256=256#0` | safety floor | H7-outside | K02 |
| `src/hub/action-class.ts:name:inline:text.slice=256#0` | safety floor | H7-outside | K02 |
| `src/hub/action-class.ts:segmentLimit:inline:++count > 64=64#0` | safety floor | H7-outside | K02 |
| `src/hub/action-class.ts:sequence:inline:cwd.size >= 128=128#0` | safety floor | H7-outside | K02 |
| `src/hub/action-class.ts:sequence:inline:cwd.size >= 128=128#1` | safety floor | H7-outside | K02 |
| `src/hub/action-policy.ts:"external-write":inline:external-write=5#0` | safety floor | H7-outside | K02 |
| `src/hub/action-policy.ts:complete:inline:full.length <= 512=512#0` | safety floor | H7-outside | K02 |
| `src/hub/action-policy.ts:destroy:inline:destroy=3#0` | safety floor | H7-outside | K02 |
| `src/hub/action-policy.ts:install:inline:install=2#0` | safety floor | H7-outside | K02 |
| `src/hub/action-policy.ts:line:inline:full.length > 512=512#0` | safety floor | H7-outside | K02 |
| `src/hub/action-policy.ts:line:inline:full.slice=512#0` | safety floor | H7-outside | K02 |
| `src/hub/action-policy.ts:title:inline:sanitize(view.title).replace(/[\p{Cc}\p{Cf}]/gu, ).slice=160#0` | safety floor | H7-outside | K02 |
| `src/hub/activity.ts:ActivityRing:inline:maxBytes=256 * 1024#0` | test seam | H7-outside | K03 |
| `src/hub/activity.ts:ActivityRing:inline:maxItems=500#0` | test seam | H7-outside | K03 |
| `src/hub/activity.ts:TEXT_CAP:constant:TEXT_CAP=4096#0` | safety floor | H7-outside | K02 |
| `src/hub/activity.ts:text:inline:u.entries.slice=32#0` | operational | H7-outside | K02 |
| `src/hub/activity.ts:updateActivity:inline:activityText(c.content.text).split(\n).slice=-8#0` | operational | H7-outside | K02 |
| `src/hub/activity.ts:updateActivity:inline:u.content.slice=12#0` | operational | H7-outside | K02 |
| `src/hub/activity.ts:updateActivity:inline:u.locations.slice=12#0` | safety floor | H7-outside | K02 |
| `src/hub/ask.ts:EVIDENCE_CHARS:constant:EVIDENCE_CHARS=6000#0` | operational | H7-outside | K08 |
| `src/hub/ask.ts:ITEM_CHARS:constant:ITEM_CHARS=300#0` | operational | H7-outside | K08 |
| `src/hub/ask.ts:LOG_TAIL_BYTES:constant:LOG_TAIL_BYTES=256 * 1024#0` | operational | H7-outside | K08 |
| `src/hub/ask.ts:MAX_TASKS:constant:MAX_TASKS=25#0` | operational | H7-outside | K08 |
| `src/hub/ask.ts:answer:inline:raw.slice=2000#0` | operational | H7-outside | K08 |
| `src/hub/ask.ts:id:inline:l.slice=10#0` | operational | H7-outside | K08 |
| `src/hub/ask.ts:id:inline:l.slice=23#0` | contract | H7-outside | K01 |
| `src/hub/ask.ts:matching:inline:thisRunsLog(d.logFile).filter((l) => hit(l) > 0).slice=-12#0` | operational | H7-outside | K08 |
| `src/hub/ask.ts:note:inline:invented.slice=3#0` | operational | H7-outside | K08 |
| `src/hub/ask.ts:prefix:inline:row.id.slice=12#0` | contract | H7-outside | K01 |
| `src/hub/ask.ts:text:inline:l.slice=25#0` | operational | H7-outside | K08 |
| `src/hub/ask.ts:timeoutMs:inline:timeoutMs=45_000#0` | operational | H7-outside | K08 |
| `src/hub/bench.ts:<anonymous>:inline:String(r.header.suiteHash ?? ).slice=12#0` | contract | H7-outside | K01 |
| `src/hub/bench.ts:<anonymous>:inline:t.timeout_s < 10=10#0` | operational | H7-outside | K04 |
| `src/hub/bench.ts:<anonymous>:inline:t.timeout_s > 86_400=86_400#0` | operational | H7-outside | K04 |
| `src/hub/bench.ts:HEAD:inline:attempts.padStart=8#0` | operational | H7-outside | K04 |
| `src/hub/bench.ts:HEAD:inline:tokens p50.padStart=10#0` | operational | H7-outside | K04 |
| `src/hub/bench.ts:MIN_ATTEMPTS:constant:MIN_ATTEMPTS=5#0` | operational | H7-outside | K04 |
| `src/hub/bench.ts:benchCompare:inline:resamples=1000#0` | test seam | H7-outside | K03 |
| `src/hub/bench.ts:dur:inline:ms < 120_000=120_000#0` | operational | H7-outside | K04 |
| `src/hub/bench.ts:row:inline:${m.pass}/${m.fail}/${m.timeout}/${m.error}.padStart=11#0` | operational | H7-outside | K04 |
| `src/hub/bench.ts:row:inline:String(m.attempts).padStart=8#0` | operational | H7-outside | K04 |
| `src/hub/bench.ts:row:inline:num(m.tokensMedian).padStart=10#0` | operational | H7-outside | K04 |
| `src/hub/budget.ts:<anonymous>:inline:this.db.query(INSERT INTO budget_pauses (peer, since, resets_at, reason, summary, handed_off, moved) VALUES (?, ?, ?, ?, ?, ?, ?)) .run=0#0` | operational | H7-outside | K01 |
| `src/hub/budget.ts:<anonymous>:inline:this.db.query(INSERT INTO budget_pauses (peer, since, resets_at, reason, summary, handed_off, moved) VALUES (?, ?, ?, ?, ?, ?, ?)) .run=1#0` | operational | H7-outside | K01 |
| `src/hub/budget.ts:FALLBACK_WINDOW_MINS:constant:FALLBACK_WINDOW_MINS=300#0` | operational | H7-outside | K12 |
| `src/hub/budget.ts:HYSTERESIS:constant:HYSTERESIS=0.1#0` | operational | H7-outside | K12 |
| `src/hub/budget.ts:RESET_DROP:constant:RESET_DROP=0.5#0` | operational | H7-outside | K12 |
| `src/hub/budget.ts:RESET_JITTER_MS:constant:RESET_JITTER_MS=15 * 60000#0` | operational | H7-outside | K12 |
| `src/hub/budget.ts:checkpoint_timeout_s:inline:checkpoint_timeout_s=90#0` | operational | H7-outside | K11 |
| `src/hub/budget.ts:poll_min:inline:poll_min=10#0` | operational | H7-outside | K11 |
| `src/hub/budget.ts:reasonWindow:inline:/^(\S+) window at /.exec(reason)?.[1] ?? unknown=1#0` | operational | H7-outside | K01 |
| `src/hub/budget.ts:stale_min:inline:stale_min=30#0` | operational | H7-outside | K11 |
| `src/hub/budget.ts:waitMin:inline:Math.max=0#0` | operational | H7-outside | K01 |
| `src/hub/budget.ts:wait_max_min:inline:wait_max_min=0#0` | operational | H7-outside | K11 |
| `src/hub/bus.ts:delay:inline:delay=1#0` | operational | H3-fence | K06 |
| `src/hub/bus.ts:fenceRecovery:inline:Math.min=50#0` | operational | H3-fence | K06 |
| `src/hub/check-runner.ts:<anonymous>:inline:(stdout + data.toString()).slice=-1_048_576#0` | operational | H7-outside | K14 |
| `src/hub/check-runner.ts:<anonymous>:inline:name.slice=-5#0` | operational | H7-outside | K14 |
| `src/hub/check-runner.ts:<anonymous>:inline:setTimeout=5#0` | operational | H7-outside | K14 |
| `src/hub/check-runner.ts:ContainerRunner:inline:setInterval=60_000#0` | operational | H7-outside | K14 |
| `src/hub/check-runner.ts:DAY:constant:DAY=86400000#0` | operational | H7-outside | K14 |
| `src/hub/check-runner.ts:MAX_OUTPUT:constant:MAX_OUTPUT=1048576#0` | safety floor | H7-outside | K02 |
| `src/hub/check-runner.ts:command:inline:limit=15_000#0` | operational | H7-outside | K14 |
| `src/hub/check-runner.ts:cut:inline:Buffer.byteLength(result) > 4096=4096#0` | operational | H7-outside | K14 |
| `src/hub/check-runner.ts:cut:inline:lines.length > 40=40#0` | operational | H7-outside | K14 |
| `src/hub/check-runner.ts:duration_ms:inline:duration_ms=0#0` | operational | H7-outside | K14 |
| `src/hub/check-runner.ts:id:inline:name.slice=-5#0` | operational | H7-outside | K14 |
| `src/hub/check-runner.ts:platform:inline:version.stdout.trim().slice=80#0` | operational | H7-outside | K14 |
| `src/hub/check-runner.ts:regularFile:inline:stat.size > 64 * 1024 * 1024=64 * 1024 * 1024#0` | operational | H7-outside | K14 |
| `src/hub/check-runner.ts:result:inline:lines.slice=-40#0` | safety floor | H7-outside | K02 |
| `src/hub/check-runner.ts:snapshot:inline:bytes > 512 * 1024 * 1024=512 * 1024 * 1024#0` | operational | H7-outside | K14 |
| `src/hub/check-runner.ts:snapshot:inline:entries.length > 100_000=100_000#0` | safety floor | H7-outside | K02 |
| `src/hub/check-runner.ts:start:inline:request.files.length > 32=32#0` | operational | H7-outside | K14 |
| `src/hub/check-runner.ts:start:inline:this.entries.size >= 3=3#0` | safety floor | H7-outside | K02 |
| `src/hub/check-runner.ts:timeout:inline:Math.max=1#0` | operational | H7-outside | K14 |
| `src/hub/check-runner.ts:timeout:inline:Math.min=600_000#0` | operational | H7-outside | K14 |
| `src/hub/check-runner.ts:timeout:inline:this.options.timeoutMs ?? 600_000=600_000#0` | operational | H7-outside | K14 |
| `src/hub/check-runner.ts:timeout:inline:timeout=15_000#0` | operational | H7-outside | K14 |
| `src/hub/check-runner.ts:timeout:inline:timeout=15_000#1` | operational | H7-outside | K14 |
| `src/hub/check-runner.ts:timeoutMs:inline:timeoutMs=15_000#0` | operational | H7-outside | K14 |
| `src/hub/check-runner.ts:timer:inline:Math.max=1#0` | operational | H7-outside | K14 |
| `src/hub/check-runner.ts:timer:inline:Math.min=600_000#0` | operational | H7-outside | K14 |
| `src/hub/check-runner.ts:timer:inline:options.timeoutMs ?? 15_000=15_000#0` | test seam | H7-outside | K03 |
| `src/hub/check-runner.ts:timer:inline:this.options.lockPollMs ?? 10_000=10_000#0` | operational | H7-outside | K14 |
| `src/hub/check-runner.ts:until:inline:this.options.lockWaitMs ?? 1_800_000=1_800_000#0` | operational | H7-outside | K14 |
| `src/hub/check-runner.ts:walk:inline:++count > 100_000=100_000#0` | operational | H7-outside | K14 |
| `src/hub/check-runner.ts:walk:inline:size > 1024 * 1024 * 1024=1024 * 1024 * 1024#0` | safety floor | H7-outside | K02 |
| `src/hub/claude-launch-proof.ts:bytes:inline:Buffer.alloc=16 * 1024 + 1#0` | operational | H7-outside | K02 |
| `src/hub/claude-launch-proof.ts:readClaudeLaunchProof:inline:count > 16 * 1024=16 * 1024#0` | operational | H7-outside | K02 |
| `src/hub/claude-launch-proof.ts:readClaudeLaunchProof:inline:row.executionCwd.length <= 4096=4096#0` | operational | H7-outside | K02 |
| `src/hub/claude-launch-proof.ts:readClaudeLaunchProof:inline:row.launchId.length > 128=128#0` | operational | H7-outside | K02 |
| `src/hub/claude-launch-proof.ts:readClaudeLaunchProof:inline:stat.size > 16 * 1024=16 * 1024#0` | operational | H7-outside | K02 |
| `src/hub/code-facts.ts:<anonymous>:inline:control.length>64=64#0` | operational | H6-support | K08 |
| `src/hub/code-facts.ts:<anonymous>:inline:node.children.length>32=32#0` | operational | H6-support | K08 |
| `src/hub/code-facts.ts:MAX_FILES:constant:MAX_FILES=4096#0` | operational | H6-support | K08 |
| `src/hub/code-facts.ts:MAX_OUTPUT:constant:MAX_OUTPUT=256 * 1024#0` | safety floor | H6-support | K02 |
| `src/hub/code-facts.ts:MAX_SYMBOLS:constant:MAX_SYMBOLS=256#0` | operational | H6-support | K08 |
| `src/hub/code-facts.ts:MAX_TREE_BYTES:constant:MAX_TREE_BYTES=32 * 1024 * 1024#0` | safety floor | H6-support | K02 |
| `src/hub/code-facts.ts:changed:inline:a.at.length<9=9#0` | contract | H6-support | K01 |
| `src/hub/code-facts.ts:changed:inline:a.base_sha.length<9=9#0` | contract | H6-support | K01 |
| `src/hub/code-facts.ts:end:inline:bytes.indexOf=10#0` | contract | H6-support | K01 |
| `src/hub/code-facts.ts:finish:inline:Bun.sleep=500#0` | operational | H6-support | K08 |
| `src/hub/code-facts.ts:killMs:inline:killMs=500#0` | operational | H6-support | K08 |
| `src/hub/code-facts.ts:killMs:inline:killMs=500#1` | operational | H6-support | K08 |
| `src/hub/code-facts.ts:nativeEnv:inline:keys.length>128=128#0` | operational | H6-support | K08 |
| `src/hub/code-facts.ts:neighbours:inline:depth=1#0` | contract | H6-support | K01 |
| `src/hub/code-facts.ts:query:inline:this.cache.size>128=128#0` | safety floor | H6-support | K02 |
| `src/hub/code-facts.ts:relations:inline:includes=0#0` | contract | H6-support | K01 |
| `src/hub/code-facts.ts:relations:inline:includes=1#0` | operational | H6-support | K08 |
| `src/hub/code-facts.ts:relations:inline:v.defs<1=1#0` | contract | H6-support | K01 |
| `src/hub/code-facts.ts:termMs:inline:termMs=50#0` | operational | H6-support | K08 |
| `src/hub/code-facts.ts:termMs:inline:termMs=50#1` | operational | H6-support | K08 |
| `src/hub/code-facts.ts:text:inline:cap=512#0` | safety floor | H6-support | K02 |
| `src/hub/code-facts.ts:timeout:inline:timeout=5000#0` | operational | H6-support | K08 |
| `src/hub/code-facts.ts:timeout:inline:timeout=5000#1` | operational | H6-support | K08 |
| `src/hub/code-facts.ts:timer:inline:Math.max=1#0` | operational | H6-support | K08 |
| `src/hub/code-facts.ts:timer:inline:Math.min=5000#0` | operational | H6-support | K08 |
| `src/hub/code-facts.ts:timer:inline:this.options.timeoutMs ?? 5000=5000#0` | operational | H6-support | K08 |
| `src/hub/code-facts.ts:tree:inline:size>4*1024*1024=4*1024*1024#0` | safety floor | H6-support | K02 |
| `src/hub/code-facts.ts:xml:inline:++count>4096=4096#0` | safety floor | H6-support | K02 |
| `src/hub/code-facts.ts:xml:inline:stack.length>16=16#0` | safety floor | H6-support | K02 |
| `src/hub/cohorts.ts:MAX_REQUESTS:constant:MAX_REQUESTS=3#0` | operational | H7-outside | K10 |
| `src/hub/cohorts.ts:RETRY_MS:constant:RETRY_MS=2000#0` | operational | H7-outside | K10 |
| `src/hub/cohorts.ts:join:inline:all.length < 2=2#0` | operational | H7-outside | K10 |
| `src/hub/config-apply.ts:applies:inline:[classes, stay_switch, signals, constraints, hub_routes, max_switch_prefill_tokens].includes=1#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:approval_wait_s:inline:number=0#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:approval_wait_s:inline:number=2_147_483_647 / 1000#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:batch_max:inline:number=1#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:batch_max:inline:number=100_000#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:batch_ms:inline:number=0#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:batch_ms:inline:number=2_147_483_647#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:brief_items:inline:number=10_000#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:budgets:inline:number=0#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:budgets:inline:number=1000#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:contextWindow:inline:number=1#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:digest_min_chars:inline:number=1#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:digest_min_chars:inline:number=10_000_000#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:digest_min_items:inline:number=1#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:digest_min_items:inline:number=100_000#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:inject_tokens:inline:number=1_000_000#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:maxConcurrency:inline:number=1#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:maxConcurrency:inline:number=1024#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:min_reviews:inline:number=1#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:no_writes_turns:inline:number=0#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:number:inline:min=0#0` | test seam | H7-outside | K03 |
| `src/hub/config-apply.ts:pair_per_min:inline:number=0#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:port:inline:number=65535#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:queue_cap:inline:number=1#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:queue_cap:inline:number=1_000_000#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:release_after_min:inline:number=0#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:repeat_window_s:inline:number=0#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:sender_per_min:inline:number=0#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:short_ttl_days:inline:number=1#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:short_ttl_days:inline:number=3650#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:strings:inline:v.length > 1024=1024#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:sync_interval_min:inline:number=0#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:sync_interval_min:inline:number=1440#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:text:inline:v.length > 16_384=16_384#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:timerMinutes:inline:number=2_147_483_647 / 60_000#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:timerSeconds:inline:number=2_147_483_647 / 1000#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:wait_max_min:inline:number=0#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:watchdog_ms:inline:number=2_147_483_647#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:wip_limits:inline:number=0#0` | contract | H7-outside | K01 |
| `src/hub/config-apply.ts:wip_limits:inline:number=32#0` | contract | H7-outside | K01 |
| `src/hub/config-edit-host.ts:REASON_BYTES:constant:REASON_BYTES=400#0` | safety floor | H7-outside | K02 |
| `src/hub/config-edit-host.ts:backups:inline:configBackups(host.stateDir).slice=10#0` | operational | H7-outside | K02 |
| `src/hub/config-edit.ts:"config.local.json":inline:config.local.json=1024 * 1024#0` | safety floor | H7-outside | K02 |
| `src/hub/config-edit.ts:"sdlc.toml":inline:sdlc.toml=64 * 1024#0` | safety floor | H7-outside | K02 |
| `src/hub/config-edit.ts:BACKUPS_KEPT:constant:BACKUPS_KEPT=5#0` | operational | H7-outside | K02 |
| `src/hub/config-edit.ts:MAX_EDIT_SETS:constant:MAX_EDIT_SETS=16#0` | operational | H7-outside | K02 |
| `src/hub/config-edit.ts:MAX_VALUE_BYTES:constant:MAX_VALUE_BYTES=16 * 1024#0` | safety floor | H7-outside | K02 |
| `src/hub/config-edit.ts:parseConfigEditRequest:inline:entry.path.length > 6=6#0` | contract | H7-outside | K01 |
| `src/hub/config-edit.ts:valueHash:inline:sha(JSON.stringify(canonical(value))).slice=16#0` | contract | H7-outside | K01 |
| `src/hub/config-edit.ts:writeConfigEdit:inline:sha(plan.before).slice=8#0` | contract | H7-outside | K01 |
| `src/hub/config-reload.ts:<anonymous>:inline:x.length > 4096=4096#0` | contract | H7-outside | K01 |
| `src/hub/config-reload.ts:MAX_CONFIG_BYTES:constant:MAX_CONFIG_BYTES=1024 * 1024#0` | safety floor | H7-outside | K02 |
| `src/hub/config-reload.ts:number:inline:min=1#0` | contract | H7-outside | K01 |
| `src/hub/config-reload.ts:numeric:inline:min=1#0` | contract | H7-outside | K01 |
| `src/hub/config-reload.ts:openValue:inline:depth > 16=16#0` | operational | H7-outside | K02 |
| `src/hub/config-reload.ts:openValue:inline:v.length > 1024=1024#0` | safety floor | H7-outside | K02 |
| `src/hub/config-reload.ts:openValue:inline:v.length > 16_384=16_384#0` | operational | H7-outside | K02 |
| `src/hub/config-reload.ts:peers:inline:v.length > 128=128#0` | safety floor | H7-outside | K02 |
| `src/hub/config-reload.ts:strings:inline:v.length > 256=256#0` | contract | H7-outside | K01 |
| `src/hub/config-reload.ts:table:inline:Object.keys(v).length > 256=256#0` | operational | H7-outside | K02 |
| `src/hub/config-reload.ts:text:inline:v.length > 4096=4096#0` | operational | H7-outside | K02 |
| `src/hub/config-tier.ts:<anonymous>:inline:part.length > 64=64#0` | safety floor | H7-outside | K02 |
| `src/hub/conflicts.ts:<anonymous>:inline:String(r.title).slice=100#0` | operational | H7-outside | K08 |
| `src/hub/context-window.ts:ContextWindows:inline:cfg.gate > 1=1#0` | operational | H7-outside | K01 |
| `src/hub/context-window.ts:report:inline:reading.used > 1=1#0` | operational | H7-outside | K01 |
| `src/hub/context-window.ts:stale_min:inline:stale_min=30#0` | operational | H7-outside | K11 |
| `src/hub/control-client.ts:PROTOCOL:constant:PROTOCOL=16#0` | contract | H4-followup | K01 |
| `src/hub/control-client.ts:backoff:inline:backoff=250#0` | operational | H4-followup | K05 |
| `src/hub/control-client.ts:connect:inline:timeoutMs=3000#0` | test seam | H4-followup | K03 |
| `src/hub/control-client.ts:readControl:inline:status.controlPort > 65535=65535#0` | contract | H4-followup | K01 |
| `src/hub/control-client.ts:request:inline:timeoutMs=30_000#0` | test seam | H4-followup | K03 |
| `src/hub/control-client.ts:retryLaunchConnect:inline:Math.min=1000#0` | operational | H4-followup | K05 |
| `src/hub/control-client.ts:retryLaunchConnect:inline:Math.min=2#0` | operational | H4-followup | K01 |
| `src/hub/control-client.ts:retryLaunchConnect:inline:includes=1006#0` | contract | H4-followup | K01 |
| `src/hub/cost-governance.ts:ciReruns:inline:[...attempts.values()].reduce=0#0` | operational | H7-outside | K08 |
| `src/hub/cost-governance.ts:costMetrics:inline:attempts.get(run.id) ?? 0=0#0` | operational | H7-outside | K08 |
| `src/hub/cost-governance.ts:costMetrics:inline:pr.ciRuns.length > 100=100#0` | operational | H7-outside | K08 |
| `src/hub/cost-governance.ts:costMetrics:inline:pr.ciRuns.slice=100#0` | operational | H7-outside | K08 |
| `src/hub/cost-governance.ts:costMetrics:inline:prs.slice=200#0` | operational | H7-outside | K08 |
| `src/hub/cost-governance.ts:costMetrics:inline:run.attempt < 1=1#0` | contract | H7-outside | K01 |
| `src/hub/cost-governance.ts:costMetrics:inline:run.attempt > 10_000=10_000#0` | safety floor | H7-outside | K02 |
| `src/hub/cost-governance.ts:costMetrics:inline:run.id < 1=1#0` | contract | H7-outside | K01 |
| `src/hub/cost-governance.ts:costMetrics:inline:tasks.slice=500#0` | operational | H7-outside | K08 |
| `src/hub/cost-governance.ts:truncated:inline:prs.length > 200=200#0` | operational | H7-outside | K08 |
| `src/hub/cost-governance.ts:truncated:inline:tasks.length > 500=500#0` | operational | H7-outside | K08 |
| `src/hub/daemon.ts:<anonymous>:inline:Bun.sleep=0#0` | operational | H7-outside | K01 |
| `src/hub/daemon.ts:<anonymous>:inline:Date.now() - o.at > 60_000=60_000#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:<anonymous>:inline:Math.min=50#0` | operational | H7-outside | K07 |
| `src/hub/daemon.ts:<anonymous>:inline:Math.min=delay * 2#0` | operational | H7-outside | K07 |
| `src/hub/daemon.ts:<anonymous>:inline:String(view.detail).slice=1000#0` | safety floor | H7-outside | K02 |
| `src/hub/daemon.ts:<anonymous>:inline:e.env.body.slice=200#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:<anonymous>:inline:m.slice=8#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:<anonymous>:inline:sanitize((error as Error).message).slice=160#0` | safety floor | H7-outside | K02 |
| `src/hub/daemon.ts:<anonymous>:inline:selected.slice=100#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:<anonymous>:inline:uiEvents.length > 200=200#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:admit:inline:reviewPolicies.size >= 64=64#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:approvalAgeMs:inline:approvalAgeMs=(config.conductor?.approval_wait_s ?? 30) * 1000#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:approvalAgeMs:inline:config.conductor?.approval_wait_s ?? 30=30#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:approval_wait_s:inline:approval_wait_s=30#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:armRecoveryLease:inline:delayMs=10 * 60_000#0` | operational | H7-outside | K07 |
| `src/hub/daemon.ts:attempt:inline:attempt=0#0` | operational | H7-outside | K01 |
| `src/hub/daemon.ts:batch_max:inline:batch_max=3#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:batch_ms:inline:batch_ms=15_000#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:brief_items:inline:brief_items=8#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:changeRosterSetting:inline:setTimeout=100#0` | operational | H7-outside | K07 |
| `src/hub/daemon.ts:checkCapability:inline:factsFor(peer).pending(peer).filter((o) => !o.done && Date.now() - o.at > 60_000).length >= 3=3#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:checkTimeoutS:inline:Math.min=3600#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:checkTimeoutS:inline:checkTimeoutS=600#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:checkTimeoutS:inline:config.checks.timeout_s >= 1=1#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:claudeUsageTimer:inline:setInterval=2000#0` | operational | H7-outside | S03 |
| `src/hub/daemon.ts:contextWindow:inline:config.mlx.contextWindow ?? 8192=8192#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:contextWindow:inline:contextWindow=8192#0` | operational | H7-outside | K18 |
| `src/hub/daemon.ts:deadline:inline:deadline=2000#0` | operational | H7-outside | K07 |
| `src/hub/daemon.ts:deadline:inline:deadline=25_000#0` | operational | H7-outside | K07 |
| `src/hub/daemon.ts:delay:inline:delay=5#0` | operational | H7-outside | K07 |
| `src/hub/daemon.ts:drainCliAuditsNow:inline:retainedCliAudits.size > 4096=4096#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:ensurePreface:inline:recallMemoryLines=30#0` | operational | H7-outside | K16 |
| `src/hub/daemon.ts:error:inline:(error as Error).message.slice=120#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:every:inline:config.memory.sync_interval_min ?? 10=10#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:fileSdlc:inline:sanitize((error as Error).message).slice=300#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:first:inline:setTimeout=5_000#0` | operational | H7-outside | S03 |
| `src/hub/daemon.ts:generation:inline:publicStatus.generation.slice=8#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:goalLine:inline:g.id.slice=8#0` | contract | H7-outside | K01 |
| `src/hub/daemon.ts:goalLine:inline:g.lease.holder.slice=8#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:goals:inline:goals.slice=50#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:heartbeat:inline:Math.max=10#0` | operational | H7-outside | K07 |
| `src/hub/daemon.ts:heartbeat:inline:Math.min=1000#0` | operational | H7-outside | K07 |
| `src/hub/daemon.ts:hits:inline:screenMemory(memoryStore!.list({ project: memoryProject, limit: Number.MAX_SAFE_INTEGER })).map((v) => [v, score(v)] as const).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice=6#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:hops:inline:hops=1#0` | operational | H7-outside | K01 |
| `src/hub/daemon.ts:hops:inline:hops=2#0` | operational | H7-outside | K01 |
| `src/hub/daemon.ts:hubTokenWindow:inline:hubTokenWindows.set=5 * 3_600_000#0` | operational | H7-outside | K12 |
| `src/hub/daemon.ts:id:inline:randomUUID().slice=8#0` | contract | H7-outside | K01 |
| `src/hub/daemon.ts:importantWaitingStatus:inline:Date.now() - since < config.budget.stale_min * 60_000=60_000#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:inject_tokens:inline:inject_tokens=2000#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:instance:inline:instanceId.slice=8#0` | contract | H7-outside | K01 |
| `src/hub/daemon.ts:instance:inline:instanceId.slice=8#1` | contract | H7-outside | K01 |
| `src/hub/daemon.ts:interval:inline:interval=100#0` | operational | H7-outside | S03 |
| `src/hub/daemon.ts:intervals:inline:opts.bandsEveryMs ?? 300_000=300_000#0` | test seam | H7-outside | K03 |
| `src/hub/daemon.ts:intervals:inline:setInterval=1000#0` | operational | H7-outside | S03 |
| `src/hub/daemon.ts:intervals:inline:setInterval=10_000#0` | operational | H7-outside | S03 |
| `src/hub/daemon.ts:intervals:inline:setInterval=30_000#0` | operational | H7-outside | S03 |
| `src/hub/daemon.ts:intervals:inline:setInterval=30_000#1` | operational | H7-outside | S03 |
| `src/hub/daemon.ts:intervals:inline:setInterval=5_000#0` | operational | H7-outside | S03 |
| `src/hub/daemon.ts:intervals:inline:setInterval=5_000#1` | operational | H7-outside | S03 |
| `src/hub/daemon.ts:kill:inline:setTimeout=5000#0` | operational | H7-outside | K07 |
| `src/hub/daemon.ts:latencyMs:inline:Math.max=0#0` | operational | H7-outside | K01 |
| `src/hub/daemon.ts:leases:inline:setInterval=10 * 60_000#0` | operational | H7-outside | K07 |
| `src/hub/daemon.ts:limit:inline:limit=100#0` | operational | H7-outside | K16 |
| `src/hub/daemon.ts:limit:inline:limit=50#0` | operational | H7-outside | K16 |
| `src/hub/daemon.ts:listener:inline:setTimeout=100#0` | operational | H7-outside | K07 |
| `src/hub/daemon.ts:maxConcurrency:inline:maxConcurrency=1#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:maxInputTokens:inline:maxInputTokens=16_000#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:maxInputTokens:inline:maxInputTokens=6000#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:maxLeaseMs:inline:maxLeaseMs=10 * 60_000#0` | operational | H7-outside | K07 |
| `src/hub/daemon.ts:maxTokens:inline:Math.min=8192#0` | operational | H7-outside | K18 |
| `src/hub/daemon.ts:maxTokens:inline:config.mlx.maxTokens ?? 2048=2048#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:maxTokens:inline:config.mlx.maxTokens ?? 2048=2048#1` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:maxTokens:inline:maxTokens=2048#0` | operational | H7-outside | K18 |
| `src/hub/daemon.ts:maxTokens:inline:maxTokens=2048#1` | operational | H7-outside | K18 |
| `src/hub/daemon.ts:maxTokens:inline:maxTokens=8192#0` | operational | H7-outside | K18 |
| `src/hub/daemon.ts:maxTokens:inline:maxTokens=8192#1` | operational | H7-outside | K18 |
| `src/hub/daemon.ts:memoryLine:inline:${v.title ? ${v.title}: : }${v.text}.replace(/\s+/g, ).slice=160#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:memoryLine:inline:v.id.slice=8#0` | contract | H7-outside | K01 |
| `src/hub/daemon.ts:message:inline:sanitize(error instanceof Error ? error.message : configuration reload could not be confirmed).slice=600#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:min_reviews:inline:min_reviews=5#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:ms:inline:Math.max=0#0` | operational | H7-outside | K07 |
| `src/hub/daemon.ts:ms:inline:Math.max=1#0` | operational | H7-outside | K07 |
| `src/hub/daemon.ts:ms:inline:Math.min=250#0` | operational | H7-outside | K07 |
| `src/hub/daemon.ts:ms:inline:ms=250#0` | operational | H7-outside | K07 |
| `src/hub/daemon.ts:near:inline:screenMemory(memoryStore!.related(memoryProject, [...new Set(hits.flatMap((v) => v.about))], Number.MAX_SAFE_INTEGER)).slice=6#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:note:inline:${c.title ?? }\n${c.text}.slice=600#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:note:inline:${v.title ?? }\n${v.text}.slice=1500#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:offerFor:inline:factsFor(peer).pending(peer).filter((o) => !o.done).length >= 3=3#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:onMessage:inline:(msg.limit as number) >= 1=1#0` | operational | H7-outside | K01 |
| `src/hub/daemon.ts:onMessage:inline:(msg.liveIssues ?? []).length > 32=32#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:onMessage:inline:msg.id.length > 256=256#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:onMessage:inline:msg.launchId.length <= 128=128#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:onMessage:inline:msg.reason.length > 2000=2000#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:onMessage:inline:msg.reason.length > 2000=2000#1` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:onMessage:inline:setTimeout=0#0` | operational | H7-outside | K01 |
| `src/hub/daemon.ts:onResult:inline:checkBindings.size > 200=200#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:onUnavailable:inline:sanitize(reason).slice=1000#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:onUnavailable:inline:sanitize(reason).slice=300#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:openWatchPane:inline:watchOpening.get(peer) ?? 0=0#0` | operational | H7-outside | K01 |
| `src/hub/daemon.ts:orphanWatch:inline:opts.orphanWatchMs ?? 10_000=10_000#0` | test seam | H7-outside | K03 |
| `src/hub/daemon.ts:owners:inline:msg.owners.filter((o: unknown): o is string => typeof o === string).slice=20#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:peerArg:inline:JSON.stringify(v).slice=60#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:platformContext:inline:trimToTokens=800#0` | operational | H7-outside | K16 |
| `src/hub/daemon.ts:pollUsageRollup:inline:(error as Error).message.slice=120#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:prepareConfiguration:inline:guarded.length > 200=200#0` | safety floor | H7-outside | K02 |
| `src/hub/daemon.ts:prepareConfiguration:inline:key.length > 160=160#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:prepareReviewBrief:inline:reviewSymbols.size > 64=64#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:project:inline:chain.at=-1#0` | operational | H7-outside | K01 |
| `src/hub/daemon.ts:projectKey:inline:createHash(sha256).update(realPath(opts.cwd)).digest(hex).slice=24#0` | contract | H7-outside | K01 |
| `src/hub/daemon.ts:queue_cap:inline:queue_cap=200#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:readTranscript:inline:injected.size > 512=512#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:reading:inline:Math.abs(Date.now() - at) > 1000=1000#0` | operational | H7-outside | K07 |
| `src/hub/daemon.ts:reason:inline:p.trace.at(-1)!.replace(/^ {2}unknown: /, ).slice=200#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:reason:inline:sanitize(e.reason ?? delivery retries exhausted).replace(/\s+/g, ).slice=300#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:reason:inline:sanitize(error.message).slice=1000#0` | safety floor | H7-outside | K02 |
| `src/hub/daemon.ts:reason:inline:sanitize(msg.reason).replace(/\s+/g, ).trim().slice=300#0` | safety floor | H7-outside | K02 |
| `src/hub/daemon.ts:recordConflictLink:inline:recentConflicts.length > 12=12#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:recoveryOp:inline:msg.operationId.length > 128=128#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:recoveryOp:inline:setTimeout=0#0` | operational | H7-outside | K01 |
| `src/hub/daemon.ts:releaseOwners:inline:Date.now() - since < limit * 60_000=60_000#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:releaseTimer:inline:setInterval=60_000#0` | operational | H7-outside | S03 |
| `src/hub/daemon.ts:release_after_min:inline:release_after_min=30#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:renewLeases:inline:Date.parse(g.lease.until!) - Date.now() > DEFAULT_LEASE_MS / 2=DEFAULT_LEASE_MS / 2#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:requested:inline:opts.snapshotBurstMs ?? 250=250#0` | operational | H7-outside | K01 |
| `src/hub/daemon.ts:rescheduleSweep:inline:setInterval=sweep.interval_s * 1000#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:researchGraceMs:inline:opts.researchGraceMs ?? 10_000=10_000#0` | test seam | H7-outside | K03 |
| `src/hub/daemon.ts:retainedConfigAfterReload:inline:sanitize(row.key).slice=160#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:retainedConfigAfterReload:inline:sanitize(row.reason).slice=1200#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:retryAfter:inline:retryAfter=30_000#0` | operational | H7-outside | S03 |
| `src/hub/daemon.ts:running:inline:tasks.wipLimit=2#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:runs:inline:runs.slice=20#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:sessionId:inline:msg.sessionId.slice=128#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:settle:inline:id=0#0` | operational | H7-outside | K01 |
| `src/hub/daemon.ts:settle:inline:mine[0] && tasks.silentFor(mine[0].id)=0#0` | operational | H7-outside | K01 |
| `src/hub/daemon.ts:shown:inline:open.filter((task) => !tasks.isPii(task)).slice=20#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:startPeerBody:inline:setTimeout=30_000#0` | operational | H7-outside | K07 |
| `src/hub/daemon.ts:suite:inline:rs[0]!.header.suiteHash.slice=8#0` | contract | H7-outside | K01 |
| `src/hub/daemon.ts:taskOpBody:inline:a.delivery_id.length > 256=256#0` | safety floor | H7-outside | K02 |
| `src/hub/daemon.ts:taskOpBody:inline:a.files.length > 32=32#0` | safety floor | H7-outside | K02 |
| `src/hub/daemon.ts:taskOpBody:inline:a.reason.length > 2000=2000#0` | safety floor | H7-outside | K02 |
| `src/hub/daemon.ts:taskOpBody:inline:a.release.length > 100=100#0` | safety floor | H7-outside | K02 |
| `src/hub/daemon.ts:taskOpBody:inline:a.superseded_by.length > 2000=2000#0` | safety floor | H7-outside | K02 |
| `src/hub/daemon.ts:terminalLaunchTimer:inline:setInterval=1_000#0` | operational | H7-outside | K07 |
| `src/hub/daemon.ts:text:inline:String(msg.question).slice=300#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:text:inline:max=200#0` | safety floor | H7-outside | K02 |
| `src/hub/daemon.ts:text:inline:res.evidence.map((e) => e.id).join(, ).slice=600#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:text:inline:v.text.slice=600#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:timeoutMs:inline:Math.min=15_000#0` | operational | H7-outside | K07 |
| `src/hub/daemon.ts:timeoutMs:inline:opts.permissionTimeoutMs ?? approvalTimeoutS * 1000=approvalTimeoutS * 1000#0` | operational | H7-outside | K07 |
| `src/hub/daemon.ts:timeout_s:inline:timeout_s=120#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:timeout_s:inline:timeout_s=600#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:timer:inline:setInterval=60_000#0` | operational | H7-outside | S03 |
| `src/hub/daemon.ts:timer:inline:setTimeout=config.budget.checkpoint_timeout_s * 1000#0` | contract | H7-outside | K01 |
| `src/hub/daemon.ts:title:inline:String(msg.question).slice=80#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:tool:inline:msg.tool.slice=64#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:toolUseId:inline:msg.toolUseId.slice=128#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:trace:inline:p.trace.slice(1).map((l) => l.trim()).slice=10#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:truncated:inline:selected.length > 100=100#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:ttlMs:inline:config.memory.short_ttl_days ?? 14=14#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:ttlMs:inline:ttlMs=(config.memory.short_ttl_days ?? 14) * 24 * 3600_000#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:uiAction:inline:a.to.length > 32=32#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:uiAction:inline:liveIssues.length > 32=32#0` | operational | H7-outside | K02 |
| `src/hub/daemon.ts:usagePollMs:inline:usagePollMs=60_000#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:wait_max_min:inline:wait_max_min=30#0` | operational | H7-outside | K11 |
| `src/hub/daemon.ts:wipLimit:inline:wipLimit=1#0` | operational | H7-outside | K11 |
| `src/hub/db-timeout.ts:HUB_DB_BUSY_TIMEOUT_MS:constant:HUB_DB_BUSY_TIMEOUT_MS=3000#0` | operational | H7-outside | K07 |
| `src/hub/deliverable-files.ts:CHUNK:constant:CHUNK=1024 * 1024#0` | operational | H7-outside | K08 |
| `src/hub/deliverable-files.ts:locate:inline:(error as Error).message.replace(path, the path).slice=160#0` | safety floor | H7-outside | K02 |
| `src/hub/dogfood-read.ts:<anonymous>:inline:collected.length>100=100#0` | operational | H7-outside | K08 |
| `src/hub/dogfood-read.ts:<anonymous>:inline:part.workflow_runs.length>100=100#0` | operational | H7-outside | K08 |
| `src/hub/dogfood-read.ts:DOGFOOD_BYTE_CAP:constant:DOGFOOD_BYTE_CAP=16 * 1024 * 1024#0` | safety floor | H7-outside | K02 |
| `src/hub/dogfood-read.ts:MAX_CI_HEADS:constant:MAX_CI_HEADS=8#0` | operational | H7-outside | K08 |
| `src/hub/dogfood-read.ts:MAX_CI_READS:constant:MAX_CI_READS=32#0` | operational | H7-outside | K08 |
| `src/hub/dogfood-read.ts:MAX_PRS:constant:MAX_PRS=16#0` | operational | H7-outside | K08 |
| `src/hub/dogfood-read.ts:MAX_TASKS:constant:MAX_TASKS=500#0` | operational | H7-outside | K08 |
| `src/hub/dogfood-read.ts:at:inline:line.slice=24#0` | operational | H7-outside | K08 |
| `src/hub/dogfood-read.ts:complete:inline:list.length < 100=100#0` | operational | H7-outside | K08 |
| `src/hub/dogfood-read.ts:connection:inline:value.nodes.length <= 100=100#0` | safety floor | H7-outside | K02 |
| `src/hub/dogfood-read.ts:deadline:inline:deadline=20000#0` | operational | H7-outside | K08 |
| `src/hub/dogfood-read.ts:digests:inline:rows.slice=10000#0` | operational | H7-outside | K08 |
| `src/hub/dogfood-read.ts:dogfoodJournal:inline:rows.length<=10000=10000#0` | operational | H7-outside | K08 |
| `src/hub/dogfood-read.ts:dogfoodLines:inline:cap < 1=1#0` | operational | H7-outside | K08 |
| `src/hub/dogfood-read.ts:dogfoodTasks:inline:history.length > 4096=4096#0` | operational | H7-outside | K08 |
| `src/hub/dogfood-read.ts:gh:inline:cap ?? 128*1024=128*1024#0` | operational | H7-outside | K08 |
| `src/hub/dogfood-read.ts:gh:inline:timeout ?? 5000=5000#0` | operational | H7-outside | K08 |
| `src/hub/dogfood-read.ts:held:inline:rows.slice=10000#0` | operational | H7-outside | K08 |
| `src/hub/dogfood-read.ts:text:inline:dogfoodLines=128*1024#0` | safety floor | H7-outside | K02 |
| `src/hub/dogfood-read.ts:validRun:inline:r.pull_requests.length <= 100=100#0` | operational | H7-outside | K08 |
| `src/hub/dogfood.ts:bugObservationDays:inline:Math.max=0#0` | operational | H7-outside | K01 |
| `src/hub/dogfood.ts:bugObservationDays:inline:Math.min=14#0` | operational | H7-outside | K01 |
| `src/hub/dogfood.ts:formatDogfood:inline:JSON.stringify=2#0` | contract | H7-outside | K01 |
| `src/hub/events.ts:EVENTS_SCHEMA:constant:EVENTS_SCHEMA=1#0` | contract | H7-outside | K01 |
| `src/hub/execution-budget.ts:configure:inline:input.id.length > 200=200#0` | operational | H6-support | K08 |
| `src/hub/facts.ts:EXPANDED_KEPT:constant:EXPANDED_KEPT=200#0` | operational | H6-support | K08 |
| `src/hub/facts.ts:HASHED_BYTES:constant:HASHED_BYTES=64 * 1024 * 1024#0` | safety floor | H6-support | K02 |
| `src/hub/facts.ts:MAX_BYTES:constant:MAX_BYTES=256 * 1024#0` | safety floor | H6-support | K02 |
| `src/hub/facts.ts:MAX_LINES:constant:MAX_LINES=60#0` | operational | H6-support | K08 |
| `src/hub/facts.ts:NAMES_SHOWN:constant:NAMES_SHOWN=20#0` | operational | H6-support | K08 |
| `src/hub/facts.ts:OFFERS_KEPT:constant:OFFERS_KEPT=8#0` | operational | H6-support | K08 |
| `src/hub/facts.ts:RACY_BURST_BYTES:constant:RACY_BURST_BYTES=16 * 1024 * 1024#0` | operational | H6-support | K08 |
| `src/hub/facts.ts:RACY_HASH_MAX_BYTES:constant:RACY_HASH_MAX_BYTES=4 * 1024 * 1024#0` | operational | H6-support | K08 |
| `src/hub/facts.ts:RACY_MS:constant:RACY_MS=2000#0` | operational | H6-support | K08 |
| `src/hub/facts.ts:READ_LINES:constant:READ_LINES=2000#0` | operational | H6-support | K08 |
| `src/hub/facts.ts:READ_LINE_CHARS:constant:READ_LINE_CHARS=2000#0` | operational | H6-support | K08 |
| `src/hub/facts.ts:TOUCHED_KEPT:constant:TOUCHED_KEPT=64#0` | operational | H6-support | K08 |
| `src/hub/facts.ts:TRANSITIONS_KEPT:constant:TRANSITIONS_KEPT=64#0` | operational | H6-support | K08 |
| `src/hub/facts.ts:preTool:inline:this.before.size > 256=256#0` | safety floor | H6-support | K02 |
| `src/hub/facts.ts:timeout:inline:timeout=3000#0` | operational | H6-support | K08 |
| `src/hub/facts.ts:wrote:inline:[...(files.get(file) ?? []), Date.now()].slice=-16#0` | operational | H6-support | K08 |
| `src/hub/github-import.ts:<anonymous>:inline:row.body.length>8000=8000#0` | operational | H7-outside | K08 |
| `src/hub/github-import.ts:<anonymous>:inline:row.title.length>300=300#0` | operational | H7-outside | K08 |
| `src/hub/github-import.ts:deadline:inline:deadline=10_000#0` | operational | H7-outside | K08 |
| `src/hub/github-import.ts:issues:inline:issues.slice=32#0` | operational | H7-outside | K08 |
| `src/hub/github-import.ts:partial:inline:issues.length>32=32#0` | operational | H7-outside | K08 |
| `src/hub/github-import.ts:read:inline:new TextEncoder().encode(result.stdout).length>2*1024*1024=2*1024*1024#0` | operational | H7-outside | K08 |
| `src/hub/github-import.ts:readGitHubImport:inline:raw.length>33=33#0` | safety floor | H7-outside | K02 |
| `src/hub/github-import.ts:selectionText:inline:value.length<=100=100#0` | operational | H7-outside | K08 |
| `src/hub/hub-tools.ts:enum:inline:enum=2#0` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=16#0` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=16#1` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=32#0` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=32#1` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=32#2` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=32#3` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=64#0` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=64#1` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=64#2` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=64#3` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=8#0` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=8#1` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=8#2` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=8#3` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maxItems:inline:maxItems=8#4` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maxLength:inline:maxLength=200#0` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maxLength:inline:maxLength=2048#0` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maxLength:inline:maxLength=300#0` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maxLength:inline:maxLength=512#0` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maxLength:inline:maxLength=512#1` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maxLength:inline:maxLength=512#2` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maxLength:inline:maxLength=64#0` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maxLength:inline:maxLength=8000#0` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maxLength:inline:maxLength=96#0` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maximum:inline:maximum=120#0` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maximum:inline:maximum=20#0` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maximum:inline:maximum=3#0` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:maximum:inline:maximum=8#0` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:minItems:inline:minItems=2#0` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:minLength:inline:minLength=6#0` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#0` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#1` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#10` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#11` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#12` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#13` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#2` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#3` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#4` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#5` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#6` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#7` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#8` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:minimum:inline:minimum=0#9` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:minimum:inline:minimum=1#0` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:minimum:inline:minimum=1#1` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:minimum:inline:minimum=1#10` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:minimum:inline:minimum=1#2` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:minimum:inline:minimum=1#3` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:minimum:inline:minimum=1#4` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:minimum:inline:minimum=1#5` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:minimum:inline:minimum=1#6` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:minimum:inline:minimum=1#7` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:minimum:inline:minimum=1#8` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:minimum:inline:minimum=1#9` | contract | H7-outside | K01 |
| `src/hub/hub-tools.ts:projectPeerIds:inline:value.length > 256=256#0` | contract | H7-outside | K01 |
| `src/hub/inbox-polling.ts:read:inline:streak.reads.length < 3=3#0` | operational | H7-outside | C01 |
| `src/hub/instances.ts:MAX_INSTANCES:constant:MAX_INSTANCES=64#0` | operational | H7-outside | K02 |
| `src/hub/instances.ts:MAX_JCODE_INSTANCES:constant:MAX_JCODE_INSTANCES=8#0` | operational | H7-outside | K02 |
| `src/hub/kimi-usage.ts:FLOOR_SLACK_MS:constant:FLOOR_SLACK_MS=1000#0` | operational | H7-outside | K08 |
| `src/hub/kimi-usage.ts:KIMI_WINDOW_MS:constant:KIMI_WINDOW_MS=5 * 3600000#0` | contract | H7-outside | K01 |
| `src/hub/kimi-usage.ts:PASSES:constant:PASSES=16#0` | operational | H7-outside | K08 |
| `src/hub/lifecycle-schema.ts:activeLifecycle:inline:ControlClient.connect=1000#0` | operational | H7-outside | K07 |
| `src/hub/lifecycle-schema.ts:activeLifecycle:inline:stages.length > 32=32#0` | contract | H7-outside | K01 |
| `src/hub/lifecycle.ts:SHUTDOWN_DEADLINE_MS:inline:SHUTDOWN_DEADLINE_MS=15_000#0` | operational | H4-followup | K05 |
| `src/hub/lifecycle.ts:awaitStopped:inline:Bun.sleep=100#0` | operational | H4-followup | K05 |
| `src/hub/lifecycle.ts:deadline:inline:deadline=10_000#0` | operational | H4-followup | K05 |
| `src/hub/lifecycle.ts:deadline:inline:deadline=12_000#0` | operational | H4-followup | K05 |
| `src/hub/lifecycle.ts:inspectProject:inline:timeoutMs=3000#0` | test seam | H4-followup | K03 |
| `src/hub/lifecycle.ts:runProjectDaemon:inline:attempt < 100=100#0` | operational | H4-followup | K05 |
| `src/hub/lifecycle.ts:startProject:inline:Bun.sleep=100#0` | operational | H4-followup | K05 |
| `src/hub/listen.ts:attempt:inline:attempt=0#0` | operational | H7-outside | K01 |
| `src/hub/manager.ts:CONTROL_TIMEOUT:constant:CONTROL_TIMEOUT=3000#0` | operational | H4-followup | K05 |
| `src/hub/manager.ts:MANAGER_OWNER_DB_BUSY_TIMEOUT_MS:constant:MANAGER_OWNER_DB_BUSY_TIMEOUT_MS=5000#0` | operational | H4-followup | K05 |
| `src/hub/manager.ts:deadline:inline:deadline=8000#0` | operational | H4-followup | K05 |
| `src/hub/manager.ts:maxRequestBodySize:inline:maxRequestBodySize=1024#0` | safety floor | H4-followup | K02 |
| `src/hub/manager.ts:nominalMs:inline:nominalMs=10_000#0` | operational | H4-followup | K05 |
| `src/hub/manager.ts:openManager:inline:Bun.sleep=100#0` | operational | H4-followup | K05 |
| `src/hub/manager.ts:readManifest:inline:status.port > 65535=65535#0` | contract | H4-followup | K01 |
| `src/hub/manager.ts:refreshManager:inline:Bun.sleep=25#0` | operational | H4-followup | K05 |
| `src/hub/manager.ts:safeError:inline:error.message.slice=300#0` | safety floor | H4-followup | K02 |
| `src/hub/manager.ts:startManager:inline:options.orphanWatchMs ?? 10_000=10_000#0` | test seam | H4-followup | K03 |
| `src/hub/manager.ts:stopManager:inline:Bun.sleep=25#0` | operational | H4-followup | K05 |
| `src/hub/memory-candidates.ts:[field]:inline:[field]=1#0` | safety floor | H7-outside | K02 |
| `src/hub/memory-candidates.ts:correctionInput:inline:bytes(JSON.stringify(result)) > 8192=8192#0` | safety floor | H7-outside | K02 |
| `src/hub/memory-candidates.ts:visibleId:inline:bytes(input) < 6=6#0` | safety floor | H7-outside | K02 |
| `src/hub/memory-candidates.ts:visibleId:inline:bytes(input) > 64=64#0` | safety floor | H7-outside | K02 |
| `src/hub/memory-candidates.ts:visibleId:inline:id.length < 6=6#0` | contract | H7-outside | K01 |
| `src/hub/memory-fail.ts:REMEMBER_TEXT_MAX_BYTES:constant:REMEMBER_TEXT_MAX_BYTES=4000#0` | safety floor | H7-outside | K02 |
| `src/hub/memory-observations.ts:delivery:inline:this.pending.size > 2048=2048#0` | safety floor | H7-outside | K02 |
| `src/hub/memory-profile-check.ts:receipt:inline:value.home.length > 4096=4096#0` | safety floor | H7-outside | K02 |
| `src/hub/memory-stale-anchors.ts:MEMORY_STALE_SCAN_LIMIT:constant:MEMORY_STALE_SCAN_LIMIT=256#0` | safety floor | H7-outside | K02 |
| `src/hub/memory-stale-anchors.ts:NODE_SCAN_LIMIT:constant:NODE_SCAN_LIMIT=256#0` | safety floor | H7-outside | K02 |
| `src/hub/memory-stale-anchors.ts:PAGE:constant:PAGE=64#0` | operational | H7-outside | K16 |
| `src/hub/memory-staleness.ts:STALENESS_MAX_PROBES:constant:STALENESS_MAX_PROBES=32#0` | safety floor | H7-outside | K02 |
| `src/hub/memory-staleness.ts:missing:inline:path.length > 4096=4096#0` | safety floor | H7-outside | K02 |
| `src/hub/memory-symbols.ts:MEMORY_SYMBOL_LIMIT:constant:MEMORY_SYMBOL_LIMIT=16#0` | safety floor | H7-outside | K02 |
| `src/hub/memory-symbols.ts:MEMORY_SYMBOL_START_BUDGET_MS:constant:MEMORY_SYMBOL_START_BUDGET_MS=2000#0` | operational | H7-outside | K16 |
| `src/hub/path-policy.ts:<anonymous>:inline:(p.match(/[?*]/g)?.length ?? 0) > 16=16#0` | safety floor | H7-outside | K02 |
| `src/hub/path-policy.ts:<anonymous>:inline:p.length > 200=200#0` | safety floor | H7-outside | K02 |
| `src/hub/path-policy.ts:aliasScope:inline:budget.entries >= 4096=4096#0` | safety floor | H7-outside | K02 |
| `src/hub/path-policy.ts:aliasScope:inline:budget.entries >= 4096=4096#1` | safety floor | H7-outside | K02 |
| `src/hub/path-policy.ts:directAliasTarget:inline:hops <= 40=40#0` | safety floor | H7-outside | K02 |
| `src/hub/path-policy.ts:entries:inline:entries=0#0` | safety floor | H7-outside | K02 |
| `src/hub/path-policy.ts:hops:inline:hops=0#0` | safety floor | H7-outside | K02 |
| `src/hub/path-policy.ts:matchesPolicy:inline:path.length > 4096=4096#0` | safety floor | H7-outside | K02 |
| `src/hub/path-policy.ts:policyPaths:inline:raw.length > 64=64#0` | safety floor | H7-outside | K02 |
| `src/hub/path-policy.ts:visit:inline:++budget.entries > 4096=4096#0` | safety floor | H7-outside | K02 |
| `src/hub/path-policy.ts:visit:inline:budget.entries > 4096=4096#0` | safety floor | H7-outside | K02 |
| `src/hub/path-policy.ts:visit:inline:budget.entries >= 4096=4096#0` | safety floor | H7-outside | K02 |
| `src/hub/path-policy.ts:visit:inline:budget.entries >= 4096=4096#1` | safety floor | H7-outside | K02 |
| `src/hub/path-policy.ts:visit:inline:depth > 32=32#0` | safety floor | H7-outside | K02 |
| `src/hub/plan-conformance.ts:completePlanInventory:inline:evidence.paths.length > 1000=1000#0` | operational | H7-outside | K08 |
| `src/hub/plan-conformance.ts:encode:inline:depth > 64=64#0` | safety floor | H7-outside | K02 |
| `src/hub/plan-conformance.ts:pathIdentity:inline:raw.length > 1000=1000#0` | safety floor | H7-outside | K02 |
| `src/hub/plan-conformance.ts:planConformance:inline:planPaths.length > 1000=1000#0` | operational | H7-outside | K08 |
| `src/hub/ports.ts:BASE_PORT:constant:BASE_PORT=4600#0` | contract | H4-followup | K01 |
| `src/hub/ports.ts:CODEX_APP:constant:CODEX_APP=1#0` | contract | H4-followup | K01 |
| `src/hub/ports.ts:CODEX_PROXY:constant:CODEX_PROXY=2#0` | contract | H4-followup | K01 |
| `src/hub/ports.ts:CONTROL:constant:CONTROL=0#0` | contract | H4-followup | K01 |
| `src/hub/ports.ts:STRIDE:constant:STRIDE=10#0` | contract | H4-followup | K01 |
| `src/hub/ports.ts:SWITCHYARD:constant:SWITCHYARD=3#0` | contract | H4-followup | K01 |
| `src/hub/ports.ts:allocatePorts:inline:Atomics.wait=0#0` | operational | H4-followup | K01 |
| `src/hub/ports.ts:allocatePorts:inline:Atomics.wait=0#1` | operational | H4-followup | K01 |
| `src/hub/ports.ts:allocatePorts:inline:Atomics.wait=10#0` | operational | H4-followup | K05 |
| `src/hub/ports.ts:allocatePorts:inline:Atomics.wait=4#0` | operational | H4-followup | K01 |
| `src/hub/ports.ts:allocatePorts:inline:attempt >= 500=500#0` | operational | H4-followup | K05 |
| `src/hub/ports.ts:attempt:inline:attempt=0#0` | operational | H4-followup | K01 |
| `src/hub/profiles.ts:<anonymous>:inline:value.length > 500=500#0` | operational | H7-outside | K02 |
| `src/hub/profiles.ts:resolveProfile:inline:Object.keys(data.classes).length > 32=32#0` | safety floor | H7-outside | K02 |
| `src/hub/profiles.ts:resolveProfile:inline:Object.keys(data.role_text).length > 8=8#0` | operational | H7-outside | K02 |
| `src/hub/profiles.ts:resolveProfile:inline:data.example_checks.length > 16=16#0` | operational | H7-outside | K02 |
| `src/hub/profiles.ts:resolveProfile:inline:data.review_checklist.length > 16=16#0` | safety floor | H7-outside | K02 |
| `src/hub/progress.ts:<anonymous>:inline:turns.size >= 2=2#0` | operational | H7-outside | S02 |
| `src/hub/progress.ts:MAX_OBSERVATIONS:constant:MAX_OBSERVATIONS=28#0` | operational | H7-outside | S02 |
| `src/hub/progress.ts:MAX_STATES:constant:MAX_STATES=256#0` | operational | H7-outside | S02 |
| `src/hub/progress.ts:MAX_TEXT:constant:MAX_TEXT=500#0` | operational | H7-outside | S02 |
| `src/hub/progress.ts:TTL_MS:constant:TTL_MS=60 * 60000#0` | operational | H7-outside | K03 |
| `src/hub/progress.ts:name:inline:item.name.slice=80#0` | operational | H7-outside | K02 |
| `src/hub/progress.ts:name:inline:tool.slice=80#0` | operational | H7-outside | K02 |
| `src/hub/progress.ts:source:inline:item.source.slice=40#0` | operational | H7-outside | K02 |
| `src/hub/progress.ts:validTurn:inline:turn.trim().slice=120#0` | safety floor | H7-outside | K02 |
| `src/hub/projected-diff.ts:DIFF_MS:constant:DIFF_MS=8000#0` | operational | H7-outside | K08 |
| `src/hub/projected-diff.ts:MAX_FILES:constant:MAX_FILES=8#0` | operational | H7-outside | K08 |
| `src/hub/projected-diff.ts:PROJECTED_DIFF_BYTES:constant:PROJECTED_DIFF_BYTES=12000#0` | operational | H7-outside | K08 |
| `src/hub/projected-diff.ts:size:inline:run=2#0` | operational | H7-outside | K08 |
| `src/hub/projected-diff.ts:timeout:inline:Math.max=1#0` | operational | H7-outside | K08 |
| `src/hub/projected-diff.ts:timeout:inline:Math.max=1#1` | operational | H7-outside | K08 |
| `src/hub/projection-exec.ts:limit:constant:limit=256 * 1024#0` | operational | H7-outside | K08 |
| `src/hub/projection-exec.ts:timeout:inline:Math.max=1#0` | operational | H7-outside | K08 |
| `src/hub/projection-exec.ts:timeout:inline:Math.min=5000#0` | safety floor | H7-outside | K02 |
| `src/hub/projection-exec.ts:timeout:inline:timeout=5000#0` | operational | H7-outside | K08 |
| `src/hub/read-tools.ts:array:inline:v.length <= 8=8#0` | contract | H7-outside | K01 |
| `src/hub/read-tools.ts:cap:inline:cap=4096#0` | contract | H7-outside | K01 |
| `src/hub/read-tools.ts:cap:inline:cap=8192#0` | contract | H7-outside | K01 |
| `src/hub/read-tools.ts:excerpt:inline:max=200#0` | test seam | H7-outside | K03 |
| `src/hub/read-tools.ts:graph:inline:a.hops ?? 1=1#0` | contract | H7-outside | K01 |
| `src/hub/read-tools.ts:limit:inline:Number(a.limit) >= 1=1#0` | contract | H7-outside | K01 |
| `src/hub/read-tools.ts:memoryRead:inline:a.limit ?? 60=60#0` | contract | H7-outside | K01 |
| `src/hub/read-tools.ts:memoryRead:inline:a.limit ?? 8=8#0` | contract | H7-outside | K01 |
| `src/hub/read-tools.ts:memoryRead:inline:bytes(JSON.stringify(out)) > (eligibleEdges.length ? 5120 : 6144)=5120#0` | contract | H7-outside | K01 |
| `src/hub/read-tools.ts:memoryRead:inline:bytes(JSON.stringify(out)) > (eligibleEdges.length ? 5120 : 6144)=6144#0` | contract | H7-outside | K01 |
| `src/hub/read-tools.ts:memoryRead:inline:bytes(JSON.stringify(out)) > 6144=6144#0` | contract | H7-outside | K01 |
| `src/hub/read-tools.ts:memoryRead:inline:lines.length >= (show ? 8 : Number(a.limit ?? 8))=8#0` | contract | H7-outside | K01 |
| `src/hub/read-tools.ts:memoryRead:inline:out.edges.length >= 240=240#0` | contract | H7-outside | K01 |
| `src/hub/read-tools.ts:resolve:inline:id.length < 6=6#0` | contract | H7-outside | K01 |
| `src/hub/read-tools.ts:validateMemoryRead:inline:array=1#0` | contract | H7-outside | K01 |
| `src/hub/read-tools.ts:validateMemoryRead:inline:array=200#0` | contract | H7-outside | K01 |
| `src/hub/read-tools.ts:validateMemoryRead:inline:limit=120#0` | contract | H7-outside | K01 |
| `src/hub/read-tools.ts:validateMemoryRead:inline:limit=20#0` | contract | H7-outside | K01 |
| `src/hub/read-tools.ts:validateMemoryRead:inline:string=0#0` | contract | H7-outside | K01 |
| `src/hub/read-tools.ts:validateMemoryRead:inline:string=200#0` | contract | H7-outside | K01 |
| `src/hub/recovery-continuity.ts:MAX_BOOKMARK_BYTES:constant:MAX_BOOKMARK_BYTES=16 * 1024#0` | safety floor | H4-followup | K02 |
| `src/hub/recovery-continuity.ts:RECOVERY_CONTINUITY_BUSY_TIMEOUT_MS:constant:RECOVERY_CONTINUITY_BUSY_TIMEOUT_MS=3000#0` | operational | H4-followup | K05 |
| `src/hub/recovery-store.ts:<anonymous>:inline:setTimeout=100#0` | operational | H4-followup | K05 |
| `src/hub/recovery-store.ts:RUNNER_DB_BUSY_TIMEOUT_MS:constant:RUNNER_DB_BUSY_TIMEOUT_MS=3000#0` | operational | H4-followup | K05 |
| `src/hub/recovery-store.ts:stopSignedRunner:inline:waitMs=5000#0` | test seam | H4-followup | K03 |
| `src/hub/registry.ts:BASE_PORT:constant:BASE_PORT=4600#0` | contract | H7-outside | K01 |
| `src/hub/registry.ts:MAX_PORT:constant:MAX_PORT=65535 - 3#0` | contract | H7-outside | K01 |
| `src/hub/registry.ts:REGISTRY_DB_BUSY_TIMEOUT_MS:constant:REGISTRY_DB_BUSY_TIMEOUT_MS=5000#0` | operational | H7-outside | K07 |
| `src/hub/registry.ts:STRIDE:constant:STRIDE=10#0` | contract | H7-outside | K01 |
| `src/hub/registry.ts:idFor:inline:createHash(sha256).update(root).digest(hex).slice=24#0` | operational | H7-outside | K01 |
| `src/hub/research.ts:addonReport:inline:resamples=1000#0` | test seam | H7-outside | K03 |
| `src/hub/research.ts:head:inline:tokens p50.padStart=10#0` | operational | H7-outside | K01 |
| `src/hub/research.ts:head:inline:tokens p90.padStart=10#0` | operational | H7-outside | K01 |
| `src/hub/research.ts:projectKey:inline:createHash(sha256).update(projectId).digest(hex).slice=16#0` | operational | H7-outside | K01 |
| `src/hub/research.ts:row:inline:fmtNum(m.tokensPerTask.median).padStart=10#0` | operational | H7-outside | K01 |
| `src/hub/research.ts:row:inline:fmtNum(m.tokensPerTask.p90).padStart=10#0` | operational | H7-outside | K01 |
| `src/hub/roles.ts:bytes:inline:Buffer.alloc=8193#0` | safety floor | H7-outside | K02 |
| `src/hub/roles.ts:catalogAssignments:inline:Object.keys(raw).length > 64=64#0` | safety floor | H7-outside | K02 |
| `src/hub/roles.ts:catalogAssignments:inline:ids.length > 2=2#0` | safety floor | H7-outside | K02 |
| `src/hub/roles.ts:catalogSection:inline:roles.length > 2=2#0` | safety floor | H7-outside | K02 |
| `src/hub/roles.ts:id:inline:file.slice=-3#0` | contract | H7-outside | K01 |
| `src/hub/roles.ts:loadRoleCatalog:inline:files.length > 64=64#0` | safety floor | H7-outside | K02 |
| `src/hub/roles.ts:parseRole:inline:header.name!.length > 80=80#0` | contract | H7-outside | K01 |
| `src/hub/roles.ts:parseRole:inline:header.source!.length > 300=300#0` | contract | H7-outside | K01 |
| `src/hub/roles.ts:parseRole:inline:header.summary!.length > 160=160#0` | contract | H7-outside | K01 |
| `src/hub/roles.ts:parseRole:inline:sanitize(body).length > 2000=2000#0` | safety floor | H7-outside | K02 |
| `src/hub/roles.ts:projectRole:inline:before.size > 8192=8192#0` | operational | H7-outside | K02 |
| `src/hub/roles.ts:review:inline:index=5#0` | operational | H7-outside | K01 |
| `src/hub/roles.ts:taskRoleText:inline:text.length > 2000=2000#0` | safety floor | H7-outside | K02 |
| `src/hub/settings.ts:<anonymous>:inline:def.path.slice=2#0` | contract | H7-outside | K01 |
| `src/hub/settings.ts:PEERS_MAX:constant:PEERS_MAX=8#0` | contract | H7-outside | K01 |
| `src/hub/settings.ts:checkSettingValue:inline:def.min ?? 0=0#0` | contract | H7-outside | K01 |
| `src/hub/settings.ts:checkSettingValue:inline:def.min ?? 0=0#1` | contract | H7-outside | K01 |
| `src/hub/settings.ts:checkSettingValue:inline:raw.length > 2=2#0` | contract | H7-outside | K01 |
| `src/hub/settings.ts:max:inline:max=10#0` | contract | H7-outside | K01 |
| `src/hub/settings.ts:max:inline:max=1000#0` | contract | H7-outside | K01 |
| `src/hub/settings.ts:max:inline:max=1000#1` | contract | H7-outside | K01 |
| `src/hub/settings.ts:max:inline:max=2_147_483_647 / (key === "interval_s" ? 1000 : 60_000)#0` | contract | H7-outside | K01 |
| `src/hub/settings.ts:max:inline:max=32#0` | contract | H7-outside | K01 |
| `src/hub/settings.ts:max:inline:max=60_000#0` | contract | H7-outside | K01 |
| `src/hub/settings.ts:min:inline:min=0#0` | contract | H7-outside | K01 |
| `src/hub/settings.ts:min:inline:min=0#1` | contract | H7-outside | K01 |
| `src/hub/settings.ts:min:inline:min=0#2` | contract | H7-outside | K01 |
| `src/hub/settings.ts:min:inline:min=1#0` | contract | H7-outside | K01 |
| `src/hub/settings.ts:min:inline:min=1#1` | contract | H7-outside | K01 |
| `src/hub/settings.ts:settingDef:inline:key.length > 80=80#0` | safety floor | H7-outside | K02 |
| `src/hub/snapshots.ts:HEAD_LOG_MAX_APPEND_BYTES:constant:HEAD_LOG_MAX_APPEND_BYTES=128 * 1024#0` | safety floor | H4-followup | K02 |
| `src/hub/snapshots.ts:HEAD_LOG_MAX_MOVES:constant:HEAD_LOG_MAX_MOVES=64#0` | safety floor | H4-followup | K02 |
| `src/hub/snapshots.ts:HEAD_LOG_TAIL_BYTES:constant:HEAD_LOG_TAIL_BYTES=4096#0` | safety floor | H4-followup | K02 |
| `src/hub/snapshots.ts:SNAPSHOT_TIMEOUT_MS:constant:SNAPSHOT_TIMEOUT_MS=10000#0` | operational | H4-followup | K05 |
| `src/hub/snapshots.ts:list:inline:limit=20#0` | test seam | H4-followup | K03 |
| `src/hub/snapshots.ts:symbolicHeadRef:inline:named.size > 4096=4096#0` | safety floor | H4-followup | K02 |
| `src/hub/snapshots.ts:timeout:inline:Math.max=1#0` | operational | H4-followup | K05 |
| `src/hub/snapshots.ts:visit:inline:++entries > 20000=20000#0` | safety floor | H4-followup | K02 |
| `src/hub/snapshots.ts:visit:inline:depth > 32=32#0` | safety floor | H4-followup | K02 |
| `src/hub/spec-read.ts:BODY_LIMIT:constant:BODY_LIMIT=64 * 1024#0` | safety floor | H7-outside | K02 |
| `src/hub/spec-read.ts:RESULT_LIMIT:constant:RESULT_LIMIT=80 * 1024#0` | safety floor | H7-outside | K02 |
| `src/hub/spec-read.ts:STDOUT_LIMIT:constant:STDOUT_LIMIT=512 * 1024#0` | safety floor | H7-outside | K02 |
| `src/hub/spec-read.ts:killMs:inline:killMs=500#0` | operational | H7-outside | K08 |
| `src/hub/spec-read.ts:qualifiedTitleRepos:inline:found.size >= 4=4#0` | operational | H7-outside | K08 |
| `src/hub/spec-read.ts:siblingTitleRefs:inline:[...found].slice=4#0` | operational | H7-outside | K08 |
| `src/hub/spec-read.ts:specRefs:inline:issues.size > 3=3#0` | operational | H7-outside | K08 |
| `src/hub/spec-read.ts:termMs:inline:termMs=100#0` | operational | H7-outside | K08 |
| `src/hub/spec-read.ts:timeout:inline:Math.max=1#0` | operational | H7-outside | K08 |
| `src/hub/spec-read.ts:timeout:inline:Math.min=15_000#0` | operational | H7-outside | K08 |
| `src/hub/spec-read.ts:timeout:inline:timeout=15_000#0` | test seam | H7-outside | K03 |
| `src/hub/terminal-launch.ts:<anonymous>:inline:bytes > 1024 * 1024=1024 * 1024#0` | operational | H7-outside | K02 |
| `src/hub/terminal-launch.ts:register:inline:this.candidates.size >= 64=64#0` | operational | H7-outside | K02 |
| `src/hub/terminal-launch.ts:register:inline:this.candidates.size >= 64=64#1` | operational | H7-outside | K02 |
| `src/hub/terminal-open.ts:SETTLE_MS:constant:SETTLE_MS=1500#0` | operational | H5-adjacent | S01 |
| `src/hub/test-integrity.ts:<anonymous>:inline:text=100#0` | safety floor | H7-outside | K02 |
| `src/hub/test-integrity.ts:deadline:inline:deadline=20_000#0` | safety floor | H7-outside | K02 |
| `src/hub/test-integrity.ts:parseIssueLabels:inline:nodes.length > 100=100#0` | safety floor | H7-outside | K02 |
| `src/hub/test-integrity.ts:read:inline:cap=128 * 1024#0` | safety floor | H7-outside | K02 |
| `src/hub/test-integrity.ts:readTestIntegrity:inline:changes.length <= 1000=1000#0` | safety floor | H7-outside | K02 |
| `src/hub/test-integrity.ts:readTestIntegrity:inline:commit.files.length >= 100=100#0` | safety floor | H7-outside | K02 |
| `src/hub/test-integrity.ts:readTestIntegrity:inline:contexts.nodes.length > 100=100#0` | safety floor | H7-outside | K02 |
| `src/hub/test-integrity.ts:readTestIntegrity:inline:current.commits.nodes.length > 100=100#0` | safety floor | H7-outside | K02 |
| `src/hub/test-integrity.ts:readTestIntegrity:inline:preloaded.length > 100=100#0` | safety floor | H7-outside | K02 |
| `src/hub/test-integrity.ts:readTestIntegrity:inline:seen.size >= 100=100#0` | safety floor | H7-outside | K02 |
| `src/hub/text-projection.ts:<anonymous>:inline:arg.length > 2000=2000#0` | safety floor | H7-outside | K02 |
| `src/hub/text-projection.ts:MAX_PROJECTION_INPUT:constant:MAX_PROJECTION_INPUT=16 * 1024 * 1024#0` | safety floor | H7-outside | K02 |
| `src/hub/text-projection.ts:MAX_TEXT:constant:MAX_TEXT=256 * 1024#0` | safety floor | H7-outside | K02 |
| `src/hub/text-projection.ts:boundedCache:inline:st.size > MAX_TEXT * 2=2#0` | safety floor | H7-outside | K02 |
| `src/hub/text-projection.ts:choices:inline:(process.env.PATH ?? /usr/bin:/bin).split(:).slice=32#0` | safety floor | H7-outside | K02 |
| `src/hub/text-projection.ts:convert:inline:Buffer.byteLength(cached) <= MAX_TEXT * 2=2#0` | safety floor | H7-outside | K02 |
| `src/hub/text-projection.ts:failure:inline:this.failed.size >= 1024=1024#0` | safety floor | H7-outside | K02 |
| `src/hub/text-projection.ts:projectionConfig:inline:Object.keys(raw).length > 16=16#0` | safety floor | H7-outside | K02 |
| `src/hub/text-projection.ts:projectionConfig:inline:argv.length > 16=16#0` | safety floor | H7-outside | K02 |
| `src/hub/text-projection.ts:timeout:inline:Math.max=1#0` | operational | H7-outside | K08 |
| `src/hub/text-projection.ts:timeout:inline:Math.min=8000#0` | safety floor | H7-outside | K02 |
| `src/hub/text-projection.ts:timeout:inline:timeout=8000#0` | safety floor | H7-outside | K02 |
| `src/hub/text-projection.ts:timeoutMs:inline:Math.max=1#0` | operational | H7-outside | K08 |
| `src/hub/text-projection.ts:timeoutMs:inline:Math.min=100#0` | safety floor | H7-outside | K02 |
| `src/hub/text-projection.ts:timeoutMs:inline:Math.min=5000#0` | safety floor | H7-outside | K02 |
| `src/hub/tooling.ts:<anonymous>:inline:setTimeout=50#0` | operational | H7-outside | K07 |
| `src/hub/tooling.ts:PROBE_BYTES:constant:PROBE_BYTES=4096#0` | safety floor | H7-outside | K02 |
| `src/hub/tooling.ts:PROBE_MS:constant:PROBE_MS=2000#0` | operational | H7-outside | K07 |
| `src/hub/usage-rollup.ts:DEFAULT_MAX_BYTES:constant:DEFAULT_MAX_BYTES=8 * 1024 * 1024#0` | operational | H7-outside | K15 |
| `src/hub/usage-rollup.ts:LIMITS_DEFAULT:constant:LIMITS_DEFAULT=200#0` | operational | H7-outside | K15 |
| `src/hub/usage-rollup.ts:LIMITS_MAX:constant:LIMITS_MAX=5000#0` | operational | H7-outside | K15 |
| `src/hub/usage-rollup.ts:MAX_LINE_BYTES:constant:MAX_LINE_BYTES=4 * 1024 * 1024#0` | operational | H7-outside | K15 |
| `src/hub/usage-rollup.ts:NO_TASK:constant:NO_TASK=0#0` | contract | H7-outside | K01 |
| `src/hub/usage-rollup.ts:bounds:inline:new Date(q.since).toISOString().slice=10#0` | contract | H7-outside | K01 |
| `src/hub/usage-rollup.ts:bounds:inline:new Date(q.until).toISOString().slice=10#0` | contract | H7-outside | K01 |
| `src/hub/usage-rollup.ts:daily:inline:days=14#0` | test seam | H7-outside | K03 |
| `src/hub/usage-rollup.ts:day:inline:new Date(Date.parse(today + T00:00:00Z) - i * dayMs).toISOString().slice=10#0` | contract | H7-outside | K01 |
| `src/hub/usage-rollup.ts:day:inline:new Date(t).toISOString().slice=10#0` | contract | H7-outside | K01 |
| `src/hub/usage-rollup.ts:dayMs:inline:dayMs=86_400_000#0` | operational | H7-outside | K15 |
| `src/hub/usage-rollup.ts:deadline:inline:Math.max=0#0` | operational | H7-outside | K15 |
| `src/hub/usage-rollup.ts:deadline:inline:Math.min=20#0` | operational | H7-outside | K15 |
| `src/hub/usage-rollup.ts:limits:inline:limit < 1=1#0` | operational | H7-outside | K15 |
| `src/hub/usage-rollup.ts:poll:inline:maxMs=20#0` | test seam | H7-outside | K03 |
| `src/hub/usage-rollup.ts:start:inline:start=0#0` | operational | H7-outside | K15 |
| `src/hub/usage-rollup.ts:sumVal:inline:knownCounters.reduce=0#0` | operational | H7-outside | K15 |
| `src/hub/usage-rollup.ts:today:inline:new Date(now).toISOString().slice=10#0` | contract | H7-outside | K01 |
| `src/hub/usage.ts:COMPLETION_SCAN_BYTES:constant:COMPLETION_SCAN_BYTES=64 * 1024 * 1024#0` | operational | H7-outside | K15 |
| `src/hub/usage.ts:COMPLETION_TAIL_BYTES:constant:COMPLETION_TAIL_BYTES=4 * 1024 * 1024#0` | operational | H7-outside | K15 |
| `src/hub/usage.ts:budget:inline:Math.max=0#0` | operational | H7-outside | K15 |
| `src/hub/usage.ts:budget:inline:Math.min=1200#0` | operational | H7-outside | K15 |
| `src/hub/usage.ts:budget:inline:budget=1200#0` | operational | H7-outside | K15 |
| `src/hub/usage.ts:limit:inline:Math.max=0#0` | operational | H7-outside | K15 |
| `src/hub/usage.ts:readClaudeTranscriptUsage:inline:statSync(transcriptPath).size > 32 * 1024 * 1024=32 * 1024 * 1024#0` | operational | H7-outside | K15 |
| `src/hub/usage.ts:waitForClaudeCompletion:inline:Math.min=40#0` | operational | H7-outside | K15 |
| `src/hub/usage.ts:waitForClaudeCompletion:inline:timeoutMs=1200#0` | test seam | H7-outside | K03 |
| `src/memory/brief.ts:Briefs:inline:maxItems=8#0` | test seam | H7-outside | K03 |
| `src/memory/brief.ts:hits:inline:query.slice=300#0` | safety floor | H7-outside | K02 |
| `src/memory/capture.ts:observe:inline:this.toolTimes.size > 1024=1024#0` | operational | H7-outside | K16 |
| `src/memory/client.ts:cap:inline:Math.max=0#0` | operational | H7-outside | K16 |
| `src/memory/client.ts:cap:inline:Math.min=30#0` | operational | H7-outside | K16 |
| `src/memory/client.ts:limit:inline:limit=256#0` | operational | H7-outside | K16 |
| `src/memory/client.ts:limit:inline:limit=4096#0` | operational | H7-outside | K16 |
| `src/memory/client.ts:limit:inline:limit=4096#1` | operational | H7-outside | K16 |
| `src/memory/client.ts:rows:inline:page < 16=16#0` | operational | H7-outside | K16 |
| `src/memory/client.ts:rows:inline:this.rows(o).filter(v => v.tier === short).slice=30#0` | safety floor | H7-outside | K02 |
| `src/memory/client.ts:search:inline:limit=10#0` | test seam | H7-outside | K03 |
| `src/memory/recall.ts:RECALL_LINE_CHARS:constant:RECALL_LINE_CHARS=200#0` | safety floor | H7-outside | K02 |
| `src/memory/recall.ts:count:inline:count=4#0` | contract | H7-outside | K01 |
| `src/memory/recall.ts:idChars:inline:note.id.slice=8#0` | contract | H7-outside | K01 |
| `src/memory/recall.ts:max:inline:max=3#0` | contract | H7-outside | K01 |
| `src/memory/recall.ts:prefix:inline:note.id.slice=8#0` | contract | H7-outside | K01 |
| `src/memory/recall.ts:recallMemoryLines:inline:limit=30#0` | test seam | H7-outside | K03 |
| `src/models/route/advisor.ts:bound:inline:this.entries.size >= 1024=1024#0` | operational | H6-policy | S02 |
| `src/models/route/advisor.ts:bound:inline:this.stalled.size >= 1024=1024#0` | operational | H6-policy | S02 |
| `src/models/route/signals.ts:CRITICAL:constant:CRITICAL=1#0` | operational | H6-policy | S02 |
| `src/models/route/signals.ts:DEFAULT_RECENT_WINDOW:constant:DEFAULT_RECENT_WINDOW=3#0` | operational | H6-policy | S02 |
| `src/models/route/signals.ts:HARD:constant:HARD=0.7#0` | operational | H6-policy | S02 |
| `src/models/route/signals.ts:SOFT:constant:SOFT=0.3#0` | operational | H6-policy | S02 |
| `src/models/route/stage.ts:HARD_SEVERITY:constant:HARD_SEVERITY=0.7#0` | operational | H6-policy | S02 |
| `src/models/route/stage.ts:SCORE_GAIN:constant:SCORE_GAIN=5#0` | operational | H6-policy | S02 |
| `src/models/route/stage.ts:SEVERITY_CRITICAL:constant:SEVERITY_CRITICAL=1#0` | operational | H6-policy | S02 |
| `src/models/route/stage.ts:SIGNAL_UNIT:constant:SIGNAL_UNIT=0.1#0` | operational | H6-policy | S02 |
| `src/models/route/stage.ts:STALL_MIN_TURN_DEPTH:constant:STALL_MIN_TURN_DEPTH=8#0` | operational | H6-policy | S02 |
| `src/omniroute/client.ts:signal:inline:AbortSignal.timeout=4000#0` | operational | H6-policy | K07 |
| `src/omniroute/client.ts:signal:inline:AbortSignal.timeout=4000#1` | operational | H6-policy | K07 |
| `src/pet/window.jxa.js:implementation:inline:body.text.length <= 65536=65536#0` | safety floor | H7-outside | K02 |
| `src/pet/window.jxa.js:run:inline:$.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats=0.1#0` | operational | H7-outside | S04 |
| `src/pet/window.jxa.js:run:inline:$.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats=1#0` | operational | H7-outside | S04 |
| `src/pet/window.jxa.js:runCommand:inline:commands.length >= 8=8#0` | safety floor | H7-outside | K02 |
| `src/pet/window.ts:closePetWindow:inline:Bun.sleep=50#0` | operational | H7-outside | S04 |
| `src/pet/window.ts:deadline:inline:deadline=5000#0` | operational | H7-outside | S04 |
| `src/pet/window.ts:deadline:inline:deadline=5000#1` | operational | H7-outside | S04 |
| `src/pet/window.ts:readyDeadline:inline:readyDeadline=4000#0` | operational | H7-outside | S04 |
| `src/pet/window.ts:runPetWindowHost:inline:Bun.sleep=50#0` | operational | H7-outside | S04 |
| `src/pet/window.ts:runPetWindowHost:inline:setInterval=1000#0` | operational | H7-outside | S04 |
| `src/pet/window.ts:startPetWindow:inline:Bun.sleep=50#0` | operational | H7-outside | S04 |
