---
id: guidance-probes
type: module
title: Fake-Only Guidance Probe Admission
status: draft
parent: agent-hub-architecture
depends-on: [guidance-experiments, task-board]
references: [adapters, execution-reference]
implements: []
covers: [guidance-probes]
tags: [agent-hub, dogfood]
paths:
  - src/hub/guidance-probes.ts
  - src/hub/guidance-probe-store.ts
  - src/hub/tasks.ts
  - src/hub/operational-authority.ts
  - src/hub/daemon.ts
  - src/hub/control-client.ts
  - src/hub/restart.ts
  - src/cli/main.ts
  - src/cli/help.ts
  - test/guidance-probes.test.ts
  - test/guidance-probes-control.test.ts
  - test/guidance-probes-recovery.test.ts
  - test/fakes/guidance-probe-provider.ts
  - src/adapters/local-worker.ts
  - src/local/probe-types.ts
  - src/adapters/local-probe.ts
  - src/local/probe-workspace.ts
  - src/local/probe-sandbox.ts
  - src/local/tools.ts
  - src/local/sandbox.ts
  - src/omniroute/client.ts
  - test/guidance-probe-local-worker.test.ts
  - test/guidance-probe-input-matrix.test.ts
  - test/guidance-probe-sandbox.test.ts
  - test/omniroute.test.ts
---

# Fake-only guidance probe admission

This draft defines the #1226 T1 manifest, private ledger and host admission boundary. It is a contract proposal for review before implementation. T1 can exercise the boundary with constructor-injected fixture ports. Production has no probe runner and refuses execution before reserving an active lane or session slot. Registration is an inert private declaration, not permission to execute.

No #1226 task authorizes a real worker, model or live experiment. A later confined worker implementation, receipts, cleanup and any live admission require their own accepted contract. A fake launch result proves fixture behavior only. It cannot attest native confinement, served model identity, usage, quiescence, cleanup or improvement.

This feature does not activate guidance, edit roles, complete tasks, record review outcomes, train or select models, route ordinary work, or feed memory, capture, progress or learning. The host stamps `guidance_probe` purpose; it does not impersonate a PII task or reviewer to obtain exclusions. Existing LocalPeer, adapters, sandbox and ExecutionBudget behavior remains unchanged.

## Manifest and units

`GuidanceProbeManifestV1` is a closed, inert JSON record. All containers have own enumerable data properties only; unknown keys, accessors and unsupported values refuse. Parse errors disclose a fixed reason and next step, never task bodies or raw manifest content. The parser does not read files, resolve references, call models or grant authority.

The proposed manifest fields are:

- `v: 1`.
- `projectKey` and `experimentId`: nonempty opaque identifiers, at most 256 UTF-8 bytes and 256 UTF-16 code units, using the existing execution-reference identifier grammar. They are private identities, not paths or instructions.
- `task`: exact task id, creation epoch and recorded flow revision. Integers are nonnegative safe integers; task ids and epochs retain the owning Task contract.
- `role`: role id, layer and frozen baseline SHA-256. Its current catalog identity must independently match at admission.
- `inputs`: exact SHA-256 commitments and UTF-8 byte lengths for retained private task input, fixed baseline context, explicit data/role policy and system policy snapshots. `codeTree` is a native Git tree OID with its object format: 40 lowercase hexadecimal characters for SHA-1 or 64 for SHA-256. It is not silently recast as a SHA-256 content digest. A commitment is not proof that content was safely materialized.
- `runtime`: exact runtime, toolset and model-configuration hashes. There are no commands, executable paths, URLs, runner selectors, credentials or config overlays.
- `model`: `requested` and `expectedServed`, each exactly `qwen27b/qwen3.8-27b`. No slash splitting, normalization, fallback or alias resolution is permitted. An absent or different observed served value makes the observation incomparable.
- `guidance`: the frozen catalog baseline identity and exact guidance SHA-256. Candidate worker slots bind separately admitted existing G1 content ids at start, after their preregistered proposal or compose stage; initial candidate hashes are not required before those authoring stages.
- `improverContextHash`, optional: a frozen experience SHA-256 commitment available only to explicitly declared proposer/composer inputs, paired with `improverContextBytes`. It is not a worker input channel.
- `slots`: an ordered closed plan of at most nine attempts: required baseline and candidate1 worker attempts, at most four total `worker` attempts and at most five total editor attempts, with role caps of two `proposal`, one `compose`, one `select` and one `reflect`. Editors are optional, including a zero-editor baseline/preexisting-candidate comparison. Each slot has an opaque unique id, role and arm/stage binding; array position is its ordinal. `retryOf`, when present, names an earlier compatible slot. Each slot is one attempt, including a failed attempt, and every retry also counts against its role cap.
- `limits`: aggregate model calls, tool calls and elapsed milliseconds; optional aggregate token limit; and `inputBytes`, `scratchBytes`, `outputBytes` storage reservations. Values are nonnegative safe integers. The three storage reservations sum to at most 1,073,741,824 bytes (1 GiB), checked without unsafe addition. There is no new experiment-count cap or arbitrary maximum on the other declared budgets.
- `taskOrderSeed`, optional: ordering metadata only. It is never represented as a model sampling seed.

All SHA-256 values are exactly 64 lowercase hexadecimal characters, with an explicit length check. The canonical manifest limit is 32,768 UTF-8 bytes, a new V1 format contract. This is a serialization bound, not a model or spending budget. Raw snapshots are private, retained separately and charged against the declared input reservation; they are not public manifest/status fields.

## Closed V1 schema

The following interfaces list every accepted key. Type aliases describe runtime validation, not TypeScript-only assurances. Every string is valid Unicode without forbidden controls; opaque identifiers use the existing execution-reference grammar. Optional properties must be absent or valid, never present with `undefined`. Arrays are dense, own data-property arrays. Parsers check serialized/raw byte ceilings before walking nested elements.

Opaque identifiers are not task/context text grammar. Text snapshots may contain code and LF/CR/TAB, which are preserved byte-for-byte without trimming or newline normalization. Malformed Unicode and other control characters refuse; G1 editable-prose restrictions do not apply to these snapshots.

```ts
type ProbeSha256 = string; // Exactly 64 lowercase hex characters.
type ProbeId = string; // Nonempty, <=256 UTF-8 bytes and UTF-16 units.
type ProbeInteger = number; // Nonnegative safe integer, no coercion.
type ProbeTree =
  | { objectFormat: "sha1"; oid: string } // Exactly 40 lowercase hex.
  | { objectFormat: "sha256"; oid: string }; // Exactly 64 lowercase hex.
interface ProbeSnapshotRef { sha256: ProbeSha256; bytes: ProbeInteger }
interface ProbeRoleIdentity {
  id: ProbeId;
  layer: "shipped" | "project";
  baselineSha256: ProbeSha256;
}
type ProbeArm = "baseline" | "candidate1" | "candidate2" | "successor";
type ProbeStage = "baseline" | "proposal1" | "candidate1" | "proposal2"
  | "candidate2" | "compose" | "successor" | "select" | "reflect";
type ProbeSlot = {
  id: ProbeId;
  stage: ProbeStage;
  role: "worker" | "proposal" | "compose" | "select" | "reflect";
  arm: ProbeArm | "none";
  retryOf?: ProbeId;
};
interface GuidanceProbeManifestV1 {
  v: 1;
  projectKey: ProbeId;
  experimentId: ProbeId;
  task: { id: number; created: ProbeInteger; flowRevision: ProbeInteger };
  role: ProbeRoleIdentity;
  inputs: {
    task: ProbeSnapshotRef;
    baselineContext: ProbeSnapshotRef;
    dataPolicy: ProbeSnapshotRef;
    systemPolicy: ProbeSnapshotRef;
    codeTree: ProbeTree;
  };
  runtime: {
    runtimeSha256: ProbeSha256;
    toolsetSha256: ProbeSha256;
    modelConfigSha256: ProbeSha256;
  };
  model: {
    requested: "qwen27b/qwen3.8-27b";
    expectedServed: "qwen27b/qwen3.8-27b";
  };
  guidance: { baselineSha256: ProbeSha256 };
  improverContextHash?: ProbeSha256;
  improverContextBytes?: ProbeInteger;
  slots: readonly ProbeSlot[];
  limits: {
    modelCalls: ProbeInteger;
    toolCalls: ProbeInteger;
    elapsedMs: ProbeInteger;
    tokens?: ProbeInteger;
    inputBytes: ProbeInteger;
    scratchBytes: ProbeInteger;
    outputBytes: ProbeInteger;
  };
  taskOrderSeed?: ProbeInteger;
}
```

Task id is a positive safe integer; `created` and `flowRevision` follow the existing Task epoch/revision contract. Baseline uses the current catalog role id/layer/baseline hash, not a fabricated no-change G1 variant. The catalog baseline hash and `guidance.baselineSha256` are separate commitments: catalog identity versus exact rendered baseline guidance. The latter is computed from the retained current baseline, not inferred from an id. Candidate/successor bindings require an existing G1 variant id, candidate SHA-256, current task epoch/flow and the same current catalog baseline.

