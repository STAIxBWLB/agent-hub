---
id: supervision
type: module
title: Supervision Rules and the Shadow Evaluator
status: draft
parent: agent-hub-architecture
depends-on: [task-board]
references: [task-board, bus]
implements: []
covers: [supervision]
tags: [agent-hub]
paths:
  - src/hub/supervision-rules.ts
  - test/supervision-rules.test.ts
---

# Supervision Rules and the Shadow Evaluator

The hub already records what happens to a task: an append-only history of accepted, failed, handed-over and integrated events, its own deliverable measurement, and its own declared-overlap reading. Supervision asks a narrow question of exactly those records: does one of a closed set of conditions hold, and if so which existing hub operation would address it.

This stage answers that question and nothing else. It is deterministic, it is off unless a caller evaluates it, and it has no effect path: no proposal, no console page, no inbox entry, no worker turn, no action write, no notification. A later stage may carry an observation to a person; this one only proves the reading.

The module is `src/hub/supervision-rules.ts`. Its neighbour `src/hub/supervision.ts` turns board milestones into conductor notices and owns their batching, retry and native turns. That module is the milestone producer; this one is a pure rule layer over facts already admitted to the public project view. They are not merged, and the rule layer is not wired to the feed here.

## Facts the rules may read

One evaluation takes three fact sets, all authored by the hub, never by a peer or a model:

- **task revisions**: an id, a state and the task's structured history (event name, time, check key, plan revision, `evidenceOnly`, `noWrites` and delivered record ids). A note, a withheld body, a review finding or a transcript is not in the fact type and cannot be reached from it.
- **deliverable measurement**: the hub's own `deliverableStatus` reading per task: whether it measured the files, and which delivered ids it now reads as changed or missing. Ids and states, never a file body.
- **declared overlap**: the hub's own `overlapHits` rows, one row per unordered pair.

Nothing is read from a private task, a cloud observer or a native transcript, and the module imports no board write, bus, daemon, peer or memory module. A source-string test in `test/supervision-rules.test.ts` fails if a clock, a timer, an emit path, `process.env` or one of those imports appears, so the purity is proven mechanically and not only asserted.

## Revision identity

An observation binds to a work attempt, not to a history length. A revision is the number of owner episodes (`accepted`, `reassigned`, `escalated`, `reopened`) and the host-authored plan revision, written as `<episodes>:<plan>`; the current attempt starts at the record after the last episode event or plan revision, whichever is later. Unrelated bookkeeping (a check result, a quiet entry) therefore cannot split one pattern into two, and replaying the same records cannot move an observation to a different revision. A plan revision starts an attempt of its own: failures recorded under the previous plan are not read as this plan's and cannot pair with one recorded under the new plan.

The acceptance that governs a revision is the last one before it. An acceptance is an episode event, so an acceptance recorded inside the attempt would have opened a new one; a plan revision keeps the acceptance because the same owner continues, which can leave the acceptance before the attempt's first record. A hand-over clears it: a reassignment, escalation or reopen hands the work to another attempt, and the previous owner's acceptance no longer covers it. The overlap rule depends on both boundaries.

## Rules

Each rule has an id, a version, one reason code and one suggested existing action. The version is part of an observation: bump it when the trigger, the refs or the meaning of a reason changes, so a stored observation states the contract it was made under.

**`repeated_failure` (version 1, reason `repeated_failure`, action `escalate`).** Two equal classified failures inside the current revision, with no clearing evidence between them. A failure is classified into a closed vocabulary: `check:<checkKey>`, `review:changes_requested`, `integration:unresolved`, `done:no-writes`. A code-scope rejection that names no finding (`evidenceOnly`) is not a defect of the work and is not classified. Clearing evidence is a recorded check pass, a landed integration or an approval; each resets the streak. One observation is made per class, so a revision failing two different checks reports both and only the per-revision bound can refuse one. Trigger: `failures:<class>`; refs: the two failure records.

