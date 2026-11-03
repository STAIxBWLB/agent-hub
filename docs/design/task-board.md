---
id: task-board
type: module
title: Task Board
status: draft
parent: agent-hub-architecture
depends-on: []
references: [bus, adapters]
implements: []
covers: [task-board]
tags: [agent-hub, dogfood]
paths:
  - src/hub/tasks.ts
  - src/hub/sdlc-metrics.ts
  - src/hub/board.ts
  - src/hub/routing.ts
  - src/hub/task-sweep.ts
  - src/hub/settled-roles.ts
  - src/hub/conductor.ts
  - src/hub/supervision.ts
  - src/hub/hub-tools.ts
  - src/hub/tool-refusal.ts
  - src/hub/review-brief.ts
  - src/hub/review-scope.ts
  - src/hub/reviewer-pool.ts
  - src/hub/reviewer-pool-config.ts
  - src/hub/release-admission.ts
  - src/hub/main-checkout.ts
  - src/hub/checks.ts
  - src/hub/task-repository.ts
  - src/hub/no-writes.ts
  - src/hub/review-findings.ts
  - src/hub/workflow.ts
  - src/hub/deliverables.ts
  - src/hub/deliverable-files.ts
  - src/hub/plan-conformance.ts
  - src/hub/sdlc-merge.ts
  - src/hub/sdlc-mirror.ts
  - src/hub/ci-watch.ts
  - src/hub/research-campaign.ts
  - src/hub/research-experiments.ts
  - src/hub/research-runner.ts
  - src/hub/task-approval.ts
  - src/hub/schedules.ts
  - src/hub/folder-trigger.ts
  - src/hub/handoff.ts
  - src/cli/handoff-args.ts
  - src/cli/handoff-output.ts
  - src/hub/task-list-page.ts
---

# Task Board

The task board is the shared record of work and its authority, not a transcript of peer claims. This module refines [[agent-hub-architecture]] and separates task transitions from [[bus]] delivery and [[adapters]] runtime facts. Current operational rules are in the [task area note](../agent-notes/tasks.md); the [historical ledger](../specs/2026-09-19-agent-hub-design.md) retains earlier decisions.

## Authority and state