Registration carries a closed private envelope with exactly `{ manifest, snapshots }`. `snapshots` has exactly `task`, `baselineContext`, `dataPolicy`, `systemPolicy`, and optional `improverContext`. Its presence exactly matches both optional manifest keys `improverContextHash` and `improverContextBytes`; either all three are present and agree or all are absent. Text snapshots are exact UTF-8 strings; the data policy is canonical JSON with the closed shape below. Each snapshot has a 32,768-byte per-row ceiling, a new V1 bound separate from the manifest format bound. All retained snapshot bytes must fit the combined `limits.inputBytes` reservation, including retained baseline guidance, late-bound candidate guidance and any retained prepared frames; duplicate stored copies are charged for their actual retained bytes. G1 role snapshots retain their stricter existing 8 KiB ceiling. Oversize or insufficient combined reservation refuses before writes, never trims. No omitted/unavailable policy snapshot is accepted merely because its hash is present. None of these private snapshots appear in public status.

The derived registration serialization ceiling is `manifestBytes + policyBytes + 4 * 2 * snapshotBytes + envelopeScaffoldBytes`. The four text snapshots can each expand by at most two for JSON escaping because only LF/CR/TAB, quotes and backslashes require escaping among their admitted characters; malformed Unicode and other controls refuse. `envelopeScaffoldBytes` is computed from the exact closed empty envelope, not guessed from a caller budget. This ceiling applies to the combined envelope, not separately admitted 32 KiB components. The host baseline binding has its own bounded record; session-row JSON is bounded by four record ceilings (host binding, child binding, last effect and fixed session metadata). Each component is validated within its own ceiling before composing that session row. SQL applies the appropriate per-column/per-session cap before parsing, never an accidental 32 KiB cap to the whole registration or session. Recovery hashes bounded components incrementally rather than canonicalizing an entire experiment into a single 32 KiB buffer.

```ts
interface ProbeDataPolicyV1 {
  v: 1;
  allowedWrites: readonly { root: "scratch" | "output"; relative: ProbeId }[];
  admittedData: readonly { id: ProbeId; sha256: ProbeSha256; bytes: ProbeInteger }[];
  roles: {
    worker: { dataIds: readonly ProbeId[]; guidanceOnlyExperience: true };
    proposal: { dataIds: readonly ProbeId[]; improverContext: boolean };
    compose: { dataIds: readonly ProbeId[]; improverContext: boolean };
    select: { dataIds: readonly ProbeId[]; anonymizedDeliverables: true };
    reflect: { dataIds: readonly ProbeId[]; closedRoundOnly: true };
  };
}
interface ProbePrivateSnapshots {
  task: string;
  baselineContext: string;
  dataPolicy: ProbeDataPolicyV1;
  systemPolicy: string;
  improverContext?: string;
}
interface ProbeRegistrationV1 {
  manifest: GuidanceProbeManifestV1;
  snapshots: ProbePrivateSnapshots;
}
```

The policy snapshot explicitly declares writes, admitted data and each role's data membership. Ids are unique; every role data id names an admitted entry. Relative write names are lexical declarations, not resolved paths: absolute paths, parent traversal, empty components and NUL/control characters refuse. The snapshot's byte ceiling bounds list cardinality; no separate historical experiment cap is added. Parsing and hashing do not resolve addresses, inspect Git objects or claim confinement. Later materialization must independently enforce these declarations.

`guidanceProbeManifestKey` hashes the canonical parsed manifest with a versioned domain separator. Canonicalization has fixed property order, preserves slot order and exact admitted string bytes, and omits absent optional fields. The content id excludes time, mutable status, actor/session authority and any tested flag. Registration additionally binds the actual host actor privately. A matching hash never substitutes for current host admission.

Actual `workerEffectiveInputHash`, observed non-guidance input hash, served model and usage are observations. They cannot overwrite frozen manifest commitments or be manufactured from requested values. The worker hash covers only exact worker-visible input-frame bytes; host reservation tokens, experiment/arm/slot ids and accounting callbacks are not model-visible bytes. Frozen editor `improverContextHash` is separate and cannot be substituted for the worker input hash. Fake observations remain explicitly fixture observations.

## Input separation and comparability

The ledger declares which inputs a role may receive. It does not claim to enforce OS or native worker confinement in T1.

| Role | Permitted declared input | Excluded input |
| --- | --- | --- |
| Worker | Current bound task, fixed baseline context, one admitted guidance slot | Direct experience, other arm outputs, selector/evaluator material, operator/control receipts |
| Proposer/composer | Task, bounded permitted source references and closed probe artifacts; separately declared frozen improver context | Hidden rubric, future corpus, live homes, Git object stores, other undeclared sources |
| Selector | Anonymized deliverables and declared permitted task sources | Arm identity, hidden evaluator/rubric and control receipts |
| Reflector | Closed-round evidence | Future rounds and undeclared experience |

A retrieval-only control, if declared, renders through the same guidance slot; it cannot add a worker side channel. Baseline and candidate fake input frames compare exact non-guidance bytes. A declared frame, path or worktree name is not proof of materialization or confinement. The later worker contract must establish those facts independently.

Unknown, missing or mismatched fixed inputs, model identity, runtime/toolset/config, usage coverage or role-input coverage cannot be presented as a comparable result. Unknown usage and cost are not zero. No sampling or monetary claim is inferred from request metadata. A token-limited effect cannot proceed when the required token accounting is unavailable.

## Authority and currentness

All writes and effects enter through Tasks. CLI and daemon only parse, authenticate and delegate; they never open a writable ledger. The declaration cannot name an actor, session or authority override. Minimal T1 register/start/show/cancel access is limited to the person or the one currently configured authorized conductor, using the existing operational-authority admission path. A console delegation, ordinary peer or live-test session cannot borrow USER authority.

Tasks' private bridge reuses its current request/private/review/recovery fences, requires the unique configured conductor to remain rostered and inside an admitted operational context, and uses the current public Task/repository scope before source reads. New snapshot text passes existing pure nameable/secret checks. G1 is rendered first, then the exact sanitized rendered guidance actually handed off passes raw nameable/secret checks plus first-party lexical path-candidate/private-policy checks; its private raw role-file provenance is not screened as worker input. Unlike an opaque address field, actual prose such as "merge/release" is not private solely because it contains a slash under an unrelated deny rule. A candidate matching private lexical policy or its literal prefix refuses. This is a lexical screen, not alias discovery or confinement proof. Raw candidate SHA remains separate metadata. No new model, file/address resolver or generation path is added. Historical metadata show does not return raw snapshots. Narrowing cancellation does not rescreen stored prose or require a still-applicable G1, while retaining its specified current caller/Task-epoch/privacy fences.

Tasks captures and revalidates project identity, actual actor/roster/conductor currentness, peer identity, session generation/native session, current task epoch/flow and privacy/review-only context across every await and immediately before each write or fake effect. A private turn or private/PII task refuses before content leaves its existing private boundary. Unknown or missing current proof refuses with a next step.

Private session generation is an exact bounded identifier string or nonnegative safe integer, matching the existing Peer contract without coercion/hash/default zero. The daemon mints a per-connection UUID for each authenticated console or tools connection, never a control token or daemon-wide person epoch. For console requests, that UUID is both `sessionGeneration` and `requestConnectionId`. A conductor captures its actual Peer generation/native session and the original live socket fence, plus the separate connection UUID comparator. Tasks captures a host-only `guidanceProbes.session(by)` context with generation/nativeSession/requestConnectionId/current callback at admission; that callback closes over the original request/socket authority, rather than consulting a later request's ambient context. A new connection for either caller cannot replay a prior connection's start CAS, even when the conductor's native session is unchanged. The IDs are durably stored only as private replay comparators; they never restore or attest live authority.

The host-only `TasksDeps.guidanceProbes` dependency contains Store, optional fakePorts/editor-frame preparer, session context reader and optional timer.set/clear seam. There is no corresponding config/wire runner, session or timer selector. `guidanceProbesPending()` counts owned in-process admissions/launch/stop/drain work, not persisted held lanes; zero does not prove unknown durable work quiescent. `stopGuidanceProbes()` aborts and requests stop only for captured owned reservation/generation, then awaits actual launch and stop settlements. Its named operational 5,000 ms bound rejects with cause/next step on a noncooperative fixture, retains unsettled handles and durable hold, and never claims zero/drained, refunds/releases or closes Store/Board beneath callbacks. A later explicit drain can finish once those actual promises settle. Daemon awaits it before its finally-bearing cleanup/stopped-notification path; a rejected drain is retryable explicitly while new admissions remain fenced.

Only active owned fake work has one watchdog: named operational interval 250 ms, scheduled with `setTimeout(min(interval, remainingMs))`. It rechecks the captured currentness/clock; nonpositive remaining time aborts/stops without rescheduling, and cancel/finish clears the handle. Small chunks avoid the JavaScript long-timeout overflow without a new manifest duration cap. Timer handles are wrapped with an explicit absence sentinel so valid zero/null handles clear correctly. A stale callback checks active-map identity before any Store write/effect. Tests inject the host-only scheduler/clock, never a global clock, and explicitly release/drain noncooperative fixture promises in cleanup.

New registration and session start require an already accepted task in `in_progress` or `changes_requested`. There is no implicit assignment/acceptance, no generic MOVES change, and no bypass of existing Task, role, SDLC or operational guards. Historical show is separate from fresh applicability.

Admission requires the current catalog role/baseline to match the frozen commitment and the selected existing G1 to remain current and unwithdrawn. Historical availability is not applicability. Probe admission cannot create another owner's G1, substitute USER or the owner as the caller, or obtain applicability by trusting a manifest field. An internal host-only predicate may inspect the existing private G1 binding under the probe's actual authorized actor; it grants no G1 write authority.

