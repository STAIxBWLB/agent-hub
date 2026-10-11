# Issues from #109: audit and sequential implementation

Date: 2026-10-11. Baseline: `06fb87afbdb315d2b6d7e6455c5084b1998cb724`. Source: GitHub issue bodies and current repository, refreshed before decisions. Execution: one implementer, no ahub orchestration and no child agents.

## Inventory

125 issues numbered #109 or later: 101 already closed, 24 open. No open PR at intake. Closed issues are not reopened or reimplemented. No whole open issue is a proven duplicate: the overlaps below are scoped dependencies or superseded sections, so blanket closure would lose acceptance criteria.

## Open issue disposition

| Issue | State | Remaining contract |
| --- | --- | --- |
| [#109](https://github.com/STAIxBWLB/agent-hub/issues/109) | Research gate | Shadow predictor shipped; current-version routing-time preregistration and held-out errors remain. Automatic rerouting stays off. |
| [#198](https://github.com/STAIxBWLB/agent-hub/issues/198) | Partially shipped | PR #222 shipped the fail-closed screen; AC4 live recall/precision/unknown-rate measurement remains (bound 0.90 already fixed). |
| [#199](https://github.com/STAIxBWLB/agent-hub/issues/199) | Partially shipped | PR #219 shipped load moves/cooldowns. AC5 mixed-workload wait measurement remains; load moves stay opt-in. |
| [#248](https://github.com/STAIxBWLB/agent-hub/issues/248) | Research | Tool fingerprints, preregistered arms and real measured comparisons; no fabricated results. |
| [#252](https://github.com/STAIxBWLB/agent-hub/issues/252) | Design | Analyze GSD against current flow and specify optional changes; overlaps #257 but has independent evidence criteria. |
| [#256](https://github.com/STAIxBWLB/agent-hub/issues/256) | Feature | Qwen headless peer and explicit permission map; roster defaults off. Precedes Qwen portions of #286. |
| [#257](https://github.com/STAIxBWLB/agent-hub/issues/257) | Feature/design | SDLC contract, head-bound reviews and opt-in enforcement. Uses #252 analysis. |
| [#258](https://github.com/STAIxBWLB/agent-hub/issues/258) | Feature/design | Native memory ownership amends existing architecture; store/graph before machine sync and measurement. |
| [#259](https://github.com/STAIxBWLB/agent-hub/issues/259) | Feature | Non-dev profiles and document checks; preserve dev defaults. Shared profile vocabulary with #295. |
| [#263](https://github.com/STAIxBWLB/agent-hub/issues/263) | Feature | Backlog, dashboard board, planner grooming and releases through Tasks. Supplies later #264/#295 surfaces. |
| [#264](https://github.com/STAIxBWLB/agent-hub/issues/264) | Feature | Static Flat SVG first, then motion, snapshot fields, Isometric, backlog/release additions after #263. |
| [#266](https://github.com/STAIxBWLB/agent-hub/issues/266) | Research/feature | Vendor capability proof before task execution policy and benchmark matrix; measurements remain a separate gate. |
| [#273](https://github.com/STAIxBWLB/agent-hub/issues/273) | Live verification | Shipped implementation follow-ups require real accounts/terminals. Keep open; PR #320 is already merged. |
| [#280](https://github.com/STAIxBWLB/agent-hub/issues/280) | Feature/artwork | Pure needs model and console line first. Owner-selected artwork/license and variants remain decisions; no arbitrary asset adoption. |
| [#285](https://github.com/STAIxBWLB/agent-hub/issues/285) | Partially shipped | Phase 1 ACP context occupancy merged in PR #294; native proof tracked in #273. Wire-log counts, quota opt-in and surfaces remain. |
| [#286](https://github.com/STAIxBWLB/agent-hub/issues/286) | Feature | Watch stream and Qwen launcher are distinct from native TUI. Kimi TUI portions superseded by #316; Qwen dual-output remains gated. |
| [#295](https://github.com/STAIxBWLB/agent-hub/issues/295) | Feature | Catalog guidance separate from authority roles; bounded role text, layer/hash and task roles. Dashboard cards wait for #263. |
| [#310](https://github.com/STAIxBWLB/agent-hub/issues/310) | Bug | Replace pending-approval real-time margin with controlled watchdog observations; retain mutation proof. |
| [#311](https://github.com/STAIxBWLB/agent-hub/issues/311) | Security bug | Reject offline ACP permission requests; abort pending approvals and fence late decisions; restart must restore normal approvals. |
| [#316](https://github.com/STAIxBWLB/agent-hub/issues/316) | In progress elsewhere | Existing dirty feat-316 worktree is preserved. Step 1 shipped in PR #321; remaining pull-only Kimi implementation is not complete. |
| [#318](https://github.com/STAIxBWLB/agent-hub/issues/318) | Release bug | Fail tag gate on stale/non-ancestor documentation stamps; merge and squash fixture proof. |
| [#319](https://github.com/STAIxBWLB/agent-hub/issues/319) | Rendering bug | Normalize body tabs consistently; width checks at 40/80/120 and no-tab byte preservation. |
| [#322](https://github.com/STAIxBWLB/agent-hub/issues/322) | Security bug | Check protected names in both lexical and resolved write paths for Pi/local; keep realPath target and explicit approval. |
| [#323](https://github.com/STAIxBWLB/agent-hub/issues/323) | Security option | Inventory supported project config/skill files; instruction files remain grantable by default with person-only runtime option. |

## Sequence

1. Safety and release correctness: #311, #322, #318. Small independent correctness fixes: #319 and #310. Each gets a focused regression and the repository gate.
2. #323 config inventory and person-only option; complete remaining #316 work only after reading and preserving its existing worktree changes. #256 Qwen peer follows; #286 headless watch and launcher reuse that peer.
3. #199 mixed-workload measurement and #198 live screen evaluation using the existing code and fixed recall bound; no duplicate implementation.
4. #252 lifecycle analysis, #257 lifecycle implementation; #259 profiles and #295 initial dev/research role catalog.
5. #263 backlog/releases/dashboard board; #264 office phases; #280 console attention model and approved artwork, then dashboard surfaces.
6. #258 store/graph, then machine sync/leases, then import and measurement.
7. #266 capability matrix and execution policy; #248 controlled add-on study; #109 current-version preregistration and held-out assessment. Real accounts, resource admission and independent measurement gates apply to studies.
8. #285 wire-log usage and budget surfaces; OAuth probe stays off unless its separate exact authorization is satisfied. #273 remains the live receipt ledger throughout.

## Completion rules

- Do not close partially shipped work, research gates or live verification on code or synthetic tests alone.
- Close a duplicate only when every outstanding criterion is preserved in its named survivor; no candidate meets that rule at intake.
- Each implemented slice records exact head, focused checks, full `scripts/check.sh` output and PR. No merge/release is implied by a green local gate.
- Preserve other sessions' worktrees and dirty files. This implementation uses `.worktrees/issues-109-sequential`.
- Source code review and measured/runtime evidence remain distinct. Unrun native legs stay unverified.

## Intake implementation receipts

- #318: local fixture history proves a release merge commit passes and an equal-tree squash fails with the named instruction; 5 documentation tests passed.
- #310/#311/#319/#322: focused regressions passed (8 pass, 0 fail, 10940 assertions). Journal and journal-less offline ACP, pending approval withdrawal across console/dashboard, restart, 500 ms / 2 s native delays, all protected symlink names for Pi/local, explicit approval, never-ask and ordinary symlinks covered.
- At intake, full repository gate and seeded guards were pending. The later merge receipts below supersede that checkpoint; native account/runtime legs remain unverified.

## Delivered receipts, 2026-10-11

The owner subsequently authorized merging verified PRs and added Jcode peer support to the scope. These slices passed exact-head Linux/macOS `scripts/check.sh` and seeded guards, had review comments/threads handled, and were merged.

| PR | Scope | Merge commit |
| --- | --- | --- |
| #325 | #310/#311/#318/#319/#322 safety and correctness | c292591 |
| #326 | #323 protected config and instruction-file policy | 3809f9c |
| #328 | #316 pull-only Kimi TUI | 0ff40c4 |
| #329 | #109 approved 120-pair preregistration | d01aec5 |
| #330 | #252 source analysis and bounded GSD proposal | d97991a |
| #331 | #256 optional Qwen ACP | f745f0b |
| #333 | #257 initial head-bound SDLC gates | adccf91 |
| #334 | #332 optional owned Jcode ACP/MCP | e414611 |

- Duplicate PR #327 was closed in favour of #328. Other sessions' worktrees and unmerged recovery history were preserved.
- Parent #324 remains open. #109 measurement, #252 integration/measurement, #256 native proof, #257 custom stages/release/workflow, and #332 native MCP/PII/restoration proof remain partial. A merged slice does not complete its parent's unrun criteria.
- Next slice: #286 Part 1 in PR #335, person-only headless ACP watch. Final checks/review are pending at this documentation checkpoint. Native T0 remains explicitly unverified.
- Continue with #257 bounded gsd-lite/checklist guidance, then #259 profiles and #295 catalog. Later sequence and owner-only decisions remain as listed above.