**`deliverable_invalidated_check` (version 1, reason `stale_check`, action `recheck`).** The revision recorded a check pass and delivered at least one record, and the hub's own measurement now reads one of those delivered ids as changed or missing. Trigger: `check:<ids>`; refs: the check record and the stale deliverable ids. A delivered id is the only thing that can be stale: a file the hub measured but that this revision never delivered is not evidence about it. If the hub did not measure the files, the rule cannot decide and reports the gap `no-deliverable-measurement` instead of a clean reading.

**`declared_overlap_without_integration` (version 1, reason `unintegrated_overlap`, action `request_integration`).** A declared pair whose both sides have accepted their current revision, with no integration request, landed integration or recorded integration failure after either acceptance, and with neither side closed. Persistence is record-based, never elapsed time. Trigger: `overlap:<low>:<high>`, bound to the pair's lower task id so naming the pair in either direction is the same observation; refs: the other task and both acceptance records.

Ordinary progress triggers nothing: a passing check, an unequal pair of failures, a cleared streak, an evidence-only rejection, a closed task, a pair that recorded one integration attempt. Elapsed silence is never a trigger by itself: no rule reads a clock, and a record set read two days later reads identically.

## Unknown coverage is an output, never a zero

A rule that cannot decide says so with a **gap**: rule id, version, task, revision and one of `no-history`, `no-deliverable-measurement`, `history-truncated`. A revision longer than one rule reads is read as a prefix, and every rule that saw only the prefix reports `history-truncated`; a pair naming a task outside the fact set reports `no-history`. An overlap whose clipped window shows no integration evidence reports `history-truncated` instead of an observation, because integration may sit past the prefix. Gap and observation are separate lists, so "nothing fired" and "nothing could be decided" can never be mistaken for each other.

## Bounds

| Bound | Value | Meaning |
| --- | --- | --- |
| `MAX_RECORDS` | 64 | records one rule reads from one revision; a longer revision is a prefix and reports `truncated` |
| `REPEAT_FLOOR` | 2 | equal classified failures before the repetition rule fires: the first is an incident, the second a pattern |
| `MAX_REFS` | 8 | record refs one observation may carry |
| `MAX_OBSERVATIONS` | 100 | observations and gaps one shadow supervisor retains |
| `MAX_PER_REVISION` | 3 | observations one supervisor retains per rule, task and revision |

The retention bounds count what they refuse instead of storing it, so a bound never reads as "nothing to report". A refused observation or gap increments `suppressed` and is not kept; a gap that still cannot be retained on a later evaluation is refused and counted again rather than silently dropped.

## The shadow evaluator contract

`ShadowSupervisor.observe(facts)` evaluates, keeps only what is new, and returns the observations it added. An observation is deduplicated by `(rule, task, revision, trigger)`: a replayed fact set, a duplicate event or a third equal failure adds nothing and increments `deduped`. Retention is bounded and ordered by that key for observations and by `(rule, task, revision, reason)` for gaps, and the counters are `evaluations`, `observations`, `deduped`, `suppressed` and `gap`.

Shadow mode has no effect path at all, and the counters are the literal type zero: `workerTurns: 0`, `actionWrites: 0`, `notifications: 0`. A non-zero value would not typecheck, so AC2 is a property of the type and not only of a fixture. There is no resident worker and no recurring timer; evaluation attaches to events a caller already has.

An observation is a closed shape of codes and ids: rule, version, task, revision, trigger, refs, limits (records read and whether they were truncated), the suggested existing action and the reason code. It carries no prose, no note and no file body.

## Deliberately outside this contract

Bounded proposals and their accept/dismiss decision path, a console or tool surface, inbox presentation, advisory delivery, automatic pause, retry, cancel, reroute or rollback, and any import of an external supervision runtime. Those need their own authorization and their own spec. agent-research#63 builds on the reading and bounds above, not on an acceptance path here.