Registration is checked for current admission before deduplication. A stale duplicate does not turn an old declaration into a current permit. A duplicate with the exact current immutable identity returns the existing closed receipt, without a new lane, slot or launch grant. A conflicting declaration refuses. Cancellation intent and historical terminal records never resurrect.

Each reserved session retains its original start selector: requested experiment CAS revision, selected slot, child variant (or null), actual actor and captured session identity. After full fresh actor/Task/G1/privacy/review/operational admission, exact replay of that selector returns the retained experiment receipt with `already: true`, without another grant, bind, launch or counter/revision change. It remains recognizable while reserved/running, after later effects/settlement and after reopening the store. Diagnostic queued time is excluded. Changed actor/session authority or selected variant refuses rather than rebinding. Stored identity is a replay comparator, never current authority or an attestation.

Tasks may use the host-private bounded `startSelector(key, requestedRevision)` read to select the original slot/child for fresh source-owner G1 revalidation. It must not use today's next planned slot for a historical replay, and must perform current caller/Task outer admission before this lookup. Withdrawn/changed original G1 or a now-closed Task can therefore refuse a replay even though the historical selector exists. No new wire operation, public raw snapshot or history scan is introduced.

Cancellation relaxes only frozen flow equality and current G1 applicability to narrow already-owned existing work. It retains current person/configured-conductor authority, session, project, Task epoch, privacy/review-only and operational guards. It persists intent, never launches or releases. Cleanup of an already-owned fake handle after a fence is lost is a separate host duty, not a new caller privilege.

The private `cancelRequested` boolean records admitted intent independently of receipt state, strictly stored as SQLite integer 0 or 1. Once true it survives holds, unknown settlements, stop and reopen; it is digest-covered and never reset/refunded. New grants refuse it, while an exact historical replay can only return an already/held receipt. Cancellation of an already terminal experiment is a no-op and must not turn a false flag true or claim new intent. The closed public status may expose the boolean to explain a held cancellation; write receipts do not echo actor/body/snapshots. Earlier unreleased private prototype fixture databases with incompatible fields fail closed and must be recreated explicitly by their fixture owner, not silently migrated/erased; no public database marker is bumped.

Known input/authority refusals before the first Board/store write may be PreEffectToolRefusal. Storage, hydration, readback and unknown wrapped errors remain plain fixed safe errors, including rollback failures. After a reservation, an unknown outcome is never described as safely retryable.

## Private storage and atomic admission

`GuidanceProbeStore` opens the same hub.db through `openHubDatabase`, retaining its schema preflight and named busy timeout. It creates additive private tables only; it does not bump the database marker or spread fields into Task/public Board records.

- `guidance_probe_manifests`: immutable canonical declaration, binding, private actor, lifecycle revision and fixed aggregate counters/unknown flags, keyed by project and manifest id, with `UNIQUE(projectKey, probeExperimentId)` binding that private experiment id to exactly one root manifest forever.
- `guidance_probe_lanes`: one row per project, pointing to the retained experiment/session owner and generation.
- `guidance_probe_sessions`: at most nine preregistered slot rows per experiment, with session CAS revision, state, fixed counters and one current/last effect descriptor.

`BEGIN IMMEDIATE` atomically checks the project lane, experiment/session revisions and legal transition, then reserves the slot and aggregate resource counters before `fakeLaunch`. Failed and retried attempts consume their declared slot and resource reservations. There are no refunds, per-arm resets or implicit retries. No more than one session runs at a time, including editing/reflection sessions. An exact duplicate returns the persisted state and never authorizes a second effect.

A changed manifest hash under the same project/probe experiment id refuses rather than creating fresh four/five-attempt or call budgets. A separately preregistered experiment id can declare a separate repetition; there is no global experiment-count cap. Probe experiment identity is independent from a selected G1's experiment id. Selection still requires the same Task epoch/current flow and current catalog baseline.

The elapsed ceiling is wall time since the first session reservation/admission, including editor attempts, failures, gaps and downtime. Its persisted high-water never decreases or resets per arm. Clock regression or uncertain elapsed coverage holds admission. This is an admission ceiling, not measured model time or monetary cost.

The Store owns a trusted constructor-injected clock (Date.now by default, fixture clock only in tests). It samples inside each critical section after the write-lock and synchronous currentness callback, immediately before granting. A queued input timestamp is diagnostic only. The persisted/granted effect descriptor contains the actual admission sample, and usage/settlement must correlate that returned descriptor. A model-only session does not require tool quota; a tool is charged/refused only when requested by runEffect. Zero remaining model/session/time/input capacity cannot bootstrap another session.

Immediately before fake launch or invocation of a freshly granted effect, the host checks abort and calls Store `checkInvocation(reservation, revalidate)` for a fresh locked clock/currentness/deadline check, then checks abort again without an intervening await. Known exhausted time cannot launch work, and an already-consumed grant is not refunded. Phase2 runtime also owns the remaining experiment deadline, abort propagation and stop of in-flight work; Phase1 does not claim real worker timers, quiescence or hard native time enforcement merely because the next call is gated.

Each session retains only its current/last effect: generation, monotonic sequence, unit, amount, descriptor hash, pending/settled/unknown state and usage-applied identity. Exact replay returns state without an effect grant. Older, future or conflicting descriptors refuse. An unresolved or uncertain effect blocks the next sequence and holds its reservation. Late, unknown or unattributed usage sets a sticky unknown flag; it cannot silently reduce totals or become zero. Storage admission covers inputs, scratch and output together.

`admitEffect` runs its actual-actor/Task/G1/session/privacy revalidation callback inside its own `BEGIN IMMEDIATE`, after acquiring the write-lock, not merely before waiting for it. A model-call admission atomically reserves its declared token amount too when a token ceiling applies; lack of the required amount refuses before the effect. An already granted attempt can be settled/accounted after authority is lost as narrow host bookkeeping, but no further effect is admitted without the full fresh fence.

Queries are exact-key indexed reads. Session hydration selects at most ten rows (nine plus a corruption sentinel), with SQL raw JSON byte checks before parsing. There is no public historical scan, caller-selected budget or state-scope override. No historical experiment-count cap is introduced.

Recovery integrity streams ordered experiment keys, then exact-key session rows with the same ten-row sentinel and bounded per-row memory; orphan/duplicate/malformed state is not silently ignored. Missing legacy tables represent no probe state. Present but unreadable/incomplete state refuses recovery rather than manufacturing a clean ledger.

The manifest/session/lane/orphan passes share one SQLite read transaction and therefore one coherent snapshot. Every lane read uses the same typed, byte-bounded SQL projection, including validity bits that distinguish a legitimate NULL slot from an oversized/invalid field projected to NULL. Project, manifest and non-null slot identifiers must parse, resolve to their retained records and agree with state; corrupt references never masquerade as a free lane.

`ponytail:` recovery integrity is O(historical experiments + sessions), with sessions bounded by nine per experiment, not constant-time. If measured recovery time warrants an upgrade, add keyset paging and a separately reviewed verification budget; do not silently truncate this scan or invent a new refusal budget in T1.

## Lifecycle and fake effect boundary

The lifecycle distinguishes an inert declaration, reserved/active fixture work, cancellation/closing intent, closed fixture observation and unknown-held state. The final enum and allowed transitions are closed in the parser/store. A closed fixture observation is not a native success receipt.

Production permits inert registration under the current privileged gates. Start checks runner absence before any active lane/session/resource reservation or late-binding write. Fake ports are injected only through host test constructors, never selected by wire data, CLI options, project config, imports or a model id. The port types are defined here independently, without importing the protected routing ports or routing implementation.

An admitted fake session receives a host-created reservation token and bounded fixture input. Before invocation Tasks checks the reservation CAS and all current fences again. Completion is accepted only for that generation/session/effect identity. Pending work participates in the daemon's existing stop/recovery drain. Cancellation first persists narrowing intent and aborts owned pending work, then requests fixture stop; missing stop proof retains the lane. Restart, uncertain launch, cancellation or stop never auto-respawns, releases a lane or erases counters.

The fake launch additionally receives host-created callbacks bound to exactly that reservation and the actual caller's captured/current authority. They are separate function arguments, never part of worker input or wire data. The Tasks-private `runEffect` wrapper checks the sequence/descriptor, calls atomic store admission with the synchronous fresh fence, consumes a fresh grant once, and only then invokes the supplied fake effect. An existing replay returns persisted state without invoking it. The provider receives no Store, actor override or reusable raw grant. Correlated numeric usage and settlement flow back through this wrapper's private bookkeeping; a posthoc `usage: "known_fixture"` label cannot establish coverage.

Before replacing the last descriptor, every granted model attempt must have a matching numeric usage observation or the experiment becomes sticky unknown. Unknown/missing usage, conflicting observations and unattributed/late observations never clear that flag or become zero. A fake effect throwing or losing authority does not undo its reservation. The wrapper records the owned attempt's known result/unknown coverage before returning or rethrowing a safe error, without admitting another effect.

Both a proposal-produced candidate and a composed successor bind an already existing, separately current admitted G1 to their next preregistered worker slot. `start(id, revision, variantId?)` takes a variant id only for that next unbound non-baseline worker slot. Tasks reads and validates the existing private G1, then the store atomically binds its immutable child commitment and reserves the session in the same transaction. No separate bind operation or caller-selected slot exists. A bound slot rejects a conflicting variant; its exact duplicate never grants another launch. No child can alter task/tree/fixed input/model/config/toolset/runtime/limits or append a slot. G1 creation remains the owner/person's separate authority; model text never selects or admits its own record.

