---
id: supervision
type: module
title: Supervision Rules, Proposals and the Decision Path
status: draft
parent: agent-hub-architecture
depends-on: [task-board]
references: [task-board, bus]
implements: []
covers: [supervision]
tags: [agent-hub]
paths:
  - src/hub/supervision-rules.ts
  - src/hub/supervision-proposals.ts
  - test/supervision-rules.test.ts
  - test/supervision-proposals.test.ts
  - test/acon-supervision-inbox-1221.test.ts
---

# Supervision Rules, Proposals and the Decision Path

The hub already records what happens to a task: an append-only history of accepted, failed, handed-over and integrated events, its own deliverable measurement, and its own declared-overlap reading. Supervision asks a narrow question of exactly those records: does one of a closed set of conditions hold, and if so which existing hub operation would address it.

The reading stage answers that question and nothing else. It is deterministic, and it has no effect path: no proposal, no console page, no inbox entry, no worker turn, no action write, no notification. The proposals stage (#1221 T2) carries a bounded set of those readings to a present role and runs an existing action only when that role says so; what it stores and what it decides is the second half of this document.

The module is `src/hub/supervision-rules.ts` for the reading and `src/hub/supervision-proposals.ts` for the queue and the decision path. Their neighbour `src/hub/supervision.ts` turns board milestones into conductor notices and owns their batching, retry and native turns. That module is the milestone producer; these are a pure rule layer over facts already admitted to the public project view, plus the one bounded queue those readings may reach. They are not merged, and the proposal queue starts nothing by itself.

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

## Proposals and decisions

A **proposal** is one observation, kept, with its own identity and life. `src/hub/supervision-proposals.ts` owns them: the store (`supervision_proposals` in `hub.db`, `CREATE TABLE IF NOT EXISTS`, no format bump, so an older hub reads its own tables), the decision path, and the startup reconcile. It imports no board write, no bus, no daemon and no peer module; every board and bus fact reaches it through a port, which is what makes "the queue starts nothing by itself" visible in the imports and not only in prose.

Modes come from `supervision.mode`, machine-local and `off` by default:

| Mode | What it does |
| --- | --- |
| `off` | evaluates nothing; a board event costs one string comparison |
| `shadow` | stores bounded proposals on the queue and does nothing else: no inbox row, no notice, no turn, no action |
| `advisory` | the same, and may present a pending proposal in the console's existing inbox, where only an explicit accept or dismiss acts |

Observation attaches to the board events the daemon already handles, after the history entry is written, plus one reconcile pass at startup. Nothing polls and nothing is scheduled. A private or unknown task is never observed, and a `backlog` or closed task is not supervised.

**Identity and invalidation.** A proposal keeps the reading's dedupe key `(rule, task, revision, trigger)`, unique in the store, so a replayed event or a second read adds nothing and is not counted as advice. A key outlives its proposal: a reading already disposed of (accepted, dismissed or expired) is not proposed again, because the pattern it named has not changed. The queue expires what the current reading no longer produces (new input cleared the pattern, the task moved to another revision, closed, left the board, or the owner's native session was replaced), and a clipped reading, a revision longer than one rule reads, proposes nothing of its own and invalidates nothing, because a prefix proves neither.

**The decision path.** A pending proposal is decided by an explicit verb, `accept` or `dismiss`, from the hub tools (`hub_supervision_list`, `hub_supervision_accept`, `hub_supervision_dismiss`) or from the advisory inbox row. Every fence runs before any effect, in this order: the id's own grammar, an existing pending row, a present role on the task (its owner, its reviewer, the configured planner, the conductor, or the person; no new supervisor role exists), a non-private task, a non-clipped reading, the task still on the board, open and on the same revision, the same native generation it was read under, the reading still holding when re-evaluated, and no `needs_review` delivery holding the owner. A refusal about the reading expires the proposal; a refusal about the caller or the hold leaves it pending for whoever can take it up. The disposition is a compare-and-set on `state = 'pending'`, so of two deciders racing on one proposal exactly one wins and a decided proposal can never be run twice.

**What an acceptance runs.** An existing action, through that action's own authority, never a new one: `escalate` is the conductor's own move for an agent and the board's own escalation for the person, and `recheck` and `request_integration` are the hub's own notice to the owners, whose own record is the check re-run or the integration. Accepting writes nothing to the board: a board acceptance would be a new episode and would replace the acceptance that governs the revision the proposal was read under. Four records stay separate: the intent (this row's disposition, written before the action runs), the receipt (what the action reported: `ran`, `refused`, `unknown`), the task's own result (whatever the board's own method records), and a later review.

**An uncertain outcome is never retried.** An action that throws without a synchronous pre-effect refusal leaves the receipt `unknown`. A read settles such a receipt only from the board's own record of that action at or after the receipt time, and a restart settles an outcome the hub never observed as `unknown` rather than replaying it.

**Restart (AC6).** Dedupe keys, dispositions and unknown receipts all live in the table, so a restart keeps them. The one reconcile pass at startup expires pending proposals whose task moved, closed or left the board, and marks an acceptance whose action never reported as `unknown`. Nothing is replayed and nothing is retried.

**Bounds.** A proposal is a closed shape of codes and ids: rule, version, task, revision, trigger, refs, records read and whether it was clipped, the existing action, the reason code, the native generation, and later the disposition and its receipt. It carries no prose, no note, no title and no file body, and nothing about a private task reaches it.

| Bound | Value | Meaning |
| --- | --- | --- |
| `MAX_PROPOSALS` | 100 | pending proposals the queue holds; a further reading is refused, never counted as advice |
| `MAX_PROPOSALS_PER_REVISION` | 3 | proposals one task revision gets, decisions included |
| `MAX_PROPOSAL_ROWS` | 400 | terminal rows kept for dedupe and history; past it the oldest terminal row goes and a pending row is never pruned |
| `MAX_PROPOSAL_READ` | 50 | proposals one read returns, pending first |

## Deliberately outside this contract

Automatic pause, retry, cancel, reroute, approval or rollback, any automatic acceptance, any import of an external supervision runtime, and any resident worker or recurring timer. The queue proposes an existing action and runs it only when a present role says so. agent-research#63 builds on the reading and bounds above, not on an acceptance path here.
