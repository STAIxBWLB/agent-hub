# Dogfooding: agent-hub on agent-hub

agent-hub is developed with agent-hub. This page lists every feature, whether it runs in this repository's own hub, and how its real-use behaviour and performance are measured. The tracking issue is #687.

- **State:** `on` runs here; `advise` runs and reports without blocking; `off` is available but not enabled here, with the reason; `pending` is not built yet (its issue).
- **Measured by:** the command or record that shows, from real use, whether the feature works and what it costs. The weekly scorecard (#687) collects these into `docs/verification/dogfood/`.
- **Rule:** a PR that adds or changes a user-facing feature updates its row here: whether it runs on this repository, and the metric that shows it works.

## Coordination

| Feature | State here | Measured by |
| --- | --- | --- |
| Message bus, digests, priorities | on | `ahub report`: messages, digests, overflow, undeliverable; delivery latency from events |
| Compact board (#724) | on | `ahub board` at 80, 120 and 200 columns: one line per task (test/board-compact.test.ts) |
| Backlog list table (#399) | on | `ahub backlog list` at a terminal width: one line per card by rank with the reserved owner and dependencies, and the count by owner (test/backlog-list-output.test.ts); `--json` for scripts |
| Native branch ratchet and fixed builtin proof gate (#625 slice 2a) | active in source/CI after merge; running daemon gate takes effect after release and upgrade | reviewed predicate/function/count/reason rows equal source; foreign native proof products and nativeRevert declarations refused; reserved ACP ports leg remains unverified until 2b |
| Task board, routing, roles | on (claude planner, reviewer and implementer; codex, jcode, agy implementers) | board history: lead time from propose to approve, review rounds, escalations |
| Planner walk and reviewer independence (#525-3) | on after the release: `ahub route explain <id>` prints the planner walk here, and with `claude` the only planner holder it names `claude` for every task (rotation among one holder); the rotation among several holders and a named planner are not exercised here, task bindings are tracked separately below (525-2). Reviewer independence (I-2) is on: a peer that accepted or finished a task never reviews it | the `planner: claude (rotation)` line in `ahub route explain` for a task; I-2 shown as `reviewer user` with the trace line `every eligible reviewer implemented this task: the person reviews` on a task `claude` implemented (such as #399), and as `skipped, implemented this task` on the other candidates; a former implementer that is offline or paused is refused for that reason and leaves the outcome unchanged (the trace still ends `reviewer: none, done will approve directly` where no other reviewer exists) |
| Per-task and release planners, I-4 (#525-2) | off until this change is released and the running hub is upgraded; this PR enables no new project planner configuration | task/release planner bindings and selection reasons; wrong-planner pre-effect refusals; independent plan-review requests and `selfReview` receipts; queued notices rerouted after a planner change; `task_planners` recovery refusals |
| Acceptance criteria ids in review (#507b) | on after the release: a task with a recorded `criteria` checklist lists its ids in the review request and `hub_review` unmet items that start with an id are recorded as `unmetCriteria`; tasks here rarely record a checklist, so most reviews are unchanged | the `Acceptance criteria` block in a review request and `unmetCriteria` in `ahub task show` history for tasks with a checklist; the share of changes-requested verdicts whose unmet items name an id; unmet items that name an id the checklist does not hold (a typo) |
| Deliverable records (#509a) | on after the release: `deliverables` on `hub_task_done` and `hub_sdlc_record`, hashed by the hub in this repository's folder; most tasks here are code with a PR and name none, so only document-shaped work (a report, a spec draft) uses it | the `Deliverables` block in a review request and `deliverables` in `ahub task show`; approvals refused with `deliverable changed since it was delivered`; records with `state: unknown` (a file the hub could not vouch for); claimed-hash refusals as a measure of agents trying to supply a hash |
| `ahub deliverables` and the dashboard badge (#509b) | on after the release: `ahub deliverables [--check]` on this repository's board; only tasks that named deliverables appear, so it lists document-shaped work only | the person runs `ahub deliverables --check` after a document task is approved and the next time its file is edited: a `changed since review` row names the edit; `Deliverables n` chips on cards; `not measured now` in the sheet means nobody ran `--check` since the daemon started |
| Roles per kind and form (#525-1, #525-3, #525-4, #525-5) | on: claude holds the implementer role in the project checkout; isolated terminal and headless Claude implementer support is on, but neither form is declared here | tasks by owner; verified owner isolation and execution-root refusals; headless task-session resumes, inbox task-session refusals, fresh notices and person approval outcomes; missing or mismatched root must never admit a write owner |
| Read-time memory code neighbours (#684 phase 4) | off until released; dashboard toggle is opt-in | derived call edges with current SHA; attached fail/decision brief coverage; explicit unknown/truncated results; unchanged authoritative memory log bytes |
| Canonical memory symbol anchors (#684 phase 3) | off until released; optional `doctor --stale-anchors` report only | actual-symbol completion anchors versus plan guesses; symbol-related earlier notes at memory hop two; stale/unknown/truncated report counts; zero note mutations during inspection |
| Symbol preparation and historical recall (#684 phase 3 follow-ups) | off until release | exists calls per no-reviewer completion; raw-signature fail recall; indexed-definition/unknown labels; unchanged note/candidate bytes and neutral cleanup failures |
| Overlap notices | on; plan symbols match by normalized name (arguments stripped, a bare name matches the last segment, two qualified names must be equal; #682 phase 1b) | `ahub report`: overlap warnings, task pairs; false-overlap rate, and symbol-only matches on bare common names (#682) |
| Backlog phase grooming and issue planning (#759) | off until released and the running hub supports the new planning fields; relinks for cards #138/#287 remain a post-landing planner action | related-phase duplicate count; unrelated same-issue duplicate controls; planning revisions with `fields: ["sdlc"]` or `[]`; old spec acceptance absent after relink/undo |
| Planner WIP caps and backlog pull (#655, #718) | on (`tasks.wip_limits.codex = 2`); reserved-pull handoff on after release | board history/offer readback: reserved `backlog pulled` -> `assigned` -> `accepted` for the same peer; stale or unowned offers, capacity refusals and held-ready entries |
| Task sweep (stalls, idle owners) | on | stall and sweep events per week |
| Turn-free coordination | off: experimental; needs a separate measured trial | coordination events, conflict notices |
| Pull-only peers (agy) | on; `hub_inbox` drains to 64 KiB (#713) | unread offers, empty-inbox polling (#681); queued count and oldest queued age per pull-only peer in `ahub status`; reads that said `N more waiting` |
| Completed-change notices, grouped and superseding (#713) | on after release; accepted tasks only | queued `is done and touches` notices per peer (one per done, not per task and per repeat); `superseded completed-change notice` discards; `ahub queue discard` uses |

## Review and lifecycle

| Feature | State here | Measured by |
| --- | --- | --- |
| Optional changed-symbol advice (#682, #684 phase 1a) | on after release when ripwire 0.6.7 is installed; change kinds unknown | review brief symbol observations/unknowns; deleted definitions not covered, no gate |
| Head-bound task symbol observations (#684 phase 2a) | on after release with optional code facts; observed names only | task/UI receipts and completed-change labels; unknown/filtered evidence keeps ordinary overlap, deleted definitions not covered |
| Console changed-symbols block (#684 phase 2b) | on with 2a data; matching, unplanned and untouched against the plan; overlap lines follow in #379; related-note count remains phase 4 | task detail shows the block or `unknown (no code facts)`; no block for a private task |
| Console review guidance (#711) | on after release; `r` verdict choice, hints, visible result, agent-shell cause line, notice names the console | a person approving from the console without a failed first try; refusals that named the cause; `ahub review` calls from agent shells that were refused |
| Console symbol-overlap advice (#684, #379) | on after release; read-only task detail, observed names only | other task IDs/shared paths and screened different-symbol verdict; no pair involving PII, no claim on unknown/incomplete evidence |
| Dashboard task sheet Code group (#684 phase 2c) | on after release; read-only, observed names only, none for a private task | task sheet Code group shows the changed symbols or `unknown (no code facts)`; symbol clicks that reach a non-empty graph once phase 3 lands |
| Review brief, review findings, Important gate (#481 S3) | advise | Important findings per PR, rounds to approval |
| Spec acceptance (#481 S1) | advise | build entries without acceptance |
| Lifecycle identity linked by the hub (#694, #723) | on in advise; links at propose and accept from the title and `refs.repo`, with a groom backfill as the safety net | open tasks still showing `issue identity missing` right after propose (should be only titles that name no issue or a qualified title without `refs.repo`) |
| Planner plan review (#481 S9) | advise | plans reviewed before build |
| Planner board-changed notice (#758) | on here, with the lifecycle in `advise`: `claude` is the planner, so a card another peer proposes or re-plans reaches it once at task weight, and its own writes, state moves, reviews and assignments cost it no turn | per planner and week: `task`-kind hub envelopes whose body starts `The board changed` (target: one per planning change, none after the planner's own write), the same envelopes at `fyi` priority (recorded, no turn: at most one per 10 minutes), and the count still queued at once (target: at most one). Read from `ahub log` and the event log; the 12 copies in 44 minutes seen on 2026-10-24 are the baseline |
| Plan conformance (#481 S2) | advise | PRs with files outside the plan |
| Test integrity for bug fixes (#481 S4) | advise | bug PRs without a red-first receipt, modified pre-existing tests |
| Required checks | advise (`check (ubuntu-latest)`, `check (macos-latest)`, `seeded guards`) | first-pass CI rate, same-head reruns (`hub_sdlc_costs`) |
| Seed anchor diagnostics (#684) | on in the seeded checker; exact-match failure remains mandatory | missing anchors report the base commit, enclosing symbol and current file/line or explicit unknown; `test/seeded-check.test.ts` |
| Release authorization (#481 S6) | pending (#199) | releases with a receipt |
| SDLC metrics and control bands (#481 S7) | `ahub sdlc metrics` on; bands off until `[bands]` is set in `.agenthub/sdlc.toml`, and they write cards only in advise or enforce (in off the report still shows tiers). Completion checks are off here, so `first_pass_check` and the PR-based figures read unknown | its own report; breach episodes per week by tier, and band cards the planner accepted rather than dropped |
| Fresh headless reviewers (#223, #519) | off: needs an `instances` entry in the person's `config.local.json` | reviews by fresh sessions, findings they add; a per-review start failure names a closed cause class (#722): `ahub status` reviewer line and hub.log `[cause: ...]`, with the share of failures that are `unknown` |
| Completion checks per class | off: the implementer already runs `scripts/check.sh`; a hub-run copy would double the heavy-slot use | time to verdict when on |

## Memory and knowledge

| Feature | State here | Measured by |
| --- | --- | --- |
| amem runtime integration (agent-mem#13 P4) | on after release; no claude-mem worker dependency | no-worker tripwire requests (must be 0), screened capture rows, profile refusals, all-author short-term recall, bounded-view truncation notices and curated-only ask citations |
| Shared memory through amem, briefs, recall preface | on; library intent briefs and plan guard (#436) take effect after release and hub upgrade; legacy index/timeline reads and worker notices retire in intent mode | notes saved per week, brief hits, fails that prevented a retry; same-input hub/library brief equality, host privacy refusals and front-of-brief plan fails despite the library byte cap or standalone screen |
| `ahub ask` | on | answers with cited ids |
| Code structure in the memory graph (#684) | pending | stale anchors, briefs with related notes |

## Models, budget and safety

| Feature | State here | Measured by |
| --- | --- | --- |
| Quota budgets and pauses | on | pauses, resets, time paused (#683) |
| Token usage per peer and task | `ahub report` and, from the roll-up in `hub.db`, `ahub usage [--by peer\|task\|issue\|pr\|release\|day\|model]`, `usage limits` and `usage total` (#683 U2); console tab `7` (U3) and dashboard Usage view (U4) shipped | tokens per merged PR |
| Context gate | off: `context.gate = 0` | context-pressure events |
| Always-ask action classes (#636) | on after release for managed Claude forms, hub-owned ACP in ask mode, local/Pi tools and received Codex command approvals; Codex native bypass stays not enforceable | classed permission requests (a `gh api graphql` query is a read, a mutation, `gh run` or `gh workflow` write and every command with a shell expansion in a classed position (`git push $B`, `rm -rf "$DIR"`) is asked about: #756, #762; `test/action-class.test.ts` holds the table), full local/Pi command visibility and denied effects for incomplete native views; actionPolicyInfo current-child enforceability, remaining class budgets and weakening attention; Codex native no-request and Kimi non-ask ceilings are explicit |
| Permission modes | on, person-chosen | approval prompts and their wait times |
| Pi and the local worker on DGX | off: DGX unreachable recently; Pi is off the roster | turns served on-prem, relay errors |
| PII routing | on | PII tasks and where they ran |
| Multiple Jcode instances (#685) | pending | turns per instance |

## Operations

| Feature | State here | Measured by |
| --- | --- | --- |
| Dogfood scorecard (#687) | on after release; read-only weekly receipt | `ahub report --dogfood --since 7d --json`; bounded evidence and explicit unknowns |
| Console and dashboard | on; #719 pending-history reads and bounded native launch retries take effect after release | control-request latency, connection timeouts and launch retry notices; daemon CPU/RSS samples, measured separately from lifetime CPU |
| Usage view (#683) | CLI (`ahub usage`, U2), console Usage tab `7` (U3) and dashboard Usage view (U4) shipped | its own panels |
| Kimi usage from its wire log (#285 phase 2) | on after the release when `budget.kimi_tokens_5h` is set; this repository sets it | `tokens` and `usage` (`kimi_wire`) events per Kimi turn, the `tokens` window in `ahub budget`, and the count of `kimi usage unknown` notices; the live check against Kimi's `/usage` (AC11) stays opens |
| Budget window kinds and notes (#285 phase 4) | on after the release; `ahub budget`, the console peer detail, the dashboard Usage budgets row and `ahub doctor` (`kimi usage source`) run here | each window shows its kind and source, a peer without a number says why (Pi, local and Kimi included); a manual `ahub budget set` value outranks the Kimi count at the gate; the doctor row reads ok while the wire log counts |
| Settings reload | on | reloads applied, pending restarts |
| Config editing from the console and dashboard (#689) | on after release; `ahub settings edit` and console key `c` run here, the dashboard Structure group needs `ahub ui --settings`; executable keys stay console only | `config_edit` events (edits applied by tier and source), refusals shown with the loader reason, restarts left pending |
| Upgrade and recovery | on, per release | upgrade receipts in `docs/verification/` |
| Agent CLI version policy and trust (#691) | on after the release: Codex 0.163.0 verified by the [2026-10-22 receipt](verification/2026-10-22-codex-reviewer-isolation.md) and 0.164.0 by the [2026-10-24 receipt](verification/2026-10-24-codex-0164-reviewer-isolation.md); Kimi 2.3.0 and Qwen 0.26.0 verified by the [model-free receipt](verification/2026-10-22-kimi-qwen-compat.md), with account/provider live legs unverified; agy 1.4.4 in-line | model-free isolation receipts, `ahub agents` verdicts, versions trusted per machine, lead time from an `agent-compat` issue to a receipt |
| Benchmarks (#251, #637) | off: `bench.enabled = false`; routing gate pending | bench receipts |

## Decisions

- 2026-10-22: SDLC mode `advise` (`.agenthub/sdlc.toml`, machine-local). Move to `enforce` after one week of advise data, when the person decides that the false-blocker rate is low. Record the decision here.

## Weekly scorecard

Run `ahub report --dogfood --since 7d --json` against this repository's own hub before the weekly review and each release. It has the same read-only authority as `ahub report`, so the planner can produce the receipt. Save the result and its source commit under `docs/verification/dogfood/YYYY-MM-DD.md`. Run it once at the work boundary; do not create a polling loop.

- The scorecard exports ids, timestamps, counts and coverage only. PII tasks are counted without titles. GitHub reads exclude their known PRs. It never runs a model or creates an issue or task.
- `null` in JSON means unknown; the text format prints `unknown`. Source availability and completeness are separate. Partial event data is an observed subset, not a complete token bill; event, usage and attribution coverage are separate.
- Flow is scoped to at most 16 merged PRs found by a capped GitHub read. PR lead time runs from the earliest linked task proposal to the last linked task approval. Missing task links remain unknown. Review rounds reuse `costMetrics`' board handoff definition. CI reads use `head_sha=<recorded-head>&created=<since>..<until>` so unrelated weekly or lifetime runs cannot consume a PR's 100-run page. Only a fully enumerated commit/review/head SHA set is used, including when REST omits PR associations. At most eight heads per PR and 32 CI requests across the 16 selected PRs run under the shared 20 s deadline and 128 KiB response cap. Missing/truncated metadata, a failed or truncated head response, duplicate run ids, more than 100 combined PR runs or an exceeded request/deadline budget keeps that PR's CI unknown. Recent merged PRs are read first. First-pass CI needs the first run's original conclusion and a PR opened within the window; older or unknown PR opening times stay unknown because earlier runs may be outside the window. A later rerun's success does not certify the first result. Same-head reruns count actual `run_attempt - 1`, not duplicate workflows.
- Connector counts are review threads first opened by that bot after all linked tasks were approved, not a severity classification. Bug counts use explicit cross-references and the `bug` label; they show association, not proven causality, and include the observation age up to 14 days.
- Each input event/log file has a 16 MiB read cap. The board has row, per-cell and total bounds. GitHub has a 20 s deadline, a 16-PR cap, 100-node pages and 128 KiB responses. Missing, malformed or truncated evidence remains incomplete; the report does not silently call it zero.
- Digest and held counts describe retained journal rows created in the window. The journal prunes terminal rows, so these are not historical totals. It does not record the first delivery timestamp: `updatedAt` must not be used as delivery latency.
- Control latency, connection timeouts, CPU/RSS history, actual snapshot exhaustion totals and the adjudicated real-blocker rate currently have no durable source and remain unknown. Snapshot budget notices count one log diagnostic per affected burst. Error classes and advise-gate matches are fixed-pattern log counts; no raw line is exported.
- Adoption row ids are the 1-based table-row order in this document at the feature-table source commit recorded in the receipt. A matching event is evidence of that leg's use, not proof that the entire feature was enabled or correct. Rows without a dedicated observable leg stay unknown.