The fixed graph orders baseline worker, optional proposal1, candidate1 worker, optional proposal2, optional candidate2 worker, optional compose, optional successor worker, optional select, then optional reflect. An included proposal/compose stage requires its corresponding candidate/successor worker; a preexisting candidate2/successor need not invent an editor stage. Stage role/arm pairs and their order are fixed. A known-failure retry may occupy only an additional preregistered compatible slot immediately following the failed attempt, consuming the same role cap and aggregate budget. No successful attempt can be repeated for statistical sampling, and an ambiguous attempt cannot be replaced/retried. `start` advances only one explicit eligible slot; it is not an autonomous orchestrator. Controlled authoring requires a closed, comparable in-lane editor session with a matching RAW G1 candidate-file artifact hash, never a supplied flag or rationale. External or ordinary G1 authoring remains admissible if otherwise current, but uncontrolled with unknown cost, never fully measured or zero cost.

Fixture completion follows each failed-known attempt's bounded, preregistered adjacent retry chain until its terminal known success, including multiple consecutive failures within the same four/five limits. Every failed outcome and consumed counter remains recorded. After known success only its own adjacent preregistered retries become distinct terminal `not_needed` records, with no generation, launch, resource or budget charge. The read view derives a separate not-needed count; these are never failures. This does not start the next stage: a new explicit start selects the next planned non-retry stage.

An exhausted known-failure chain with no remaining compatible retry ends the experiment as `failed_fixture` and releases its lane without launching later stages. Unstarted later stages remain planned records, not fabricated failures or successful work; that terminal experiment cannot start them. When every required stage is covered by known success (possibly after failures/retries) and any unused retries are not-needed, the experiment ends `closed_fixture` and releases its lane. Missing/unresolved or unknown launch/startup/cancel outcomes never skip, retry or release; sticky holds remain held. These rules add no automatic retry, refund, native success proof or hold-reset authority.

G1 `candidateSha256` hashes its raw role-file bytes; `guidanceSha256` separately hashes the exact sanitized rendered guidance handed to a worker. The child commitment retains both. Editor artifact provenance compares the raw candidate hash; worker frame/handoff validation compares the rendered guidance hash. They are not interchangeable, and a matching raw hash does not prove rendered bytes.

## Source-owner APIs

Types and pure parsing live in `src/hub/guidance-probes.ts`; private SQL lives in `src/hub/guidance-probe-store.ts`. These signatures are the review boundary, not an additional public dispatch surface:

```ts
parseGuidanceProbeManifest(value: unknown): GuidanceProbeManifestV1 | undefined;
parseGuidanceProbeRegistration(value: unknown): ProbeRegistrationV1 | undefined;
guidanceProbeManifestKey(manifest: GuidanceProbeManifestV1): string;
parseGuidanceProbeCommand(args: readonly string[]): GuidanceProbeCommand | undefined;

interface GuidanceProbeStore {
  register(input: ProbeRegistrationV1, binding: ProbeHostBinding,
    revalidate: () => ProbeHostBinding): ProbeReceipt;
  read(key: ProbeKey): ProbeStoredState | undefined;
  startSelector(key: ProbeKey, requestedRevision: ProbeInteger): ProbeStartSelector | undefined;
  reserveSession(input: ProbeSessionAdmission,
    revalidate: () => ProbeAdmissionRecheck): ProbeReservationResult;
  exposeLaunch(reservation: ProbeReservation,
    revalidate: () => ProbeAdmissionRecheck): ProbeReceipt;
  checkInvocation(reservation: ProbeReservation, revalidate: () => ProbeAdmissionRecheck): ProbeReceipt;
  admitEffect(input: ProbeEffectAdmission,
    revalidate: () => ProbeAdmissionRecheck): ProbeEffectAdmissionResult;
  settleEffect(input: ProbeEffectSettlement): ProbeReceipt;
  settleSession(input: ProbeSessionSettlement): ProbeReceipt;
  settlePreLaunchFailure(reservation: ProbeReservation, now: ProbeInteger): ProbeReceipt;
  settleObservedSession(input: ProbeSessionSettlement, usage: "known_fixture" | "unknown"): ProbeReceipt;
  latchHold(reservation: ProbeReservation, reason: "elapsed" | "observation" | "usage"): ProbeReceipt;
  recordUsage(input: ProbeUsageObservation): ProbeReceipt;
  cancelIntent(input: ProbeCancellation,
    revalidate: () => ProbeHostBinding): ProbeReceipt;
  integrity(): ProbeIntegrity;
}

type ProbeState = "declared" | "active" | "closing" | "closed_fixture" | "failed_fixture" | "unknown_held";
type ProbeSessionState = "planned" | "reserved" | "running" | "failed_known"
  | "closed_fixture" | "not_needed" | "unknown_held";
type ProbeBudgetUnit = "model_calls" | "tool_calls" | "tokens"
  | "input_bytes" | "scratch_bytes" | "output_bytes";
interface ProbeKey { projectKey: ProbeId; id: ProbeSha256 }
interface ProbeHostBinding {
  projectKey: ProbeId;
  actor: PeerId;
  task: { id: number; created: ProbeInteger; flowRevision: ProbeInteger };
  role: ProbeRoleIdentity;
  baselineGuidance: string; // Private existing rendered catalog baseline, <=8 KiB.
  sessionGeneration: ProbeInteger | ProbeId;
  nativeSession: ProbeId | null;
  requestConnectionId: ProbeId;
}
interface ProbeChildBinding {
  variantId: ProbeSha256;
  candidateSha256: ProbeSha256;
  guidanceSha256: ProbeSha256;
  task: { id: number; created: ProbeInteger; flowRevision: ProbeInteger };
  role: ProbeRoleIdentity;
  guidance: string; // Private exact existing G1 rendering, existing bound applies.
  authoring: "admitted_fixture" | "uncontrolled";
  sourceSessionId: ProbeId | null;
}
interface ProbeSessionAdmission {
  key: ProbeKey;
  expectedRevision: ProbeInteger;
  host: ProbeHostBinding;
  child?: ProbeChildBinding;
  preparedFrame?: ProbePreparedFrame; // Host-only metadata for the exact frame later passed to the fake port.
  now: ProbeInteger; // Queued diagnostic only; Store samples its trusted clock after locking.
}
interface ProbePreparedFrame { slotId: ProbeId; sha256: ProbeSha256; bytes: ProbeInteger }
interface ProbePreparedWorkerFrame { inputFrame: string; nonGuidanceInputSha256: ProbeSha256 }
type ProbeWorkerFramePreparer = (state: ProbeStoredState, slot: ProbeSlot,
  guidance: string) => ProbePreparedWorkerFrame | Promise<ProbePreparedWorkerFrame>;
interface ProbeResourceCharges { inputBytes?: ProbeInteger; scratchBytes?: ProbeInteger; outputBytes?: ProbeInteger }
interface ProbeAdmissionRecheck {
  host: ProbeHostBinding;
  child?: ProbeChildBinding;
}
interface ProbeReservation {
  key: ProbeKey;
  slotId: ProbeId;
  generation: ProbeInteger;
  revision: ProbeInteger;
}
interface ProbeStartSelector {
  requestedRevision: ProbeInteger;
  slotId: ProbeId;
  variantId: ProbeSha256 | null;
  inputFrameSha256: ProbeSha256 | null;
  inputFrameBytes: ProbeInteger;
  actor: PeerId;
  sessionGeneration: ProbeInteger | ProbeId;
  nativeSession: ProbeId | null;
  requestConnectionId: ProbeId;
}
type ProbeReservationResult =
  | { kind: "granted"; reservation: ProbeReservation }
  | { kind: "existing"; receipt: ProbeReceipt };
interface ProbeEffectAdmission {
  reservation: ProbeReservation;
  sequence: ProbeInteger;
  unit: ProbeBudgetUnit;
  amount: ProbeInteger;
  reservedTokens?: ProbeInteger;
  charges?: ProbeResourceCharges;
  descriptorSha256: ProbeSha256;
  now: ProbeInteger;
}
type ProbeEffectAdmissionResult =
  | { kind: "granted"; admission: ProbeEffectAdmission }
  | { kind: "existing"; state: "pending" | "settled" | "unknown" };
interface ProbeEffectSettlement {
  admission: ProbeEffectAdmission;
  outcome: "settled" | "unknown";
}
interface ProbeSessionSettlement {
  reservation: ProbeReservation;
  outcome: "closed_fixture" | "failed_known" | "unknown";
  candidateArtifactSha256: ProbeSha256 | null;
  now: ProbeInteger;
}
interface ProbeSessionCoverage {
  inputFrameSha256: ProbeSha256 | null;
  inputFrameBytes: ProbeInteger;
  launchExposed: boolean;
  preLaunchFailure: boolean;
  modelCalls: ProbeInteger;
  modelUsageKnown: ProbeInteger;
  toolCalls: ProbeInteger;
  toolUsageKnown: ProbeInteger;
  usageUnknown: boolean;
  coverageVerified: boolean;
}
interface ProbeUsageObservation {
  admission: ProbeEffectAdmission;
  observed: ProbeInteger | null; // Model tokens or tool invocation count; null is unknown.
  observationSha256: ProbeSha256;
}
interface ProbeCancellation {
  key: ProbeKey;
  expectedRevision: ProbeInteger;
  host: ProbeHostBinding;
}
interface ProbeCounters {
  workerAttempts: ProbeInteger;
  editorAttempts: ProbeInteger;
  modelCalls: ProbeInteger;
  toolCalls: ProbeInteger;
  tokensReserved: ProbeInteger;
  tokensObservedKnown: ProbeInteger;
  inputBytes: ProbeInteger;
  scratchBytes: ProbeInteger;
  outputBytes: ProbeInteger;
  elapsedHighWaterMs: ProbeInteger;
  usageUnknown: boolean;
}
interface ProbeReceipt {
  id: ProbeSha256;
  revision: ProbeInteger;
  state: ProbeState;
  already: boolean;
}
interface ProbeStoredState {
  registration: ProbeRegistrationV1;
  binding: ProbeHostBinding;
  receipt: ProbeReceipt;
  counters: ProbeCounters;
  firstReservedAt: ProbeInteger | null;
  admissionHold: "none" | "elapsed" | "observation" | "usage";
  cancelRequested: boolean;
  notNeeded: ProbeInteger; // Derived from session records, never an attempt/budget counter.
  sessions: readonly {
    slotId: ProbeId;
    generation: ProbeInteger;
    revision: ProbeInteger;
    state: ProbeSessionState;
    candidateArtifactSha256: ProbeSha256 | null;
    child?: ProbeChildBinding;
    start?: ProbeStartSelector;
    coverage: ProbeSessionCoverage;
  }[]; // <=9; effect descriptor columns are hydrated separately by exact key.
}
interface ProbeIntegrity {
  experiments: ProbeInteger;
  sessions: ProbeInteger;
  digest: ProbeSha256;
}
interface ProbeFakeLaunch {
  reservation: ProbeReservation;
  slot: ProbeSlot;
  manifest: GuidanceProbeManifestV1;
  inputFrame: string; // Only this role's prepared bounded input, never all snapshots.
  inputSha256: ProbeSha256;
  nonGuidanceInputSha256: ProbeSha256;
  purpose: "guidance_probe";
}
interface ProbeFakeObservation {
  reservation: ProbeReservation;
  outcome: "closed_fixture" | "failed_known" | "unknown";
  servedModel: string | null;
  inputFrameHash: ProbeSha256 | null;
  workerEffectiveInputHash: ProbeSha256 | null;
  nonGuidanceInputSha256: ProbeSha256 | null;
  candidateArtifactSha256: ProbeSha256 | null;
  usage: "known_fixture" | "unknown"; // A status claim only; host effect accounting must independently cover every model/tool effect.
}
interface ProbeFakeStop { reservation: ProbeReservation }
interface ProbeFakeStopObservation {
  reservation: ProbeReservation;
  stopped: "known_fixture" | "unknown";
}
interface ProbePublicReceipt extends ProbeReceipt {
  experimentId: string | "withheld";
  taskId: number;
  evidence: "declaration" | "fixture" | "unknown";
}
interface ProbePublicStatus extends ProbePublicReceipt {
  counters: ProbeCounters;
  cancelRequested: boolean;
  notNeeded: ProbeInteger;
  comparable: boolean;
  authoring: "admitted_fixture" | "uncontrolled" | "unknown";
}
type GuidanceProbeCommand =
  | { op: "register"; file: string; json: boolean }
  | { op: "start"; id: ProbeSha256; revision: ProbeInteger; variantId?: ProbeSha256; json: boolean }
  | { op: "show"; id: ProbeSha256; json: boolean }
  | { op: "cancel"; id: ProbeSha256; revision: ProbeInteger; json: boolean };

interface ProbeFakeEffectRequest {
  sequence: ProbeInteger;
  unit: "model_calls" | "tool_calls" | "resources";
  descriptorSha256: ProbeSha256;
  reservedTokens?: ProbeInteger;
  charges?: ProbeResourceCharges;
}
interface ProbeFakeEffectValue<T> {
  value: T;
  usage: ProbeInteger | null; // Model tokens or tool invocation count for the captured unit.
  observationSha256: ProbeSha256;
}
type ProbeFakeEffectResult<T> =
  | { kind: "executed"; value: T }
  | { kind: "existing"; state: "pending" | "settled" | "unknown" };
interface ProbeFakeEffects {
  current(): void;
  runEffect<T>(request: ProbeFakeEffectRequest,
    effect: (signal: AbortSignal) => Promise<ProbeFakeEffectValue<T>>): Promise<ProbeFakeEffectResult<T>>;
}
interface GuidanceProbeFakePorts {
  launch(input: ProbeFakeLaunch, effects: ProbeFakeEffects,
    signal: AbortSignal): Promise<ProbeFakeObservation>;
  stop(input: ProbeFakeStop, signal: AbortSignal): Promise<ProbeFakeStopObservation>;
}

// Tasks is the only policy/effect owner; arguments do not carry authority.
Tasks.guidanceProbeRegister(by: PeerId, value: unknown): Promise<ProbePublicReceipt>;
Tasks.guidanceProbeStart(by: PeerId, id: string, revision: number, variantId?: string): Promise<ProbePublicReceipt>;
Tasks.guidanceProbeShow(by: PeerId, id: string): Promise<ProbePublicStatus>;
Tasks.guidanceProbeCancel(by: PeerId, id: string, revision: number): Promise<ProbePublicReceipt>;
```

