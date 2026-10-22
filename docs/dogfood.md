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
| Overlap notices | on | `ahub report`: overlap warnings, task pairs; false-overlap rate (#682) |
| Planner WIP caps and backlog pull (#655) | on (`tasks.wip_limits.codex = 2`) | held-ready entries, offers refused for capacity |
| Task sweep (stalls, idle owners) | on | stall and sweep events per week |
| Turn-free coordination | off: experimental; needs a separate measured trial | coordination events, conflict notices |
| Pull-only peers (agy) | on | unread offers, empty-inbox polling (#681) |

## Review and lifecycle

| Feature | State here | Measured by |
| --- | --- | --- |
| Review brief, review findings, Important gate (#481 S3) | advise | Important findings per PR, rounds to approval |
| Spec acceptance (#481 S1) | advise | build entries without acceptance |
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
| Token usage per peer and task | partial: `ahub report`; unified view pending (#683) | tokens per merged PR |
| Context gate | off: `context.gate = 0` | context-pressure events |
| Always-ask action classes (#636) | foundation only; enforcement pending (#312, #313) | classed calls asked, budget refusals |
| Permission modes | on, person-chosen | approval prompts and their wait times |
| Pi and the local worker on DGX | off: DGX unreachable recently; Pi is off the roster | turns served on-prem, relay errors |
| PII routing | on | PII tasks and where they ran |
| Multiple Jcode instances (#685) | pending | turns per instance |

## Operations

| Feature | State here | Measured by |
| --- | --- | --- |
| Console and dashboard | on | control-request latency, connection timeouts in `hub.log` |
| Usage view (#683) | pending | its own panels |
| Settings reload | on | reloads applied, pending restarts |
| Config editing from the console and dashboard (#689) | pending; hand edits of `config.local.json` meanwhile | edits applied, refused by validation, pending restarts |
| Upgrade and recovery | on, per release | upgrade receipts in `docs/verification/` |
| Agent CLI version policy and trust (#691) | pending (PR #692); today Codex 0.163.0 and Kimi 2.3.0 are refused, agy 1.4.4 runs untested | `ahub agents` verdicts, versions trusted per machine, lead time from an `agent-compat` issue to a receipt |
| Benchmarks (#251, #637) | off: `bench.enabled = false`; routing gate pending | bench receipts |

## Decisions

- 2026-10-22: SDLC mode `advise` (`.agenthub/sdlc.toml`, machine-local). Move to `enforce` after one week of advise data, when the person decides that the false-blocker rate is low. Record the decision here.
