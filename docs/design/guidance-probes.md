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

Tasks captures and revalidates project identity, actual actor/roster/conductor currentness, peer identity, session generation/native session, current task epoch/flow and privacy/review-only context across every await and immediately before each write or fake effect. A private turn or private/PII task refuses before content leaves its existing private boundary. Unknown or missing current proof refuses with a next step.

New registration and session start require an already accepted task in `in_progress` or `changes_requested`. There is no implicit assignment/acceptance, no generic MOVES change, and no bypass of existing Task, role, SDLC or operational guards. Historical show is separate from fresh applicability.

Admission requires the current catalog role/baseline to match the frozen commitment and the selected existing G1 to remain current and unwithdrawn. Historical availability is not applicability. Probe admission cannot create another owner's G1, substitute USER or the owner as the caller, or obtain applicability by trusting a manifest field. An internal host-only predicate may inspect the existing private G1 binding under the probe's actual authorized actor; it grants no G1 write authority.

Registration is checked for current admission before deduplication. A stale duplicate does not turn an old declaration into a current permit. A duplicate with the exact current immutable identity returns the existing closed receipt, without a new lane, slot or launch grant. A conflicting declaration refuses. Cancellation intent and historical terminal records never resurrect.

Cancellation relaxes only frozen flow equality and current G1 applicability to narrow already-owned existing work. It retains current person/configured-conductor authority, session, project, Task epoch, privacy/review-only and operational guards. It persists intent, never launches or releases. Cleanup of an already-owned fake handle after a fence is lost is a separate host duty, not a new caller privilege.

Known input/authority refusals before the first Board/store write may be PreEffectToolRefusal. Storage, hydration, readback and unknown wrapped errors remain plain fixed safe errors, including rollback failures. After a reservation, an unknown outcome is never described as safely retryable.

## Private storage and atomic admission

`GuidanceProbeStore` opens the same hub.db through `openHubDatabase`, retaining its schema preflight and named busy timeout. It creates additive private tables only; it does not bump the database marker or spread fields into Task/public Board records.

- `guidance_probe_manifests`: immutable canonical declaration, binding, private actor, lifecycle revision and fixed aggregate counters/unknown flags, keyed by project and manifest id, with `UNIQUE(projectKey, probeExperimentId)` binding that private experiment id to exactly one root manifest forever.
- `guidance_probe_lanes`: one row per project, pointing to the retained experiment/session owner and generation.
- `guidance_probe_sessions`: at most nine preregistered slot rows per experiment, with session CAS revision, state, fixed counters and one current/last effect descriptor.

`BEGIN IMMEDIATE` atomically checks the project lane, experiment/session revisions and legal transition, then reserves the slot and aggregate resource counters before `fakeLaunch`. Failed and retried attempts consume their declared slot and resource reservations. There are no refunds, per-arm resets or implicit retries. No more than one session runs at a time, including editing/reflection sessions. An exact duplicate returns the persisted state and never authorizes a second effect.

A changed manifest hash under the same project/probe experiment id refuses rather than creating fresh four/five-attempt or call budgets. A separately preregistered experiment id can declare a separate repetition; there is no global experiment-count cap. Probe experiment identity is independent from a selected G1's experiment id. Selection still requires the same Task epoch/current flow and current catalog baseline.

The elapsed ceiling is wall time since the first session reservation/admission, including editor attempts, failures, gaps and downtime. Its persisted high-water never decreases or resets per arm. Clock regression or uncertain elapsed coverage holds admission. This is an admission ceiling, not measured model time or monetary cost.

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

G1 `candidateSha256` hashes its raw role-file bytes; `guidanceSha256` separately hashes the exact sanitized rendered guidance handed to a worker. The child commitment retains both. Editor artifact provenance compares the raw candidate hash; worker frame/handoff validation compares the rendered guidance hash. They are not interchangeable, and a matching raw hash does not prove rendered bytes.

## Proposed APIs

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
  reserveSession(input: ProbeSessionAdmission,
    revalidate: () => ProbeAdmissionRecheck): ProbeReservationResult;
  admitEffect(input: ProbeEffectAdmission,
    revalidate: () => ProbeAdmissionRecheck): ProbeEffectAdmissionResult;
  settleEffect(input: ProbeEffectSettlement): ProbeReceipt;
  settleSession(input: ProbeSessionSettlement): ProbeReceipt;
  latchHold(reservation: ProbeReservation, reason: "elapsed" | "observation" | "usage"): ProbeReceipt;
  recordUsage(input: ProbeUsageObservation): ProbeReceipt;
  cancelIntent(input: ProbeCancellation,
    revalidate: () => ProbeHostBinding): ProbeReceipt;
  integrity(): ProbeIntegrity;
}

type ProbeState = "declared" | "active" | "closing" | "closed_fixture" | "unknown_held";
type ProbeSessionState = "planned" | "reserved" | "running" | "failed_known"
  | "closed_fixture" | "unknown_held";
type ProbeBudgetUnit = "model_calls" | "tool_calls" | "tokens"
  | "input_bytes" | "scratch_bytes" | "output_bytes";