`ProbeHostBinding` is host-created, never parsed from the declaration or control payload. Store inputs include exact project/manifest/session/generation, expected revisions and bounded descriptor identities as appropriate. Store methods own their transactions; no caller may perform half of a reservation externally. Public receipts expose fixed closed metadata only, never raw manifests, task/guidance text, input/configuration bodies or private addresses. Experiment identifiers use the existing pure guidance field screen with field-only withholding where applicable. All rendered dynamic strings use the existing sanitizer.

`ProbeFakeEffects` is a host capability captured by Tasks for one reservation, not a parsed record. It cannot select an actor, reservation, slot or currentness override. Each model/tool invocation charges exactly one attempt; optional reserved tokens and bounded resource reservations are admitted in that same transaction. A resources-only setup operation charges no synthetic model/tool call and uses known host zero usage. Reservations are not measured consumption and are never refunded. Tasks-private settlement/usage callbacks correlate the captured reservation and the host-computed descriptor/observation identities, and are not exposed as independent provider authority. The provider's effect function is fixture code only, invoked at most once for a fresh grant. Its returned value is local to the fake caller, not an unchecked public receipt.

Attempt counts are charged by admission, independently of reported usage. Numeric model usage means observed tokens for that attempt; numeric tool usage means the correlated invocation count. Missing model token coverage stays unknown even without a token limit. Observed usage exceeding an admitted reservation is retained as an overrun/unknown-held condition, not a refund or permission for another effect. The host recomputes the observation identity over the captured descriptor and numeric/null result; a mismatching supplied identity is conflicting evidence.

The fixture effect value's observation hash binds its visible request and numeric/null usage. The host verifies that visible hash, then computes the ledger correlation hash over its captured admission and observed usage. The provider need not know hidden host clock/authority metadata. Replay identity excludes the new bookkeeping timestamp while retaining reservation, sequence, unit, amount, optional token reservation and descriptor identity.

`tokensReserved` is the consumed upper-bound reservation, never refunded or double-charged by settlement. `tokensObservedKnown` sums only numeric attributed fixture observations once; it is not a replacement for reservations or a claim of complete coverage. Sticky unknown coverage and the current pending effect remain separate from both numbers. With a token limit, a missing trusted upper bound refuses before the effect. Without a token limit, a missing upper bound does not imply hard token enforcement. Fixture providers may supply known fixture upper bounds; the confined T2 adapter requires that trusted bound before a limited call; this fake ledger alone cannot prove a provider bound.

The fake port never receives the entire private snapshots bundle. A worker frame cannot directly contain improver context, other arm outputs or selector material; its only variable arm field is the admitted guidance slot. Preparation/frame equality tests establish fixture separation only, not semantic absence of hidden information or native confinement. Session settlement changes only the private ledger and cannot create a Task review/completion event. Registration receipts have `evidence: "declaration"`; they cannot become `"fixture"` merely because a runner exists or start was requested. Only actual closed fake-port observations have fixture strength, still with no native or model attestation.

The host builds each exact frame once and passes only its slot id, SHA-256 and UTF-8 byte count into the fresh Store reservation. `reserveSession` verifies that descriptor against the selected slot and charges it against the remaining aggregate `inputBytes` budget inside the same `BEGIN IMMEDIATE`, before granting a lane or session. The exact start selector retains that frame descriptor; replay must match it and returns before charging again. A low-level synthetic Store reservation may omit the descriptor for ledger-only tests, but cannot yield public fixture evidence or comparability without a host-verified frame and coverage.

The Store persists per-session frame, launch-exposure and effect-coverage metadata. Immediately before invoking `ports.launch`, the trusted host atomically rechecks current binding, cancellation and the elapsed deadline, then persists `launchExposed`; no provider field attests to whether launch occurred. Before that marker only, the host may settle a known failed startup with zero model/tool effects and no hold, leaving only its already-preregistered retry eligible. Once launch was exposed, a fake `failed_known` or `closed_fixture` label is accepted only with at least one admitted model effect and complete correlated numeric usage for every admitted model/tool effect. Missing model effects, missing/unknown usage and pending effects stay unknown-held, including when the fake labels them `known_fixture` or `failed_known`. `comparable` and public fixture evidence require the persisted host-verified frame/coverage; a closed label alone is never evidence.

