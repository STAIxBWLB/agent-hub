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

## Campaigns (#930)

### ResearchCampaignV1

| Field | Type and bound |
|---|---|
| `id` | hub-issued `rc-<12 hex>`; stable across revisions |
| `parentTaskId` | existing task id in this project; at most one active campaign per parent |
| `revision` | integer from 1; each revision is immutable once stored |
| `status` | `draft`, `approved`, `superseded`, `closed` |
| `question` | long text |
| `scope`, `exclusions` | long text; exclusions at most 32 short texts |
| `sourceIds` | at most 64 `src:<16 hex>` ids, each known to `SourceRegistry` |
| `units` | 1 to 32 units |
| `deliverableSections` | at most 32 `{ id, title, owner unit id }`; each section has exactly one synthesis owner |
| `stopPolicy` | `{ maxUnits (1..32), maxFollowUpRounds (0..5), deadline (ISO time, at most 90 days after approval) }` |
| `executionBudgetId` | optional existing `ExecutionBudget` id |

A unit: `{ id, question (long text), perspective (short), requiredOutput (short), sourceIds (subset of the campaign's, at most 16), dependsOn (unit ids, at most 16, acyclic), purpose: "discovery" | "independent_check" | "analysis" | "synthesis", taskId? }`. `taskId` is bound by the hub on activation, never supplied for a person-authored unit.

### Lifecycle

1. Draft: `Tasks.studyDraft(by, { parentTaskId, contract })` by the person or a configured planner. It validates the whole contract and stores revision 1 as `draft`. A draft creates no task and dispatches nothing.
2. Revise: `Tasks.studyRevise(by, { id, revision, contract })` stores revision n+1 as `draft`; `revision` must equal the latest, or it refuses as stale. A revision may enlarge scope, units or the stop policy only as a draft; only approval activates it.
3. Approve: `Tasks.studyApprove(by, { id, revision })`, person only (console role). In one `board.atomic` it:
   - re-checks the revision is the latest and still `draft`, and that every source, task and dependency ref still resolves in this project;
   - binds units to tasks: a unit that adopts an approved intake child gets that child's id (from the intake family); every other unit gets a new ordinary child created through the existing propose path, with `after` set from `dependsOn` mapped to task ids;
   - stores the unit-to-task mapping in the same transaction as the revision's `approved` status, and marks the previous approved revision `superseded`.
   Re-running approve on an already approved revision returns the stored mapping and creates nothing. Restart reads the mapping and never re-creates children.
4. Close: `Tasks.studyClose(by, { id, revision, reason })`, person or the campaign's planner. A closed campaign dispatches nothing more; its tasks keep their own states.

A person-approved revision may drop a dependency or a unit. The omission is recorded in that revision's history note. Task approval stays the only event that releases a dependent; a campaign never approves a task.

### Dispatch gate

Before the hub offers, assigns or pulls a task that is bound to a campaign unit, `Tasks` synchronously re-reads the campaign. It holds the task with a reason, and does not dispatch it, when:
- the bound revision is not `approved` (superseded, closed or revoked);
- the deadline has passed;
- the unit is a follow-up round beyond `maxFollowUpRounds`, or the unit count exceeds `maxUnits`.

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

A campaign with `executionBudgetId` shows, per peer and per resource (`model_calls`, `tool_calls`, `elapsed_ms`, `tokens`):
- `enforceable` for an instrumented peer (today `pi` and `local`) on a resource the ledger counts;
- `advisory` for attribution only;
- `unavailable` for tokens (the ledger denies them as `unknown_usage`) and for an uninstrumented peer.

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

A protocol is immutable. A change is a new protocol with a new hash. A person approval of a protocol binds its hash and its evaluator hash, so a changed protocol needs a new approval.

### Comparison plan

`ComparisonPlanV1`, also stored by hash: `{ campaignId, fixed: { inputs, splits, evaluator, metrics }, varying: subset of ["code", "parameters", "seeds", "role"], rule: { kind: "tolerance", value } | { kind: "test", name (short), alpha } }`. Two attempts compare under a plan only when their protocols match every `fixed` field exactly and differ only in `varying` fields. Otherwise the projection names the first differing field and marks the pair incompatible; it still shows both. The hub never declares a best result.

### ExperimentAttemptV1

- `attemptId`: hub-issued `ra-<12 hex>`. `idempotencyKey`: caller-supplied, at most 64 bytes, unique per project. A second record call with the same key and the same body returns the existing attempt; the same key with a different body refuses.
- `protocolHash`, `taskId` (an existing task in this project), and optional `retryOf` or `reproducesAttemptId`. A retry is always a new attempt linked by `retryOf`; `reproducesAttemptId` is declared and never set by the hub.
- Status is folded from append-only attempt events: `declared`, `running`, `succeeded`, `failed`, `cancelled`, `unknown`. An attempt with no terminal event is `unknown` once its task is closed.
- Each event carries `{ seq, kind: "start" | "end" | "metric" | "output" | "note" | "attestation", provenance, body, at }`.
  - Metrics: `{ name, value, provenance }`, where the name must exist in the protocol.
  - Outputs: deliverable claims hashed by the host through `hashDeliverables` (`host-observed`), or declared hashes (`declared`). An inaccessible file is `unknown`.