`Tasks` mediates task proposals, planning, owner/reviewer changes, acceptance, completion and review. `Board` persists the rows, history and typed evidence in SQLite; transport, CLI and UI layers do not independently apply task transitions. The issue remains the change spec and GitHub remains authority for PR/check/tag facts. Separating these authorities prevents a chat claim or adapter callback from bypassing task policy ([#481](https://github.com/STAIxBWLB/agent-hub/issues/481)).

A command is authorized against the current actor, role, task state and revision. An asynchronous operation can lose authority while preparing evidence, so write boundaries recheck current scope. Console actions bind the selected task ID and its observed flow revision, rather than an unstable list position. The reason is to keep an approved action attached to the row and state the person actually saw ([#424](https://github.com/STAIxBWLB/agent-hub/issues/424), [#525](https://github.com/STAIxBWLB/agent-hub/issues/525)).

Owner, reviewer and planner are distinct responsibilities. A reservation or offer is not acceptance; a completed delivery is not task completion. A saved assignment and the attempt to notify its recipient also remain separate facts, so failed notification cannot erase a committed role change or manufacture a second one ([#297](https://github.com/STAIxBWLB/agent-hub/issues/297), [#525](https://github.com/STAIxBWLB/agent-hub/issues/525)).

## Selection and admission

`routing.ts` selects candidates as a pure function over declared policy and current facts. `Tasks` applies admission and writes through the same selection rules used by route explanation. Roster, roles, privacy, availability, capability evidence and WIP remain explicit inputs, which prevents explanations and actual offers from becoming separate policies ([#525](https://github.com/STAIxBWLB/agent-hub/issues/525), [#418](https://github.com/STAIxBWLB/agent-hub/issues/418)).

Automatic offer and backlog paths respect `plannedStart`; a future card becomes eligible at its boundary through existing sweep/release passes. Explicit person/planner authority is separate. This avoids offering scheduled work early without taking away deliberate manual control ([#1076](https://github.com/STAIxBWLB/agent-hub/issues/1076)).

Urgent acceptance can reclaim only enough unaccepted, unstarted, non-pinned and non-urgent offers to fit the limit. It does so after other admission checks and immediately before the accept write; if insufficient, it reclaims none. Accepted work is never displaced merely to satisfy a new urgent request, because an offer and an active commitment have different costs ([#1080](https://github.com/STAIxBWLB/agent-hub/issues/1080)).

Untouched returns may atomically update `reserved` while moving eligible proposed or accepted work back to Backlog. `Tasks` retains the existing authority, execution-evidence, pin, release and reservation gates, including post-screen rechecks. An explicit reservation patch advances planning revision and records its prior value in the same state/history write, before capacity publication can trigger auto-pull. Clearing it therefore parks the card; omitting fields preserves its planning. Assignment and auto-pull selection remain the existing rules, with no time-based suppression ([#1154](https://github.com/STAIxBWLB/agent-hub/issues/1154)).

## Source-backed plans and request intake

For a profile that supports `plan.sources`, `Tasks` validates every retained source ID against the source registry at proposal and acceptance, before board writes, admission effects or peer notices. Unknown IDs are refused with the ID and `ahub source list` guidance. Overlap notices compare the registry IDs; private task plans remain withheld by the shared public view.

Natural-language intake from the CLI or dashboard enters the same `Tasks.intake` path and creates held draft Backlog cards, not offers. Dashboard task replies use the public view, and a ticket-bound live-test session cannot create these person-attributed drafts. Approval and discard retain their existing authority. Read-only source snapshots carry only ID, kind, byte size, hash prefix and registration time, with no content or origin paths ([#1144](https://github.com/STAIxBWLB/agent-hub/issues/1144)).

## Completion, review and evidence

Completion binds the submitted full head and any verified deliverable records. It may run a configured check before requesting review. A review records a verdict against that evidence; it does not itself merge a PR. An unmerged approved task can receive a new owner submission, superseding the earlier review binding rather than treating old approval as authority for changed code ([#1047](https://github.com/STAIxBWLB/agent-hub/issues/1047)). A re-file cannot silently inherit an old head after the linked PR moves, and an approval with no supplied head refuses known-stale evidence. Refusals name the recorded and supplied or read heads and direct the owner to re-file `hub_task_done` with the new full SHA in `refs.commit`; summary text is not head evidence. This prevents stale approval from being presented as review of changed code ([#1121](https://github.com/STAIxBWLB/agent-hub/issues/1121)).

Review independence and declared scope are different controls. Selection excludes conflicts using current implementation history; a `code` reviewer supplies code findings, while full test/CI proof belongs to the merger's gate. Evidence-only inability to run tests is not a code defect. This keeps valuable sandboxed review without inventing CI evidence or accepting self-review ([#744](https://github.com/STAIxBWLB/agent-hub/issues/744), [#852](https://github.com/STAIxBWLB/agent-hub/issues/852)).

Task text and private-turn words can reach owners, reviewers, overlap notices and memory. Public views use the host's current privacy projection; PII tasks remain stubs for unauthorized observers, and private turns cannot write ordinary shared task text. The projection belongs at the shared boundary because filtering individual callers would leave another observer exposed ([#198](https://github.com/STAIxBWLB/agent-hub/issues/198), [#230](https://github.com/STAIxBWLB/agent-hub/issues/230)).

## Read models and policy extensions

Agent list reads return bounded, newest-updated compact pages built from public rows, with a keyset cursor and explicit detail/ID reads. Console compatibility is separate. Pagination is not a frozen snapshot during concurrent edits; its purpose is bounded communication without bypassing private-row projection ([#1083](https://github.com/STAIxBWLB/agent-hub/issues/1083)).

Lifecycle policy can be off, advisory or enforced; this is separate from always-applicable role and privacy invariants. Plans, cost/check scope, review findings and external evidence retain their own typed provenance. Research campaigns and experiments likewise distinguish declared, host-observed and runner-attested facts instead of promoting prose to a signed result ([#481](https://github.com/STAIxBWLB/agent-hub/issues/481), [#932](https://github.com/STAIxBWLB/agent-hub/issues/932), [#1018](https://github.com/STAIxBWLB/agent-hub/issues/1018)). Detailed research contracts remain in the [campaign design](../specs/2026-11-01-research-campaigns-design.md).

When the specs policy is enabled, covering design specs participate in proposal/accept notices and completion/review reports. Report mode informs; require mode needs an updated spec or a recorded acknowledgement for each applicable unchanged spec. Commitless and verified no-change work remains quiet, and private evidence is withheld rather than exposed to satisfy a report. These modes preserve owner choice while making design drift visible ([#1064](https://github.com/STAIxBWLB/agent-hub/issues/1064)).