Each fake `runEffect` promise is owned by the host before invoking its callback,
even if the fake port does not await it. Port settlement closes admission for
further effect calls; `start` joins its registered effect callbacks before it can
settle. A resolved port promise does not prove callback or process quiescence. An
unknown returned receipt enters the existing owned abort/stop path, and uncertain
stop evidence retains the runtime handle. A noncooperative callback therefore
keeps `guidanceProbesPending` nonzero and the database open; the existing five-second
stop bound rejects until those owned callbacks and matching stop evidence settle.
This joins owned promises and never attests physical cancellation.


Phase1's host-only `GuidanceProbeFixtureHost` composes Store reservations and fake ports for fixtures; its constructor is not a config/wire factory. `start(admission, signal)` derives worker bytes from the retained frozen task/baseline/system policy and selected rendered guidance, with no caller-supplied frame/hash. `guidanceProbeWorkerFrame(task, baselineContext, systemPolicy, guidance)` includes all four mandatory worker-visible fields, with no reservation/arm ids; its non-guidance hash derives from the first three. Editor frames come only from a host constructor callback, not wire data. Tasks integration later owns complete role-specific editor preparation; Phase1 does not claim that builder or native materialization.

Every role observation must report the exact full served model and a generic `inputFrameHash` matching its actual visible frame. Worker observations additionally require `workerEffectiveInputHash` and the derived non-guidance hash; editor observations must not label an editor hash as a worker hash. A wrong/unknown model or frame cannot yield controlled authoring or a comparable fixture outcome. `admissionHold` is sticky once elapsed/observation/usage proof is lost: late close/accounting cannot clear it or free the lane, even if the clock later recovers. Any future disposition requires a separately specified T3 proof; T1 grants no hold-reset API.

A visible observation-hash mismatch unconditionally latches conflict/unknown before bookkeeping. Provider hashes are never passed through as ledger correlation identities, even if they happen to equal the host correlation hash; ledger identities are always host-computed.

The proposed control operations are `guidance_probe_register`, `guidance_probe_start`, `guidance_probe_show` and `guidance_probe_cancel`, each always replying to rid, including errors. CLI forms are `ahub guidance probe register --file JSON`, `start --id HASH --revision R [--variant G1_CONTENT_ID]`, `show --id HASH` and `cancel --id HASH --revision R`, with optional JSON output. R is the probe CAS revision, not the frozen Task flow revision. There are no MCP probe tools, console mutations or new daemon authority flags. Unknown operation responses give upgrade/restart guidance. An uncertain write response directs an explicit keyed show, never an automatic replay.

The additive conditional recovery feature declares private probe state only when present. Control-client/restart snapshots carry its integrity binding through all existing recovery verification sites; absent legacy state is unchanged. Reads never invoke models, resolve opaque addresses or launch effects.

## Source-owner G1 handoff and final review boundary

The accepted task states, narrowing cancellation fences, wall elapsed accounting, role caps, late candidate/successor binding and manifest format bound above are root design decisions within T1. They are not native execution proof or a broader conductor admission.

The Tasks-only synchronous helper is `guidanceProbeVariantBinding(by: PeerId, task: Task, variantId: string): ProbeChildBinding`: actual probe-authorized actor admission, current flow/catalog/baseline/withdrawal validation and exact guidance bytes/hash from the existing source-owner validated record read. It uses `Board.guidanceVariantLocation` (task/project/epoch/content-id index, LIMIT 2 ambiguity refusal), then `Board.guidanceVariants` for that exact experiment (existing SQL byte bounds, record parser and 17-row corruption sentinel). It never calls `guidanceVariantRead` as USER or owner and returns only to the private fake-session path, never CLI/control output. It grants no general raw G1 read permission. ProbeStore does not query or parse G1 tables independently.

Under ProbeStore's `BEGIN IMMEDIATE` write-lock, a host-only synchronous revalidation callback rereads the current Task and selected G1 through the existing uncached, nontransactional Board reads above, checks all actual-actor/session/privacy/catalog fences and compares the captured binding/hash/revision. It returns before child INSERT/session/counter changes. The callback cannot await, write or return a Promise. The write-lock prevents another connection from committing Task changes or G1 withdrawal between this fresh read and reservation. The owner Board connection must not retain an older read transaction; existing synchronous getters issue fresh SELECTs rather than a cached snapshot. No new Board method/file is needed for these current APIs. Source tests must use two connections: withdrawal before lock causes refusal/zero reservation; an attempted withdrawal under the lock is busy and cannot turn a stale binding into a granted launch. This is a lock/record-read contract, not an assumption that any independently cached read is atomic.

Source inspection confirms G1 creation writes only private guidance tables and Board's global status revision, not Task history/flow. `Tasks.guidanceVariantCreate` records the existing task history length in the variant; `Board.recordGuidanceVariant` inserts the immutable records and does not append a Task event. Consequently creating an admitted candidate during a probe does not itself invalidate the frozen Task flow. An actual intervening Task flow/epoch/catalog change still refuses later start. These are source findings, not executed proof.

## Proof boundary and planned fixtures

Fake-only tests must prove closed parsing and exact model literals; zero writes on known refusals; production no-runner refusal before reservations; current authority/privacy/task/G1 fences across awaits; one project lane and serialized CAS under concurrent admission; exact duplicate no-effect behavior; four/five aggregate ceilings including failures; reservation before fake launch; unknown-held restart/cancel behavior; immutable successor binding; no ordinary observer/progress/completion effects; bounded SQL hydration and recovery integrity. Cross-await callback fixtures must prove shared model/tool/token/input-frame budgets including the frame bytes, refusal before fake invocation on exhausted capacity, no second effect or double frame charge on replay, new-call refusal after G1 withdrawal or actor/session loss, and pre-reservation exhausted budgets without a launch. Separate controls prove correlated bookkeeping after fence loss, missing/conflicting/late numeric usage remaining sticky unknown before descriptor replacement, zero model calls or unknown post-launch usage not becoming `comparable`, a host-attested known pre-launch failure retaining only its preregistered retry, a fully covered controlled fixture, and that a `known_fixture` label alone never certifies coverage. Direct low-level Store fixtures retain their lifecycle/counter assertions while lacking checked frame/coverage proof and therefore cannot yield comparable public evidence.

Control fixtures use scratch daemon/database and host-injected fake ports only. They must exercise older/unknown rid replies and privileged direct-call refusal. Recovery fixtures must prove present-state integrity, missing legacy compatibility, tamper/unknown refusal, retained counters/lane and no auto-respawn. No real hub, account, model, worker or native process is part of this proof. Measurements, if later recorded, identify source/fake evidence separately from unimplemented native guarantees.

### Refusal certainty and operator recovery

Deterministic `PreEffectToolRefusal` and non-storage `GuidanceProbeError` failures
that occur before reservation or without a committed write retain their bounded
cause and next step. Registration tracks whether it committed a new declaration;
the host reports a fresh reservation to its controller before later preparation
or launch work. Storage, unknown and post-reservation failures remain unconfirmed.
The control transport preserves known refusal messages and always echoes `rid`; it
uses a fixed unconfirmed fallback for unknown errors. CLI recovery names
`ahub guidance probe show --id <id>` only for an operation that already has an id;
a refused registration has no lookup suffix. Retained baseline guidance counts
toward `limits.inputBytes` as well as private snapshots.

The T2 probe-specific request omits delivery-id equality: ordinary new hub
delivery alone does not invalidate an admitted run. Current socket/session,
conductor/roster, task/G1 and privacy/review checks remain. Generic G1 requests
retain their existing delivery fence. The tests independently prove ordinary
delivery continuity and refusal on changed authority or privacy.

Probe recovery deliberately checks any restored snapshot against the private
probe digest when records exist, including an older snapshot without an integrity
section. Missing proof refuses restoration; absence of records keeps the older
snapshot compatible. The check is stronger than legacy sibling guards because
restoring an unbound probe ledger could lose its shared budget or uncertain lane.


## T2 confined adapter contract

This section defines the approved T2 boundary on merged T1. It does not enable a runner,
claim native confinement, or authorize a real model/worker trial. The existing T1
constructor-only fake runner remains the production default until the receipt and
live-admission slices are separately ready. T2 tests use fake model ports and
model-free OS-boundary canaries only.

### Same loop, separate host lifecycle

A host-created probe capability drives a fresh private `LocalPeer` through its
existing `run` / `call` / tool loop. The kind-specific factory lives in
`src/adapters/local-probe.ts`; generic file/sandbox helpers stay in `src/local/`. The factory constructs explicit options; it
never spreads ordinary peer options or accepts a purpose from a model envelope,
manifest, configuration or wire field. The private peer is never added to Bus,
ordinary recovery or a live session. A constructor-only `workspaceOwned`
notification hands the minted branded workspace to its private resource owner
after materialization; it is not an ordinary observer, wire field or authority
grant. Cleanup still requires captured physical ownership and known stop. Ordinary `deliver` does not enter this path.

The host-only entry points are `LocalPeer.runProbe(session, signal)` and
`LocalPeer.stopProbe()`. The former retains/returns the actual common-run promise;
acceptance is not completion. Stop closes effect admission, aborts, and joins the
run and every owned operation before claiming quiescence. Unsettled work retains
its handle and unknown hold under T1's existing bounded drain. There is no retry,
redelivery, ordinary final answer, task completion or model fallback.