- A metric or parameter changed after a `final` evaluation event exists for the same protocol lineage is marked `post-hoc`.
- Failed, cancelled and unknown attempts stay in every all-attempt count. Task approval and experiment success are separate fields.

### Host evidence

- A check-runner receipt (#793) supplies `host-observed` start, end, exit status and duration when an `end` event names its `run`. The hub reads `stateDir/checks/<run>.json` itself and requires `status: "finished"`, the same task and a commit equal to the protocol's `code.commit`.
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

A verified receipt appends one `attestation` event. Its fields are `runner-attested`. `sealed` becomes verified only when every evaluator mount is `readOnly` and no container is both `candidate` and `evaluator`; otherwise it stays declared.

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
| `research_units` | `(campaign_id, revision, unit_id)` | task id, purpose |
| `research_handoffs` | `(campaign_id, unit_id, seq)` | task id, body JSON, by, at |
| `research_protocols` | `hash` | campaign id and revision, body JSON, by, at |
| `research_plans` | `hash` | campaign id, body JSON, by, at |
| `research_attempts` | `attempt_id`, unique `(project, idempotency_key)` | protocol hash, task id, retry_of, reproduces, by, at |
| `research_attempt_events` | `(attempt_id, seq)`, unique `receipt_id` when present | kind, provenance, body JSON, at |

`board.hasResearchState()` reports whether any row exists. Readback is paginated: at most 50 rows per call, with a cursor.

## Wire names

| Surface | Name | Who |
|---|---|---|
| CLI | `ahub study draft <parent> <contract.json>`, `study revise <id> <revision> <contract.json>`, `study approve <id> <revision>`, `study close <id> <revision> --reason`, `study show [<id>] [--json]`, `study experiments [--campaign <id>] [--json]`, `study attest <attempt> <field> <value>`, `study receipt <file>` | approve, attest and receipt are person only; draft and revise are person or planner; show is anyone |
| Hub tools | `hub_study_show` (read-only), `hub_study_handoff` (bound task owner), `hub_experiment_record` (`kind`: `protocol`, `plan`, `attempt`, `event` or `receipt`; task owner), `hub_experiment_show` (read-only) | none of them approves or attests |
| Control | `study` (console role, CLI only) | person |
| Feature | `research_records` | recovery gate |
| Config | `research.runners` | untracked config.local.json only |

`ahub research`, the opt-in telemetry command, is unchanged.

## Delivery slices

Each slice amends this spec in its own PR if it must differ, and updates `docs/dogfood.md`. All of them touch `tasks.ts` or `board.ts`, so they run one at a time on those files.

| Task | Issue and ACs | Scope |
|---|---|---|
| #596 | #930 T1, AC1 and AC2 | the `research-campaign.ts` schema and validation; the campaign and unit tables; `studyDraft`, `studyRevise`, `studyApprove` and `studyClose`; intake adoption; the replay and restart tests; the `research_records` feature gate |
| #597 | #930 T2, AC3 and AC4 | the dispatch gate; the coverage and stop projection; the budget support map with the two-campaign shared-ledger fixture |
| #598 | #932 T1, AC1 and AC2 | the `research-experiments.ts` protocol, attempt and event schemas; the provenance levels; the protocol, attempt and event tables; `hub_experiment_record` for protocol, attempt and event; host evidence from check receipts and deliverable hashes |
| #599 | #932 T2, AC3 and AC4 | comparison plans and compatibility; review invalidation on a changed hash; idempotency and retry linkage; the post-hoc marking |
| #600 | #1018, AC1 to AC5 | the `research.runners` config; `research-runner.ts` receipt verification; receipt delivery and the sealing rule; fixtures with a test key pair |
| #601 | #930 T3, AC5 and AC6 | `ahub study` draft, revise, approve, close and show; `hub_study_show` and `hub_study_handoff`; the privacy stubs; role guidance in `templates/`; the three-source, two-peer example |
| #602 | #932 T3, AC5 and AC6 | `ahub study experiments`, `attest` and `receipt`; `hub_experiment_show`; the synthetic CPU-only fixture; the rerun checklist in `docs/profiles.md` |

## Departures from the issues

- Runner registration is person only in V1. #1018 proposed "the person or conductor". A public key is a trust root, so the conductor path is deferred until a reviewed change gives it the same confirmation as other trust settings.
- Claim ids in a protocol are free ids until #931 defines claims; they are not validated against a claim store.
- `ahub study attest` covers `person-attested` fields. #932 names a "person attestation" without a command.
- `hub_study_handoff` is a new tool. #930 lists only `hub_study_show`, but a handoff needs a write path that is not a task completion.

## Out of scope

#931 evidence links and claim judgment; executing, scheduling or provisioning experiments; a campaign-exclusive budget ledger; holiday calendars; new search, crawling or source providers; any third-party dependency.
