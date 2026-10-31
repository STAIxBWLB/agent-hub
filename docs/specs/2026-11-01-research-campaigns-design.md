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

The #597 dispatch slice adds handoff-backed round advancement and budget-id-specific hard-cap admission. Until then, T1 refuses new follow-up rounds and hard-cap activation instead of silently running them without those checks. Drafts may still describe structurally valid limits. Study writes recheck recovery, shutdown and storage holds before commit; shutdown fences late screens and drains admissions within the existing bounded host-writer stop window.

The base `research_records` floor protects T1 stored state and raw runner-key compatibility. Later slices that introduce additional dispatch, wire or configuration requirements add their own recovery floors before exposing them; advertising base storage support alone is not proof of those later capabilities.

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

- A check-runner receipt (#793) supplies `host-observed` exit status (`exit`), `timedOut`, `cancelled`, duration (`duration_ms`) and receipt creation time (`createdAt`, from `created`) when an `end` event names its `run`. The hub reads `stateDir/checks/<run>.json` itself, and requires `status: "finished"`, the same task, and a `sha` equal to the protocol's `code.commit`. The receipt records no separate start or end time, so `startedAt` and `endedAt` stay `unknown` (or declared) for such an attempt. Extending the run receipt with timestamps is a separate change.
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
| Hub tools | `hub_study_draft` and `hub_study_revise` (configured planner only, through `planningAuthority`; they store drafts and never approve), `hub_study_show` (read-only; no id lists this project's campaigns as receipts), `hub_study_handoff` (bound task owner), `hub_experiment_record` (`kind`: `protocol`, `plan`, `attempt`, `event` or `receipt`; task owner), `hub_experiment_show` (read-only) | none of them approves or attests |
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
| #598 | #932 T1, AC1 and AC2 | the `research-experiments.ts` protocol (with lineage), attempt (with phase) and event schemas; the status fold; the provenance levels; the protocol, attempt and event tables; `hub_experiment_record` for protocol, attempt and event; host evidence from check receipts (exit, duration and receipt creation time only) and deliverable hashes |
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
- Host evidence from a check run covers exit status, duration and receipt creation time only; the run receipt has no start or end timestamp.

## Out of scope

#931 evidence links and claim judgment; executing, scheduling or provisioning experiments; a campaign-exclusive budget ledger; holiday calendars; new search, crawling or source providers; any third-party dependency.

## T2 dispatch and coverage implementation boundary (#597)

- `research_dispatch` is an additive recovery floor. Any stored campaign already carries stop policy intent, including a campaign activated before this slice. A target without the feature refuses while any campaign, dispatch activation or handoff exists. The base `research_records` floor remains required too. Dispatch metadata and handoff content have their own integrity digest when present.
- The latest stored revision controls every offer, planner pull, owner change and acceptance. A newer draft holds older bound work until that draft is approved; a closed or omitted unit remains held. This gate never interrupts a native turn already running. A revision cannot reauthorize a changed unit definition without a new unit id.
- Approval stores the instrumented eligible owner set for the named budget. Immediately before dispatch or an owner change, current membership, task scope and each required limit must still be proven for that same budget id. Another budget covering the task proves nothing. The existing peer-wide ledger is shared, never reset by campaign activation. Exhausted requested cells hold dispatch. A model-call cap alongside a token ceiling is unavailable because the existing meter cannot prove token usage; activation refuses it.
- A complete handoff covers every source assigned to the unit; all required structural fields remain mandatory. `insufficientEvidence` is a separate way to settle a discovery unit. New round n+1 units require stored round-n discovery bindings and complete or insufficient-evidence handoffs for each. A proposed contract cannot supply its own completion evidence.
- A study-held owner offer is persisted and re-offered after approval (#603). When a hold makes the bus discard a queued owner offer, `Tasks.relevant` writes a `research_dropped_offers` row; approving a revision re-offers each retained, still-proposed unit task through `sendTask` and clears the row once the offer is published. `research_dropped_offers` is its own additive recovery label: a target that lacks it refuses while any row exists, and a row no longer raises only the `research_dispatch` floor. The row joins the dispatch integrity digest only when rows exist.
- `Tasks.studyHandoff` accepts only the current in-progress bound owner and screens outside the transaction; stored ownership, revision, sources and flow are rechecked at the write. `Tasks.studyShow` exposes the pure projection and removes source identifiers from private views. Public tool and CLI wiring remains in #601.

## Experiment T1 implementation boundary (#598)

- The record envelope for a protocol is `{ kind: "protocol", taskId, protocol }`; `recordedForTaskId` is immutable metadata outside the protocol's content hash. A writer must be that task's current owner while it is `in_progress`. Attempt and event writes use the attempt task's current owner under the same condition. No console override is introduced by this slice.
- Both the recording task and every attempt task must be unit tasks of the protocol's same current approved campaign revision, resolved by `Board.researchDispatchBinding`. Different units in that campaign may share a protocol. Removed units, a pending draft, foreign project references and a protocol from an earlier revision refuse before effects. Protocol carry across revisions is deferred to #599.
- Protocol inputs are a subset of the campaign revision's source ids, not only the unit's source ids, and every registry hash must match exactly. A code deliverable reference must name a matching host record on the recording task. Privacy follows the task, protocol inputs and the current campaign; missing privacy evidence fails closed. All asynchronous screens, receipt reads and file hashes are followed by fresh authority, source and campaign checks; the transaction rechecks the task flow and campaign binding.
- Environment descriptors and their optional text-hash claims are always `declared`. The lexical screen rejects assignment forms, Bearer credentials and known secret shapes before writing; flagged text is refused, never stored redacted. It detects those forms only and never proves secret absence. The upgrade path is structured key/version fields or #1018 runner evidence. The hash labels the declared descriptor text; it is not a measured host environment hash.
- Output `{ id, sha256? }` is a declaration. Output `{ path, format, version? }` requests host hashing through the existing #509 reader and all its path, file-identity, deny and byte bounds. A missing, unreadable or refused path leaves the hash unknown, with no declared fallback. Output path privacy is classified independently of measurement using the #509 PII, deny and hub-state policies on both declared and resolved names. A protected path, or an unavailable classification, makes the event and whole attempt private even if hashing fails. The classification is retained across the asynchronous read. Experiment classification opts into fail-closed handling of an exhausted bounded alias-discovery budget; ordinary path-policy callers and the discovery ceiling stay unchanged. Neither record ingestion nor readback executes a command.
- Host measurements occupy separate immutable `research_attempt_observations` rows keyed by `(attempt_id, event_seq)` and linked to the declared end's run id or the output hash request's derived deliverable id. The declared event is never rewritten and no second end is created. Readback puts declared and measured values side by side with their own provenance. A check receipt must be finished and match the task and protocol commit; only exit status, timeout/cancellation, duration and its receipt creation timestamp (`createdAt`) are measured. Start/end timestamps remain unknown unless declared. The original check output and tail are not stored.
- Attempt idempotency keys are unique within the project. Event idempotency keys are likewise project-wide, bind the attempt and exact declared body, and return the original immutable event and measurements on replay. A different body refuses. Retries and reproduction links remain declared associations, never independent-reproduction claims. The all-attempt denominator includes failed, cancelled and unknown rows. Pages carry at most 50 records; the event cursor and completeness flag identify partial evidence pages.
- A private event makes the whole attempt private across every page. Public readback retains ids, counts, state and provenance while stubbing protocol text, metric names, paths and event bodies. Raw research text never enters task history, notices or memory.
- `research_experiments` is additive to `research_records` and `research_dispatch`. A target lacking it refuses while any protocol, attempt, event or observation exists. A separate content-sensitive experiment integrity digest is present only when experiment state exists. No new public tool or CLI surface, comparison/approval projection (#599), runner trust (#600) or execution engine is added here.