Host purpose excludes capture init/observe/summarize/end, ordinary history,
input observers, session title/Record instructions, bus messages, onTool,
onRoute, onUsage, research/progress, learning and ordinary limit/failure logs on
every exit path. Probe accounting uses private correlated ports, never optional
observer callbacks. PII/review identities are not repurposed as probe authority.
The compiled mandatory local-worker policy remains present and is hashed from
the actual trusted template; declaration `systemPolicy` cannot replace it.

### Prepared request and accounting

`ProbePreparedLocalInput` binds the exact initial request passed to the model
client: model, messages, tool schemas and generation options. A stable logical
cwd `/workspace` is model-visible; tool resolution uses the actual private root.
Physical paths, session/reservation ids, timestamps, Record/title context and
ordinary history never enter that request. Guidance occupies exactly one
host-assembled slot. The non-guidance digest is computed by assembling the same
request with only that slot empty, not by string replacement or dropping fields.
The initial permitted-file listing and content descriptors are bound into the
fixed request context, without opaque host data ids. Tests compare the complete
actual request bytes, including the fixed transport `stream: false` field.

The existing T1 JSON task/context/guidance frame is not full LocalPeer input.
The source-owner host preparation API has been extended with an optional worker-frame
preparer, preserving the T1 default. It builds the actual request before the
atomic initial frame reservation; execution must reuse that request and refuse
any initial drift before a model effect. For a later worker arm, reconstruct the baseline request
with the current resolved descriptors and frozen baseline guidance and require
its hash to match the retained successful baseline input-frame hash. A new
factory instance or changed destination/order cannot bypass that comparison.
Later tool/model messages may naturally
differ across arms; they are not silently excluded from accounting.

`ProbeFakeEffectRequest` additions carry exact subsequent request input
bytes and reserved scratch/output bytes. The owner Store charges call/token and
resource reservations atomically before granting the effect, with the same
sequence/hash replay fence. `ProbeFakeEffects.current()` supplies the fresh captured Store/actor/G1 fence
for post-approval checks; it reconstructs no authority from recorded metadata.
The initial prepared request is charged exactly once;
all later model requests are charged before HTTP. A resources-only host effect
charges setup storage without inventing a model/tool call; its known host usage
is zero and its sequence/descriptor/replay fence is the same. A write reserves
a conservative complete-file byte bound before I/O. Write payloads have an exact
UTF-8 length; edit planning uses guarded file-size metadata plus replacement
bytes, bounded by the fixed file ceiling, without reading contents before call
admission. After approval the actual target/result must fit the paid bound or
refuse; no nested effect replaces the pending tool descriptor. Transient read
text is private input charged in the next complete model request, not an output
artifact. Final answer/artifact bytes are reserved before collector release or
file persistence, after recording the model call's actual usage. These byte
counters are reservations, not measured consumption. Failed attempts consume reservations;
there are no refunds, per-arm resets, private SQL duplicates or usage inferred
from absent records. Shared storage remains under T1's 1 GiB experiment ceiling.

A token-limited call refuses unless a trusted frozen model configuration supplies
a conservative upper bound for the whole call, including input and output. An
output cap or past usage is not that bound. Before every limited model effect,
the exact serialized request's UTF-8 byte length plus `maxOutputTokens` must fit
the frozen `tokenUpperBound`; otherwise refuse as a known pre-effect failure.
This conservative bytes-bound-tokens check assumes the pinned served model's
byte-level BPE; a tokenizer-measured whole-call bound is the upgrade path.
Private local results distinguish this refusal from an interrupted run and are
incomplete. Earlier explicitly covered usage remains covered; a refusal before
any model call does not fabricate a usage observation or comparability.
Explicit valid provider total usage
is observed; missing/conflicting usage stays unknown. Money and sampling control
remain unknown without their separately required evidence.

The served model must equal `qwen27b/qwen3.8-27b` without normalization. Current
`ChatResult.servedModel` trims its source, so it cannot alone prove this. The
narrow transport metadata `servedModelExact?: true` is present only when the raw
JSON model string already equals the validated returned label. Absent/false proof
is unknown; a different string is incomparable. No raw label, credential, header
or authority is added to route events. This additive optional provenance seam changes neither ordinary label trimming
nor route-event fields.

### Host-resolved files and role matrix

T1 data ids are opaque, not paths or source addresses. A trusted host resolver
supplies `ProbeMaterializedFile {dataId, relative, sha256, bytes}` plus the frozen
source-tree binding. Check membership, hash and byte length against the admitted
policy and role before writing. Source-code descriptors must be verified against
the exact declared Git tree by the existing hardened host Git boundary. Model
text cannot supply a resolver, source path, role, destination or extra data id.

Materialization creates new regular files from admitted bytes, never Git
worktrees/clones/object stores, archive extraction, links, whole homes,
node_modules or evaluator trees. Reject symlink/gitlink entries, duplicate or
case/folding-colliding destinations, traversal, empty components, hidden Git/hub
names, unknown ids and unmatched hashes/sizes. Fixed availability ceilings are
1 MiB per file and 64 MiB per workspace, further narrowed by the manifest and
remaining aggregate storage budget. These are explicit T2 ceilings, not proof
that an arbitrary repository fits. Relative names use the existing bounded
execution-id text ceiling; opaque data ids are never interpreted as filenames.

Each role has a fresh private parent and HOME. A tool can write only declared
scratch/output descendants; no writable common ancestor, parent entry or sibling
is exposed by its profile. Immutable inputs and source policy remain read-only.
No hostile same-user isolation is claimed. Existing guardPath checks, lexical and
canonical deny policy, normal write permission and post-approval checks remain.
Approved write roots are mapped from the admitted workspace spelling onto its
canonical root, so a host temporary-directory alias does not change admission.
The model sees the admitted logical scratch/output names. Probe tool refusals
use typed cause classes and a logical next step, never physical paths or ids;
workspace/file ceilings are known refusals, and withdrawn authority forbids
further tool calls.

- Worker: current task, fixed baseline context and source ids; admitted guidance
  is the only experience channel. No other-arm output or control receipt.
- Proposal/compose: their declared task/source ids and bounded closed artifacts;
  frozen improver context only when their policy flag admits it.
- Select: declared task sources and host-anonymized deliverables. No arm names,
  evaluator or control receipts; anonymization is a checked host source boundary,
  not a claim inferred from an `anonymizedDeliverables` boolean alone.
- Reflect: only the closed round's admitted evidence; no future round or corpus.

All roles exclude evaluator/rubric, future tasks, operator files, live homes,
Git objects, credentials and undeclared sources. Unknown source/classification
proof refuses, rather than treating a declaration as a measured source read.

### Closed tool capability and real boundary proof

The v1 capability contains only existing host file tools `read`, `write`
and `edit`, with the role/write guard before dispatch. No arbitrary bash/git,
package/native commands, hub send/task/memory, network/web/document or session
mutation tool is advertised or dispatchable, including invented calls. This
narrowing is part of v1: network-off alone cannot prohibit
arbitrary approved shell code from installing packages offline. Adding any subprocess capability requires a later issue with its own pinned
command grammar and cleanup proof.

Reuse the existing sandboxedExec boundary with a deny-only probe refinement and
closed private environment. Its writable own-temp suffix must be inside the
owned workspace and resource cap, never a broad temp exception. Broad ordinary
home toolchain/cache, /opt and /Library reads are not probe data permissions.
Only verified required system/runtime reads and exact owned role roots remain.
Deny network including loopback and credential/agent/proxy environment. Unsupported
OS/profile enforcement refuses; binary presence alone is not an admission proof.

Before exposing the private LocalPeer, an actual model-free canary under the
exact lane profile must prove permitted reads/writes, then deny evaluator,
future-task, other-arm, control-receipt, Git-object, synthetic-home, parent and
sibling reads/writes/rename/link attempts. Prove environment exclusion and
network denial against an owned loopback listener with an outside-profile
positive control. All five roles use the same tested boundary with their own
input matrix. Fake availability/profile text is not native proof. Linux may
prove fail-closed unavailability and pure parsing/materialization; it cannot
stand in for a successful macOS Seatbelt leg.

### Probe-specific conductor currentness

For probe register/start/show/cancel and running effects, ordinary new hub
delivery alone must not invalidate a captured request or latch an observation
hold. Keep the actual request/socket capability, original connection UUID, peer
identity, generation/native session, current conductor role/roster, task epoch/
flow, G1 applicability and fresh privacy/review checks. Unknown proof refuses.
Generic G1 request operations retain their existing delivery fence; only the
probe-owned helper omits delivery-id equality. While an asynchronous initial
frame is still being prepared, an exact same-session duplicate returns only the
truthful current receipt (`already: true`, possibly still declaration evidence),
without reserving a slot or charging a frame. The original captured actor,
generation, native session and connection UUID must still match; another
connection cannot borrow the pending start. After reservation, the existing
Store replay path applies. No replay call may create an unframed reservation.
Tests add an ordinary delivered
message during a running fake effect and prove continuity, then independently
change authority/privacy and prove the next effect is refused.


## T3 receipts, reconcile and cleanup contract

