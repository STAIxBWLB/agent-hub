---
title: Research campaigns, experiment receipts and runner attestation
date: 2026-11-01
project: agent-hub
status: frozen for implementation (task #595); slices #596 to #602
issue: 930, 932, 1018
---

# Research campaigns, experiment receipts and runner attestation

This document freezes the implementation contract for #929 R1 (#930, research campaigns), #929 R3 (#932, experiment protocols and attempt receipts) and #1018 (registered external runner). The issues hold the decisions and acceptance criteria; this spec fixes the wire names, schemas, bounds, storage and the delivery slices, so implementation does not have to invent them. Where it narrows or departs from an issue, the departure is listed in "Departures from the issues". #931 (evidence links) is out of scope.

The person directed on 2026-11-01 that #932 be implemented together with #1018. #932 depends on #930, so all three are in scope.

## Common rules

### Authority and paths

- Every board write goes through `Tasks` (AGENTS.md "Board writes"). New Tasks methods throw `PreEffectToolRefusal` before any effect, follow the existing validate, then `withholds`, then re-check order, and write history only through `board.update` or `board.plan`.
- Research roles stay catalog guidance. A unit's `purpose` grants no authority; dispatch, ownership and review use the existing routing and role admission.
- Activation, revision approval, scope or ceiling enlargement, attestation and runner registration are person only. A planner may draft and propose a revision; it cannot approve one.
- No model call and no filesystem read inside a database transaction. Screening, source lookups and file hashing run first; the transaction then re-checks revisions and writes.

### Provenance levels

A field that can be evidenced carries `{ value, provenance, evidence? }`:

| Level | Meaning | Set by |
|---|---|---|
| `declared` | An agent or a person wrote it | any record call; the default |
| `host-observed` | The hub measured it itself | a check-runner receipt the hub reads from `stateDir/checks/<run>.json`, or a deliverable hash from `hashDeliverables` |
| `runner-attested` | A registered external runner signed it | a verified #1018 receipt |
| `person-attested` | The person attested it | console-only `ahub study attest` |

- No path converts one level into another. A higher level is a new evidence row with its own source, never an update of a declared value.
- Projections show the level next to every evidenced field. `runner-attested` never renders as `host-observed`. A missing field is `unknown`, not `declared`.
- None of the levels states scientific correctness.

### Bounds

Every text field is UTF-8 and bounded. A record above its bounds refuses whole, with the field named. Shared limits: an id matches `^[a-z0-9][a-z0-9_-]{0,63}$`; a short text is at most 512 bytes and a long text at most 4 KiB; a list is at most its stated count; a whole stored body is at most 64 KiB.

### Privacy

- A campaign whose parent task is PII, or that names a private source (`SourceMeta.private`), is private. So is an attempt whose task or protocol inputs are private.
- Public views of private records keep ids, counts, states and provenance levels, and stub every question, scope, text, path, excerpt and metric name as `[pii]` (the `publicView` rule). Raw source text is never stored in a campaign, a handoff or an attempt; they reference source ids.
- Nothing from a private campaign or attempt goes to claude-mem or any cloud observer. Handoffs and attempt notes are screened through the existing public and private delivery paths.

### Recovery and features

- New daemon feature `research_records` in `DAEMON_FEATURES`. `incompatibleRecoveryTarget` refuses a target without it while `board.hasResearchState()` finds any campaign, protocol, attempt or runner-receipt row, or `research.runners` is set in config.
- The recovery `integrity()` digest gains the row counts and the latest revision of the research tables.

## T1 implementation boundary (#596)

T1 provides the bounded parser, Board storage and host Tasks methods, with no public study CLI or hub tool until #601. A write receipt carries only generated campaign ids, revision, status and unit counts; the full unit/task mapping is returned only by person-only approval. No raw contract or close reason enters parent Task history or outcome memory.

A stable unit id retains its task across approved revisions and restart, including a unit omitted from an intervening revision. T1 retains only an identical work-bearing unit definition, including its dependencies; changed work uses a fresh unit id. Existing intake or retained tasks keep their owner, reviewer, state, detail and dependencies. Incompatible dependencies or retaining a public task in a private campaign refuse whole rather than changing that task's authority. Approved omissions are recorded as counts in the parent history and remain inspectable through the immutable contracts. A replay creates nothing; it may only tighten the campaign's privacy metadata without changing body, approval time, mapping or Task history.

The #597 dispatch slice adds handoff-backed round advancement and budget-id-specific hard-cap admission (see "T2 implementation boundary (#597)"). Until it landed, T1 refused new follow-up rounds and hard-cap activation instead of silently running them without those checks. Drafts may still describe structurally valid limits. Study writes recheck recovery, shutdown and storage holds before commit; shutdown fences late screens and drains admissions within the existing bounded host-writer stop window.

The base `research_records` floor protects T1 stored state and raw runner-key compatibility. Later slices that introduce additional dispatch, wire or configuration requirements add their own recovery floors before exposing them; advertising base storage support alone is not proof of those later capabilities.

## T2 implementation boundary (#597)

T2 adds the dispatch gate, handoff-backed round advancement, the coverage and stop projection, and hard-cap admission against the existing ledger. It exposes no CLI or hub tool (that is #601): the Tasks methods `studyHandoff`, `studyProjection` and `studyDispatchHold` are host-side.

- **One gate, asked twice.** `Tasks.studyDispatchHold(taskId, owner)` reads the tables synchronously, never a request or a cache, and answers a `StudyHold` reason or nothing. `assignOwner` asks it before routing (so a held unit is not routed, offered or announced) and again immediately before the owner write, with nothing yielding between that read and the write, so an approval revoked or revised, a deadline that passed, or a budget that stopped covering while screening, plan review or routing was awaited writes nothing. A planner pull asks it inside the validation that already runs before and after its screen. That covers the offer, an explicit assign, a planner pull, a sweep or roster reassignment and an escalation, since all of them pass `assignOwner`; an owner handoff is an assignment through the same path.
- **A held dispatch.** An explicit request (a person's assign, a planner pull) refuses before any effect and names the campaign, the unit and the fixed reason. The hub's own offer or sweep leaves the task where it was, records one `study held` history entry per reason (a quiet event, like `ready held`, so it is no move) and one notice, and writes nothing again on the next tick. A unit already running is never touched: the hold applies from its next dispatch or owner change. A storage or ledger read that fails holds as `state_unreadable`: an unreadable decision never dispatches.
- **Holds, in order.** The campaign's active revision is not `approved` (superseded, closed or revoked); the unit is not in it; the deadline has passed (the deadline instant itself is expired); the unit's stored `round` exceeds `maxFollowUpRounds`; the approved revision has more units than `maxUnits`. A hard-capped campaign adds: the chosen owner is outside the stored eligible set, or the named budget no longer covers this task and owner with every hard-capped resource limited.
- **Handoffs.** `ResearchHandoffV1` is parsed by `parseResearchHandoff`, which reports every problem at once. `Tasks.studyHandoff` admits only the bound task's current owner, only while the task is in progress, only for the campaign's approved revision, screens the body like a note, re-checks all of it after the screen, and `Board.saveResearchHandoff` compares the task's flow revision in the same write. Every cited source must be in the campaign. The table is append-only (`seq`), the latest is the one coverage reads, and a corrupt row throws, so coverage never reads a guess. The receipt carries ids, the sequence and the state, never evidence or notes.
- **What a handoff amounts to.** `complete`: evidence is present. `insufficient`: an `insufficientEvidence` reason is recorded (it wins over evidence, since the unit says its own coverage is partial). `incomplete`: neither, which is a claim and closes nothing. A discovery round closes only on `complete` or `insufficient` for every discovery unit; a model's statement that it is done is not coverage.
- **Round advancement.** `studyRevise` refuses a revision that adds a unit of round n+1 while any discovery unit of round n is not closed, naming the open units. The states are read from the stored handoffs, not from the request. A round above `maxFollowUpRounds` is already refused by the contract parser. A follow-up never expands scope by itself: it exists only in a revision a person approves.
- **Hard-cap activation.** `studyApprove` refuses a requested hard cap unless the named budget exists, every capped resource has a limit, no capped resource is `tokens`, the budget is not a `task` budget (a campaign-exclusive cap), and the budget's peers intersected with the instrumented peers is not empty. That intersection is stored with the approved revision (`research_campaigns.eligible_owners`) and is the eligible owner set. The budget is read again at the write: a peer dropped or a limit removed while screening was awaited refuses the approval. No hard cap stores no set and gates no dispatch on the ledger.
- **`ExecutionBudget.covers(id, taskId, owner, resources)`.** The id-specific read the spec's "proof" asks for: the same `scopes()` read as `applies`, restricted to one budget id, true only when that budget meters this exact task and owner and limits every named resource, never for `tokens`. It reads only; there is no second ledger and no counter is ever reset or written by a campaign. `applies` answers "any budget"; a campaign needs "this budget", and a test holds the two apart.
- **Projection.** `studyProjection` is pure and returns ids, enums, counts and times only (never a question, scope, locator or note), so a private campaign shows the same shape. Per unit: its task and state, its handoff state, declared, covered and uncovered sources, the discovery sources it shares with another discovery unit (`duplicateSources`), the sources an `independent_check` unit re-checks (`reviewOf`, labelled "independent review", never a duplicate), and whether dispatch is open or held and why. Per campaign: unassigned sources, duplicate assignments, intentional independent review, rounds and whether each is closed, and the stop state (`followUp` is `available`, or held as `campaign_not_approved`, `deadline_passed`, `round_limit` or `round_open`).
- **Budget support map.** Per unit and resource: `unavailable` for `tokens` and for an owner no budget can meter, `unknown` before the unit has an owner or when the budget cannot be read, `enforceable` only when `covers` is true for that resource and it has a limit, `advisory` otherwise. The budget block says the scope (`peer-wide` for a `run` budget), `shared: true` and `campaignExclusive: false`, and shows `unknown` for token usage, never a number.
- **Shared ledger.** Two campaigns naming one budget id share one counter with each other and with unrelated work by the same peers; neither resets it. A fixture proves 2 + 1 + 2 admissions across two campaigns and an unrelated task count against one limit, survive a restart and an idempotent re-approval, and exhaust for all three with the ledger's own `exhausted` reason.
- **Recovery.** New daemon feature `research_dispatch`. `incompatibleRecoveryTarget` refuses a target without it while any research row exists, additive to the `research_records` guard (checked first, so a target with storage but no dispatch is named for dispatch). Handoffs join `board.researchIntegrity()` as an optional `handoffs` count that appears, with its rows folded into the digest after the campaigns, only when a handoff exists, so a hub with none keeps the digest it had; the restart snapshot validator knows the field and refuses an unknown research key.
- **Departures.** None from the issue. One reading choice: the projection's `followUp.reason` `round_open` reports a closed-or-not round for display only; the binding check is the one in `studyRevise`. `ponytail:` the eligible set is fixed at approval, so a peer that becomes instrumented later joins only through a new approved revision; the upgrade is recomputing it at dispatch from the ledger, which would make approval weaker than the stored contract.

## Campaigns (#930)

### ResearchCampaignV1

| Field | Type and bound |
|---|---|
| `id` | hub-issued `rc-<12 hex>`; stable across revisions |
| `parentTaskId` | existing task id in this project; at most one active campaign per parent |
| `revision` | integer from 1; each revision is immutable once stored |
| `status` | `draft`, `approved`, `superseded`, `closed` |
| `question` | long text |
| `scope` | long text |
| `exclusions` | at most 32 short texts |
| `sourceIds` | at most 64 `src:<16 hex>` ids, each known to `SourceRegistry` |
| `units` | 1 to 32 units |
| `deliverableSections` | at most 32 `{ id, title, ownerUnitId }`; each owner names one unit with purpose `synthesis` |
| `stopPolicy` | `{ maxUnits (1..32), maxFollowUpRounds (0..5), deadline (ISO time, at most 90 days after approval) }` |
| `budget` | optional `{ id (an existing ExecutionBudget id), hardCap: resources to enforce, possibly empty }`; reference ids retain the ledger's exact 1..200-character spelling rather than the new-id grammar; see "Budget support map" |

A unit: `{ id, round (integer, 0 for the initial round), question (long text), perspective (short), requiredOutput (short), sourceIds (subset of the campaign's, at most 16), dependsOn (unit ids, at most 16, acyclic, never a later round), purpose: "discovery" | "independent_check" | "analysis" | "synthesis", adoptTaskId?, taskId? }`. `adoptTaskId` names an approved intake child to bind. `taskId` is bound by the hub on activation, never supplied by a contract.

Rounds: a follow-up round is a set of units with `round = n + 1`, added only by a revision. Validation refuses a revision that adds round n+1 units while any round-n discovery unit has neither a complete handoff nor an `insufficientEvidence` reason, and refuses a round above `stopPolicy.maxFollowUpRounds`. A unit's round is stored in `research_units.round`, so the dispatch gate and restart read it rather than recompute it.

### Lifecycle

1. Draft: `Tasks.studyDraft(by, { parentTaskId, contract })` by the person (CLI `ahub study draft`) or a configured planner (`hub_study_draft`, checked with `planningAuthority`). It validates the whole contract and stores revision 1 as `draft`. A draft creates no task and dispatches nothing.
2. Revise: `Tasks.studyRevise(by, { id, revision, contract })` (`ahub study revise` or `hub_study_revise`, same authority as draft) stores revision n+1 as `draft`; `revision` must equal the latest, or it refuses as stale. A revision may enlarge scope, units or the stop policy only as a draft; only approval activates it.
3. Approve: `Tasks.studyApprove(by, { id, revision })`, person only (console role). It runs in three phases.
   - Prepare (async, outside any transaction). Validate and screen the revision's units with the same `withholds` path `Tasks.propose` uses. Resolve every source, intake child, task and dependency ref, and build one child spec per unbound unit (title, detail with a `Study: <campaign id> unit <unit id>` line, class, refs, deps). No write happens here.
   - Commit (one synchronous `board.activateCampaign(id, revision, prepared)` inside `board.atomic`, the `board.splitBacklog` precedent). It re-checks the revision is still the latest `draft` and that retained or adopted tasks still have their captured flow revisions. Previously bound stable units reuse their task ids. An intake child may be adopted only if unbound to another campaign/unit; its task is not rewritten. Only unbound person-authored units create new children with synchronous `Board.propose` as `backlog: true` cards, with deps from `dependsOn` mapped to task ids. It writes the unit-to-task mapping rows and the revision's `approved` status, and marks the previous approved revision `superseded`, all in the same transaction. If anything has changed since Prepare, it throws and nothing is written.
   - Publish (after commit). The board's ordinary post-commit change notifications go out. The new children are offered through the existing planner pull path; the campaign does not assign owners itself.
   Re-running approve on an approved revision returns the stored mapping and creates nothing. A crash between commit and publish loses nothing: the mapping and the backlog cards are committed, and the ordinary planner pull picks the cards up after restart. Restart never re-creates children.
4. Close: `Tasks.studyClose(by, { id, revision, reason })`, person or the campaign's planner. A closed campaign dispatches nothing more; its tasks keep their own states.

A person-approved revision may drop a dependency or a unit. The omission is recorded in that revision's history note. Task approval stays the only event that releases a dependent; a campaign never approves a task.

### Dispatch gate

Before the hub offers, assigns or pulls a task that is bound to a campaign unit, `Tasks` synchronously re-reads the campaign. It holds the task with a reason, and does not dispatch it, when:
- the bound revision is not `approved` (superseded, closed or revoked);
- the deadline has passed;
- the unit's stored `round` exceeds `maxFollowUpRounds`, or the approved revision's unit count exceeds `maxUnits` (both re-read from the tables, never from the request).

The check runs after any asynchronous screening, immediately before the dispatch write. Holding a task never kills a native turn already running.

### Coverage and stop projection

`studyProjection(campaign)` is pure and computes, per unit:
- its bound task's state, and whether its handoff is present and complete;
- the sources it covers, and any source assigned to more than one `discovery` unit (shown as a duplicate assignment);
- `independent_check` units, labeled as intentional independent review, never as duplicates.

Closing a discovery round needs every discovery unit to have a complete handoff, or a recorded `insufficientEvidence` reason on that unit. A model's statement that it is done is not coverage.

### Handoffs

`ResearchHandoffV1`: `{ campaignId, revision, unitId, taskId, evidence: [{ sourceId, locator (short) }] (at most 64), unresolved (at most 16 short), contradictions (at most 16 { sourceIds, note (short) }), limitations (at most 16 short), insufficientEvidence? (short) }`. It is recorded by the bound task's current owner with `hub_study_handoff` while that task is in progress. The latest handoff per unit is kept, and earlier ones stay in history. Validation reports every missing required field at once.

### Budget support map

A campaign with a `budget` shows, per unit and per resource (`model_calls`, `tool_calls`, `elapsed_ms`, `tokens`), one label:
- `enforceable` only when every condition is proven from current state:
  - the budget exists and is enabled;
  - the unit's task has an owner;
  - that owner is in the budget's `peers` and is instrumented (today `pi` and `local`);
  - the resource has a limit;
  - the scope covers the task: a `kind: "run"` budget covers every task of its peers, and a `kind: "task"` budget covers only its `taskId`. `ExecutionBudget.applies([taskId], owner)` is the proof.
- `unknown` when the unit has no owner yet, or the budget cannot be read.
- `advisory` when the scope or peer does not cover the unit; usage is shown for attribution only.
- `unavailable` for `tokens` (the ledger denies them as `unknown_usage`) and for an uninstrumented owner.

Display is not enforcement. A contract that wants enforcement says so with `budget: { id, hardCap: [resources] }` in place of the bare `executionBudgetId`. `hardCap` lists the resources that must be enforced for every unit, as stored intent, and it may be empty for an advisory-only budget. With a non-empty `hardCap`:
- Activation refuses unless all of these hold:
  - budget `id` exists and is enabled;
  - every `hardCap` resource has a limit and is not `tokens`;
  - the budget's `peers`, intersected with instrumented peers, is not empty.
  That intersection is the campaign's eligible owner set, stored with the revision.
- The dispatch gate and every owner change for a campaign-bound task make the same id-specific check immediately before the write: the offer, the assignment, a planner pull, a sweep reassignment, `hub_task_assign` and an owner handoff. The chosen owner must be in the stored eligible set, and `ExecutionBudget.applies([taskId], owner)` must include this budget `id`, with every `hardCap` resource still limited. If any part fails or cannot be read, the task is held with the reason, or the assignment is refused, and nothing is offered to an uncovered owner. A budget that is disabled or removed after activation holds every not-yet-started unit the same way.
- A unit already running when the budget changes keeps running; the hold applies from its next dispatch or owner change.

V1 uses the existing ledger as is. A `kind: "run"` budget is peer-wide, so unrelated work by those peers spends the same budget, and the projection says so. Two campaigns that name one budget share it, and neither resets it. Activation refuses a requested hard cap on an `unavailable` cell, and refuses a campaign-exclusive hard cap entirely, until the ledger gains task membership in a separate reviewed change. Stop and budget limits block new dispatch only.

## Experiments (#932)

### ExperimentProtocolV1

Stored by content: `protocolHash = sha256(canonical JSON of the body)`.

| Field | Type and bound |
|---|---|
| `campaignId`, `campaignRevision` | an approved campaign revision in this project |
| `claimIds` | at most 32 ids (free ids until #931 defines claims) |
| `inputs` | at most 64 `{ sourceId, sha256 }`; the hash must equal the registry's |
| `code` | `{ commit: 40 hex }` or `{ deliverable: { id, sha256 } }` |
| `environment` | `{ descriptor (long text), hash? (64 hex) }`; variable names allowed, values refused |
| `method` | long text |
| `parameters` | at most 64 keys; values are scalars or lists of at most 64 scalars |
| `seeds` | at most 256 integers |
| `evaluator` | `{ id, version, hash? }` |
| `metrics` | at most 32 `{ name, unit, direction: "higher" | "lower" }` |
| `role` | `baseline` or `variant`, with `variantOf?` (a protocol hash) |
| `splits` | at most 16 short ids |
| `resourceLimits` | at most 16 `{ name, value, unit }` |
| `sealed` | `declared` boolean; verified only by a runner receipt (below) |

Every protocol also carries `lineage` (a short id, stable across revisions of one experiment) and `supersedes?` (the previous protocol hash in that lineage). A protocol is immutable, so a change is a new protocol with a new hash.

Protocol approval:
- `ahub study approve-protocol <hash>` is person only (console role). It writes one `research_protocol_approvals` row: `(protocol_hash, evaluator_hash, approved_by, at)`.
- An approval applies to exactly that protocol hash, and to that evaluator identity hash (sha256 of the canonical `evaluator` object).
- A changed protocol has a new hash and so no approval. Nothing copies an approval forward.
- Consumers:
  - The comparison projection marks a pair `approved` only when both protocols have approvals.
  - `hub_experiment_show` shows each attempt's protocol as `approved` or `unapproved`.
  - Recording against an unapproved protocol is allowed, and shown as such.

### Comparison plan

`ComparisonPlanV1`, also stored by hash: `{ campaignId, fixed: { inputs, splits, evaluator, metrics }, varying: subset of ["code", "parameters", "seeds", "role"], rule: { kind: "tolerance", value } | { kind: "test", name (short), alpha } }`. Two attempts compare under a plan only when their protocols match every `fixed` field exactly and differ only in `varying` fields. Otherwise the projection names the first differing field and marks the pair incompatible; it still shows both. The hub never declares a best result.

### ExperimentAttemptV1

- `attemptId`: hub-issued `ra-<12 hex>`. `idempotencyKey`: caller-supplied, at most 64 bytes, unique per project. A second record call with the same key and the same body returns the existing attempt; the same key with a different body refuses.
- `protocolHash`, `taskId` (an existing task in this project), and optional `retryOf` or `reproducesAttemptId`. A retry is always a new attempt linked by `retryOf`; `reproducesAttemptId` is declared and never set by the hub.
- Every attempt has `phase: "development" | "final"`, set when it is created and never changed. A `final` attempt is the evaluation of record for its protocol.
- Each event carries `{ seq, kind, provenance, body, at }`, where `at` is the hub's time of recording. The kinds:
  - `start`: `{ startedAt? }`, declared unless host evidence supplies it.
  - `end`: `{ status: "succeeded" | "failed" | "cancelled", exitStatus?, reason? (short), run? (a check-runner run id) }`. At most one per attempt; a second `end` refuses.
  - `metric`: `{ name, value }`. The name must exist in the protocol's `metrics`.
  - `output`: deliverable claims. If the hub hashes them through `hashDeliverables`, they are `host-observed`; declared hashes stay `declared`. An inaccessible file is `unknown`.
  - `note`: short text.
  - `attestation`: a verified runner receipt or a person attestation.
- Status is a pure fold over the events:
  - `declared` with no `start` and no `end`;
  - `running` after `start` and before `end`;
  - the `end` status once there is an `end`;
  - `unknown` when there is no `end` and the attempt's task is approved, cancelled or closed.
- Post-hoc: a protocol is marked `post-hoc` when, at its recording time, its lineage already has a `final` attempt with an `end` event. That is, it was written after a final evaluation of an earlier protocol in the same lineage. The projection reads only `seq` and the recording order, so the fold is deterministic.
- Failed, cancelled and unknown attempts stay in every all-attempt count. Task approval and experiment success are separate fields.

### Host evidence

- A check-runner receipt (#793) supplies `host-observed` exit status (`exit`), `timedOut`, `cancelled`, duration (`duration_ms`) and queue time (`created`) when an `end` event names its `run`. The hub reads `stateDir/checks/<run>.json` itself, and requires `status: "finished"`, the same task, and a `sha` equal to the protocol's `code.commit`. The receipt records no separate start or end time, so `startedAt` and `endedAt` stay `unknown` (or declared) for such an attempt. Extending the run receipt with timestamps is a separate change.
- Output hashes are host-observed only when the hub hashed the file.
- An agent-supplied hash is never host evidence.

## Runner attestation (#1018)

### Registration

```
"research": { "runners": { "<name>": { "publicKey": "<base64 Ed25519 SPKI DER>", "projects": ["<projectId>", ...], "revoked": false } } }
```

- This block lives only in the untracked `.agenthub/config.local.json`. A tracked or shared file naming it throws at load, the `checks.remote` precedent.
- It is added to `ALL_MACHINE_LOCAL` and is a structural tier-2 key for `ahub settings edit`. Its writes are person only.
- `name` follows the id rule. At most 16 runners.
- Revocation sets `revoked: true`. The key is kept, so old receipts still show who signed them, but a revoked key verifies nothing new.
- The hub stores no private key.

### AttemptReceiptV1

The runner signs `"agent-hub.runner-receipt/v1\0" + canonical JSON of the receipt body` with Ed25519. The hub verifies with `node:crypto`.

The body is `{ receiptId, runner, projectId, attemptId, protocolHash, codeCommit, imageDigest, containers: [{ id, role: "candidate" | "evaluator" | "other" }], mounts: [{ container, path, readOnly }], network: "none" | "restricted" | "open", resourceLimits, startedAt, endedAt, exitStatus, outputs: [{ name, sha256 }], metricsFile?: { name, sha256 } }`.

Verification refuses before any write when any of these holds:
- the runner is unknown or revoked;
- `projectId` is not in the runner's `projects`;
- the signature fails;
- the attempt is missing, in another project, or bound to a different `protocolHash`;
- the receipt is over its bounds.

Each mount also carries `purpose: "evaluator-code" | "evaluator-data" | "candidate-output" | "other"`.

A verified receipt appends one `attestation` event, and its fields are `runner-attested`. `sealed` becomes verified only when every condition holds:
- at least one container has role `candidate` and at least one has role `evaluator`, and their ids are disjoint and unique;
- every mount's `container` names a listed container;
- at least one mount has purpose `evaluator-code` or `evaluator-data` and is on an evaluator container;
- every `evaluator-code` and `evaluator-data` mount is `readOnly`, and none of them is on a candidate container.

Missing, empty or inconsistent isolation evidence leaves `sealed` declared or unverified, never verified.

A receipt with a known `receiptId` and identical bytes is a no-op. The same `receiptId` with different bytes refuses.

### Delivery

- Agents relay receipts with `hub_experiment_record { kind: "receipt", receipt, signature }`. The signature, not the caller, is the authority, so any task owner may relay.
- The person may also run `ahub study receipt <file>`.
- The hub never contacts the runner.

## Storage

All new tables live in `hub.db`, created in the `Board` constructor with `CREATE TABLE IF NOT EXISTS`. Writes use `board.atomic`.

| Table | Key | Content |
|---|---|---|
| `research_campaigns` | `(id, revision)` | status, parent task id, body JSON, body sha256, approved_by, approved_at |
| `research_units` | `(campaign_id, revision, unit_id)` | round, task id, purpose, adopted (boolean) |
| `research_protocol_approvals` | `(protocol_hash)` | evaluator hash, approved_by, at |
| `research_handoffs` | `(campaign_id, unit_id, seq)` | task id, body JSON, by, at |
| `research_protocols` | `hash` | campaign id and revision, body JSON, by, at |
| `research_plans` | `hash` | campaign id, body JSON, by, at |
| `research_attempts` | `attempt_id`, unique `(project, idempotency_key)` | protocol hash, task id, phase, retry_of, reproduces, by, at |
| `research_attempt_events` | `(attempt_id, seq)`, unique `receipt_id` when present | kind, provenance, body JSON, at |

`board.hasResearchState()` reports whether any row exists. Readback is paginated: at most 50 rows per call, with a cursor.

## Wire names

| Surface | Name | Who |
|---|---|---|
| CLI | `ahub study draft <parent> <contract.json>`, `study revise <id> <revision> <contract.json>`, `study approve <id> <revision>`, `study close <id> <revision> --reason`, `study show [<id>] [--json]`, `study experiments [--campaign <id>] [--json]`, `study attest <attempt> <field> <value>`, `study receipt <file>` | approve, attest and receipt are person only; draft and revise are person or planner; show is anyone |
| Hub tools | `hub_study_draft` and `hub_study_revise` (configured planner only, through `planningAuthority`; they store drafts and never approve), `hub_study_show` (read-only), `hub_study_handoff` (bound task owner), `hub_experiment_record` (`kind`: `protocol`, `plan`, `attempt`, `event` or `receipt`; task owner), `hub_experiment_show` (read-only) | none of them approves or attests |
| CLI (person only) | `ahub study approve-protocol <hash>` | person |
| Control | `study` (console role, CLI only) | person |
| Feature | `research_records` | recovery gate |
| Config | `research.runners` | untracked config.local.json only |

`ahub research`, the opt-in telemetry command, is unchanged.

## Delivery slices

Each slice amends this spec in its own PR if it must differ, and updates `docs/dogfood.md`. All of them touch `tasks.ts` or `board.ts`, so they run one at a time on those files.

| Task | Issue and ACs | Scope |
|---|---|---|
| #596 | #930 T1, AC1 and AC2 | the `research-campaign.ts` schema and validation (rounds included); the campaign and unit tables; `studyDraft`, `studyRevise`, the three-phase `studyApprove` with `board.activateCampaign`, and `studyClose`; intake adoption; the replay, crash-between-commit-and-publish and restart tests; the `research_records` feature gate |
| #597 | #930 T2, AC3 and AC4 | the dispatch gate on stored rounds; round advancement validation; the coverage and stop projection; the budget support map with its `applies` proof; the stored `hardCap` intent and eligible owner set, with refusal at activation and the id-specific check at every dispatch and owner change (offer, assign, pull, sweep reassign, handoff); the two-campaign shared-ledger fixture |
| #598 | #932 T1, AC1 and AC2 | the `research-experiments.ts` protocol (with lineage), attempt (with phase) and event schemas; the status fold; the provenance levels; the protocol, attempt and event tables; `hub_experiment_record` for protocol, attempt and event; host evidence from check receipts (exit, duration and queue time only) and deliverable hashes |
| #599 | #932 T2, AC3 and AC4 | comparison plans and compatibility; the protocol approval table and `ahub study approve-protocol` with its consumers; idempotency and retry linkage; the post-hoc marking by lineage |
| #600 | #1018, AC1 to AC5 | the `research.runners` config; `research-runner.ts` receipt verification; receipt delivery; the sealing rule with its negative cases (no evaluator, empty mounts, a dangling container ref, an evaluator mount on a candidate); fixtures with a test key pair |
| #601 | #930 T3, AC5 and AC6 | `ahub study` draft, revise, approve, close and show; `hub_study_draft`, `hub_study_revise`, `hub_study_show` and `hub_study_handoff`; the privacy stubs; role guidance in `templates/`; the three-source, two-peer example |
| #602 | #932 T3, AC5 and AC6 | `ahub study experiments`, `attest` and `receipt`; `hub_experiment_show`; the synthetic CPU-only fixture; the rerun checklist in `docs/profiles.md` |

## Departures from the issues

- Runner registration is person only in V1. #1018 proposed "the person or conductor". A public key is a trust root, so the conductor path is deferred until a reviewed change gives it the same confirmation as other trust settings.
- Claim ids in a protocol are free ids until #931 defines claims; they are not validated against a claim store.
- `ahub study attest` covers `person-attested` fields. #932 names a "person attestation" without a command.
- `hub_study_handoff`, `hub_study_draft` and `hub_study_revise` are new tools. #930 lists only `hub_study_show`, but a handoff needs a write path that is not a task completion, and a planner needs a draft route that is not the person-only CLI.
- Protocol approval is the person-only `ahub study approve-protocol`; #932 asks for approvals bound to hashes without naming the operation.
- The budget support map adds an `unknown` label for a unit with no owner yet, since enforceability depends on the owner peer.
- Host evidence from a check run covers exit status, duration and queue time only; the run receipt has no start or end timestamp.

## Out of scope

#931 evidence links and claim judgment; executing, scheduling or provisioning experiments; a campaign-exclusive budget ledger; holiday calendars; new search, crawling or source providers; any third-party dependency.
