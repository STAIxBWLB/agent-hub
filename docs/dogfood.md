# Dogfooding: agent-hub on agent-hub

agent-hub is developed with agent-hub. This page lists every feature, whether it runs in this repository's own hub, and how its real-use behaviour and performance are measured. The tracking issue is #687.

- **State:** `on` runs here; `advise` runs and reports without blocking; `off` is available but not enabled here, with the reason; `pending` is not built yet (its issue).
- **Measured by:** the command or record that shows, from real use, whether the feature works and what it costs. The weekly scorecard (#687) collects these into `docs/verification/dogfood/`.
- **Rule:** a PR that adds or changes a user-facing feature updates its row here: whether it runs on this repository, and the metric that shows it works.

## Coordination

| Feature | State here | Measured by |
| --- | --- | --- |
| Message bus, digests, priorities | on | `ahub report`: messages, digests, overflow, undeliverable; delivery latency from events |
| Task board, routing, roles | on (claude planner and reviewer; codex, jcode, agy implementers) | board history: lead time from propose to approve, review rounds, escalations |
| Overlap notices | on; plan symbols match by normalized name (arguments stripped, a bare name matches the last segment, two qualified names must be equal; #682 phase 1b) | `ahub report`: overlap warnings, task pairs; false-overlap rate, and symbol-only matches on bare common names (#682) |
| Planner WIP caps and backlog pull (#655) | on (`tasks.wip_limits.codex = 2`) | held-ready entries, offers refused for capacity |
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
| Review brief, review findings, Important gate (#481 S3) | advise | Important findings per PR, rounds to approval |
| Spec acceptance (#481 S1) | advise | build entries without acceptance |
| Lifecycle identity linked by the hub (#694) | on in advise | tasks still showing `issue identity missing` or `PR identity missing` at review |
| Planner plan review (#481 S9) | advise | plans reviewed before build |
| Plan conformance (#481 S2) | advise | PRs with files outside the plan |
| Test integrity for bug fixes (#481 S4) | advise | bug PRs without a red-first receipt, modified pre-existing tests |
| Required checks | advise (`check (ubuntu-latest)`, `check (macos-latest)`, `seeded guards`) | first-pass CI rate, same-head reruns (`hub_sdlc_costs`) |
| Release authorization (#481 S6) | pending (#199) | releases with a receipt |
| SDLC metrics and control bands (#481 S7) | pending (#200) | its own report |
| Fresh headless reviewers (#223, #519) | off: needs an `instances` entry in the person's `config.local.json` | reviews by fresh sessions, findings they add |
| Completion checks per class | off: the implementer already runs `scripts/check.sh`; a hub-run copy would double the heavy-slot use | time to verdict when on |

## Memory and knowledge

| Feature | State here | Measured by |
| --- | --- | --- |
| Shared memory through amem, briefs, recall preface | on | notes saved per week, brief hits, fails that prevented a retry |
| `ahub ask` | on | answers with cited ids |
| Code structure in the memory graph (#684) | pending | stale anchors, briefs with related notes |

## Models, budget and safety

| Feature | State here | Measured by |
| --- | --- | --- |
| Quota budgets and pauses | on | pauses, resets, time paused (#683) |
| Token usage per peer and task | `ahub report` and, from the roll-up in `hub.db`, `ahub usage [--by peer\|task\|issue\|pr\|release\|day\|model]`, `usage limits` and `usage total` (#683 U2); console and dashboard views pending (U3, U4) | tokens per merged PR |
| Context gate | off: `context.gate = 0` | context-pressure events |
| Always-ask action classes (#636) | foundation only; enforcement pending (#312, #313) | classed calls asked, budget refusals |
| Permission modes | on, person-chosen | approval prompts and their wait times |
| Pi and the local worker on DGX | off: DGX unreachable recently; Pi is off the roster | turns served on-prem, relay errors |
| PII routing | on | PII tasks and where they ran |
| Multiple Jcode instances (#685) | pending | turns per instance |

## Operations

| Feature | State here | Measured by |
| --- | --- | --- |
| Dogfood scorecard (#687) | on after release; read-only weekly receipt | `ahub report --dogfood --since 7d --json`; bounded evidence and explicit unknowns |
| Console and dashboard | on | control-request latency, connection timeouts in `hub.log` |
| Usage view (#683) | CLI (`ahub usage`, U2) and console Usage tab `7` (U3) shipped; dashboard panel pending (U4) | its own panels |
| Settings reload | on | reloads applied, pending restarts |
| Config editing from the console and dashboard (#689) | pending; hand edits of `config.local.json` meanwhile | edits applied, refused by validation, pending restarts |
| Upgrade and recovery | on, per release | upgrade receipts in `docs/verification/` |
| Agent CLI version policy and trust (#691) | on after the release: Codex 0.163.0 verified by the [2026-10-22 receipt](verification/2026-10-22-codex-reviewer-isolation.md); Kimi 2.3.0 and Qwen 0.26.0 verified by the [model-free receipt](verification/2026-10-22-kimi-qwen-compat.md), with account/provider live legs unverified; agy 1.4.4 in-line | model-free isolation receipts, `ahub agents` verdicts, versions trusted per machine, lead time from an `agent-compat` issue to a receipt |
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