This section is a contract proposal for review before implementation, on merged T2
(`fa53e8b1`). It does not enable a runner, claim native confinement or authorize a real
model or worker trial. The constructor-only host adapter stays unwired. T3 adds evidence
and cleanup around sessions the existing lifecycle already runs; it changes no admission,
budget, fence or authority rule.

### What a receipt is

A receipt is the host's immutable observation of one finished session, written once after
the process tree is known quiescent and the output is collected. It is not a provider
claim: every field is computed by the host from what it admitted, measured or read back.

`ProbeReceiptV1` is closed, inert JSON, canonical and bounded like the manifest. It binds
exact experiment and slot ids, the reservation generation and revision, and:

- `requestedModel` and `servedModel`: exact literals. `servedModel` is `null` when the
  host could not observe it. No normalization, alias or slash splitting.
- `inputFrameSha256` and, for a worker, `workerEffectiveInputSha256` and
  `nonGuidanceInputSha256`; `guidanceSha256` for the admitted slot.
- `runtimeSha256`, `toolsetSha256`, `modelConfigSha256`, read from the host's own
  fingerprints at seal time, never copied from the declaration.
- `startedAt`, `endedAt` and `elapsedMs` from the Store's trusted clock.
- `state`: one of `succeeded`, `failed`, `cancelled`, `timed_out`, `unavailable`,
  `unknown`. `succeeded` requires every condition under "Sealing" below.
- `usage`: per-session model calls and tool calls with their known counts, and observed
  tokens or `null`. A gap stays `null`; a sum is never filled in.
- `limits`: the closed list of observation limits that applied (for example
  `usage_unknown`, `served_model_unobserved`, `teardown_unverified`, `output_truncated`,
  `storage_over_cap`).
- `output`: a `ProbeOutputManifestV1`, below.
- `digest`: SHA-256 of the canonical record without this field.

`ProbeOutputManifestV1` lists at most 64 entries of `{ relative, sha256, bytes }`, with
each file at most 1 MiB and the total at most the slot's declared `outputBytes`. Paths are
workspace-relative under the declared output root, regular files with link count 1 only.
Anything else (symlink, hardlink, device, a path outside the declared writes, a file over
the cap) is not hashed: it is recorded as a closed `excluded` reason and the receipt
cannot be `succeeded`.

### Sealing

The adapter's `close` path already stops the peer and confinement and joins owned work.
Sealing happens in that same owned lifecycle, after `stopProbe` and confinement stop have
both reported known quiescence, and before the workspace is released:

1. Collect the output manifest by reading each declared output file through its captured
   identity (device, inode, link count, size), hashing the bytes read, and re-checking the
   identity after the read. A file that changed while read is excluded, not hashed twice.
2. Build the receipt from host state only, then compute its digest.
3. Write it in one `BEGIN IMMEDIATE` transaction together with the session settlement, so
   a receipt and its session state are never separately visible.

A receipt is `succeeded` only if all of these hold: the session settled `closed_fixture`
with verified coverage; `servedModel` equals `requestedModel`; teardown is known
quiescent; no output entry was excluded; no hold is latched; and the elapsed ceiling was
not hit. A timeout, an abort, a token or step ceiling, an uncertain stop and a hold each
map to a non-success state. **A timeout is never `succeeded`**, whatever partial output
exists. There is no path that upgrades a receipt after it is written.

Immutability: a second `sealReceipt` for the same reservation with identical content
returns the stored receipt (`already: true`); different content refuses and latches the
observation hold. There is no update and no delete. A prune never removes a receipt or an
output manifest (see "Cleanup"): receipts are the outcome denominator's record and live as
long as the experiment row does.

### Tamper, torn writes and crash

Receipts live in the same `hub.db`, so a torn receipt is a rolled-back transaction, not a
half file. The Store hydrates a receipt only if its digest recomputes, its experiment, slot,
generation and revision match the session row, and its `state` is consistent with the
session state. Any mismatch is `storage` corruption: the experiment becomes unknown-held,
shows no success and is never silently repaired.

Output files are re-verified against their manifest only through the same captured
identities, while the workspace is still owned. After the workspace is released the
manifest is the record; the bytes are not claimed to still exist unless retained
(next section).

Crash after admission: a session found `reserved` or `running` with no receipt is
reconciled to `unknown_held` with receipt state `unknown` and limit `teardown_unverified`.
Reconcile never launches, retries or restarts a session, and never turns an in-flight
session into a failure or a success. It only records that the host cannot vouch for it.
The lane stays held until a person or conductor cancels it through the existing
`cancelIntent`.

Reconcile runs **only** through an explicit host call, `GuidanceProbeStore.reconcile()`,
made at daemon start. Opening the Store, `read`, `integrity`, `previewPrune` and every
other read never write: a Store opened read-only changes no row. `reconcile` is
idempotent: a second call finds no unreconciled session and writes nothing. A reconciled
`unknown` receipt counts in the outcome denominator as `unknown`, never as `failed`.

### Comparability and the outcome denominator (AC4)

`classifyProbeComparability` is a pure function over the experiment's receipts and
returns `{ comparable, reasons }`, with a closed reason list: `served_model_mismatch`,
`served_model_unobserved`, `input_drift` (a worker's non-guidance hash differs from the
baseline's, or a fingerprint differs), `usage_unknown`, `incomplete_coverage`,
`teardown_unverified`, `authoring_uncontrolled`, `missing_receipt`.

- A pair is incomparable if either side has a reason. One reason is enough; reasons are
  listed, not ranked.
- The public `comparable` flag becomes this function's result. It replaces the current
  inline expression in `Tasks.guidanceProbeProjection` and may only get stricter: every
  case the current expression calls incomparable stays incomparable.
- The outcome denominator is every preregistered attempt slot that was reserved:
  `succeeded`, `failed`, `cancelled`, `timed_out`, `unavailable` and `unknown` all count.
  Slots never started stay `planned` or `not_needed` and are reported separately as such;
  they are neither successes nor failures. A failed, cancelled or unavailable arm is
  never dropped from the denominator, and the status shows the per-state counts.
- Usage gaps stay `null`. No cost or money figure is derived: this task adds no price
  table, so total money remains unknown.

### Cleanup and the 1 GiB cap (AC6)

The experiment's declared `inputBytes + scratchBytes + outputBytes` is already capped at
1 GiB at admission. T3 adds no second source of truth: retained storage is accounted from
the receipts' output manifests plus the retained workspace bytes the host recorded.

The cap also holds at runtime, not only in the declaration. At seal time the host measures
what the session actually left behind in scratch and output. If either exceeds the bound
declared for it, the receipt is a non-success with limit `storage_over_cap` (or
`output_truncated` when output files were excluded for size), and retention is never
silently larger than declared: bytes past the bound are not retained, hashed or counted
as the session's output.

Cleanup touches only resources the host created and still owns, verified at the moment
of removal by captured physical identity (device, inode, directory/file kind, link count)
exactly as `materializeProbeWorkspace` already does for its failure cleanup. A path whose
identity differs, a replaced root, a bystander file or a symlink swap is left alone and
reported as `retained: <reason>`; cleanup never recurses into or deletes a name it did not
create. It never follows a link and never touches another session's resources.

`previewPrune(key, now)` is read-only and returns the exact list of what a prune would
remove (relative names and byte counts, no content) and what it would keep and why.
`prune(key, now, planDigest)` takes that preview's digest and refuses if the owned set has
changed since, so a prune only ever does what the person saw.

Retention is `PROBE_RETENTION_DAYS = 14`, a named constant. It is not a setting, a
manifest field or a config key. At seal time each retained output gets an explicit
`expiresAt` (seal time plus that constant), stored with the receipt and shown by
`previewPrune`. **Nothing is deleted automatically:** there is no timer and no background
sweep. Removal happens only through `previewPrune` followed by `prune(planDigest)`,
called by the host or the person. An unknown-held, active, closing or held experiment is
never prunable, and an output is prunable only after its `expiresAt`.

A prune removes retained output and workspace bytes only. It never deletes a receipt or an
output manifest.

Locks: receipts and prune plans use the Store's SQLite transaction, so no file lock and
no stale-holder recovery are introduced. If implementation finds a file-level lock is
unavoidable it must follow `SourceRegistry.locked` (publish whole by `link(2)`, never
unlink on another's behalf, fail closed on a stale holder, name the file) and ship a
two-recoverer test (#329).

### Scope boundary

T3 adds: the receipt and output manifest types and pure parsing in `guidance-probes.ts`;
one additive private table in the Store (`guidance_probe_receipts`) with receipt
hydration, tamper checks and reconcile folded into the existing integrity and recovery
passes; `sealReceipt`, `readReceipt`, `previewPrune` and `prune`; output collection and
owned cleanup in the adapter and workspace modules; the comparability function; and fake
fixtures for the mismatch, tamper, crash and teardown cases. It does not add a CLI verb,
a wire operation, a daemon runner, a config key, a real model call or a live trial (T4).
Public `show` is unchanged: it keeps only the stricter `comparable` flag. The per-state
denominator counts and the comparability reasons are private status, read by the host
through the Store; T4 owns the producer status and decides what becomes public.

### Rulings applied

The reviewer ruled on the three open choices of the first draft: no automatic expiry and
no new setting (a named constant and an explicit `expiresAt`); reconcile only through an
explicit host call at daemon start; the denominator counts and reasons stay private. They
are folded into the sections above. Three amendments are also applied: prune never deletes
receipts or manifests, the 1 GiB cap holds at runtime, and a reconciled `unknown` receipt
counts as `unknown`.