interface ProbeKey { projectKey: ProbeId; id: ProbeSha256 }
interface ProbeHostBinding {
  projectKey: ProbeId;
  actor: PeerId;
  task: { id: number; created: ProbeInteger; flowRevision: ProbeInteger };
  role: ProbeRoleIdentity;
  baselineGuidance: string; // Private existing rendered catalog baseline, <=8 KiB.
  sessionGeneration: ProbeInteger;
  nativeSession: ProbeId | null;
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
  now: ProbeInteger; // Host clock, not a caller/wire field.
}
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
type ProbeReservationResult =
  | { kind: "granted"; reservation: ProbeReservation }
  | { kind: "existing"; receipt: ProbeReceipt };
interface ProbeEffectAdmission {
  reservation: ProbeReservation;
  sequence: ProbeInteger;
  unit: ProbeBudgetUnit;
  amount: ProbeInteger;
  reservedTokens?: ProbeInteger;
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
  sessions: readonly {
    slotId: ProbeId;
    generation: ProbeInteger;
    revision: ProbeInteger;
    state: ProbeSessionState;
    candidateArtifactSha256: ProbeSha256 | null;
    child?: ProbeChildBinding;
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
  usage: "known_fixture" | "unknown";
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
  unit: "model_calls" | "tool_calls";
  descriptorSha256: ProbeSha256;
  reservedTokens?: ProbeInteger;
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

`ProbeFakeEffects` is a host capability captured by Tasks for one reservation, not a parsed record. It cannot select an actor, reservation, slot, charge amount or currentness override. Every invocation charges exactly one model/tool attempt; optional reserved tokens are admitted in that same transaction. Tasks-private settlement/usage callbacks correlate the captured reservation and the host-computed descriptor/observation identities, and are not exposed as independent provider authority. The provider's effect function is fixture code only, invoked at most once for a fresh grant. Its returned value is local to the fake caller, not an unchecked public receipt.

Attempt counts are charged by admission, independently of reported usage. Numeric model usage means observed tokens for that attempt; numeric tool usage means the correlated invocation count. Missing model token coverage stays unknown even without a token limit. Observed usage exceeding an admitted reservation is retained as an overrun/unknown-held condition, not a refund or permission for another effect. The host recomputes the observation identity over the captured descriptor and numeric/null result; a mismatching supplied identity is conflicting evidence.

The fixture effect value's observation hash binds its visible request and numeric/null usage. The host verifies that visible hash, then computes the ledger correlation hash over its captured admission and observed usage. The provider need not know hidden host clock/authority metadata. Replay identity excludes the new bookkeeping timestamp while retaining reservation, sequence, unit, amount, optional token reservation and descriptor identity.

`tokensReserved` is the consumed upper-bound reservation, never refunded or double-charged by settlement. `tokensObservedKnown` sums only numeric attributed fixture observations once; it is not a replacement for reservations or a claim of complete coverage. Sticky unknown coverage and the current pending effect remain separate from both numbers. With a token limit, a missing trusted upper bound refuses before the effect. Without a token limit, a missing upper bound does not imply hard token enforcement. Fixture providers may supply known fixture upper bounds; actual provider-bound proof belongs to future T2, not this fake ledger.

The fake-launch frame is prepared for the selected role under the declared input matrix and charged against the input reservation. The fake port never receives the entire private snapshots bundle. A worker frame cannot directly contain improver context, other arm outputs or selector material; its only variable arm field is the admitted guidance slot. Preparation/frame equality tests establish fixture separation only, not semantic absence of hidden information or native confinement. Session settlement changes only the private ledger and cannot create a Task review/completion event. Registration receipts have `evidence: "declaration"`; they cannot become `"fixture"` merely because a runner exists or start was requested. Only actual closed fake-port observations have fixture strength, still with no native or model attestation.

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

Fake-only tests must prove closed parsing and exact model literals; zero writes on known refusals; production no-runner refusal before reservations; current authority/privacy/task/G1 fences across awaits; one project lane and serialized CAS under concurrent admission; exact duplicate no-effect behavior; four/five aggregate ceilings including failures; reservation before fake launch; unknown-held restart/cancel behavior; immutable successor binding; no ordinary observer/progress/completion effects; bounded SQL hydration and recovery integrity. Cross-await callback fixtures must prove shared model/tool/token budget exhaustion before fake invocation, no second effect on replay, new-call refusal after G1 withdrawal or actor/session loss, and pre-reservation exhausted budgets without a launch. Separate controls prove correlated bookkeeping after fence loss, missing/conflicting/late numeric usage remaining sticky unknown before descriptor replacement, and that a `known_fixture` label alone never certifies coverage.

Control fixtures use scratch daemon/database and host-injected fake ports only. They must exercise older/unknown rid replies and privileged direct-call refusal. Recovery fixtures must prove present-state integrity, missing legacy compatibility, tamper/unknown refusal, retained counters/lane and no auto-respawn. No real hub, account, model, worker or native process is part of this proof. Measurements, if later recorded, identify source/fake evidence separately from unimplemented native guarantees.
