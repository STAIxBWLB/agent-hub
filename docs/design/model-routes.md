---
id: model-routes
type: module
title: Hub Model Routes
status: draft
parent: agent-hub-architecture
paths:
  - src/models/route/**
  - src/models/relay.ts
  - src/hub/progress.ts
  - test/model-stage-input.test.ts
  - test/model-stage-diagnostics.test.ts
  - test/model-stage-evidence.test.ts
  - test/model-stage-fallback.test.ts
  - test/fixtures/model-stage-sizing-v1.json
  - test/progress.test.ts
  - src/hub/inference.ts
  - templates/adec/**
  - test/model-advisor-trigger.test.ts
  - test/model-conversation-view.test.ts
  - test/model-escalation-control.test.ts
  - test/model-hub-prompts.test.ts
  - test/model-judge-replies.test.ts
  - test/model-plan-execute-choice.test.ts
  - test/model-turn-state.test.ts
  - test/model-observation-signals.test.ts
  - test/model-judge-choice.test.ts
  - test/model-route-event-parity.test.ts
  - test/benchmarks/model-routing-gate.test.ts
  - test/model-route-scope-lifetime.test.ts
  - test/model-route-public-api-scalars.test.ts
  - test/fixtures/model-route-public-api-scalars-v1.json
  - test/route-stage-classifier.test.ts
---

# Hub Model Routes

This document defines agent-hub's replacement route design for issue #1352. Its
inputs are the project's configuration, operational contracts and nonported
consumers. It is a newly authored rewrite. R1 covers
stage evidence and deterministic fallback; R2 owns the remaining route decisions
and judge/prompt replacement; R3 retires the derived modules, their upstream
checker and the corresponding Apache license/notice. The unrelated Tabler Icons
notice remains in the package.

**Review basis:** the recorded R1 contract review for issue #1352 accepted the
ownership split, packet bounds and numerical contract. The sizing
characterization and conservative arithmetic were approved, and the task path
plan was expanded before new unit/consumer/test edits. Source, test and spec
review preceded commits and remote checks. The four fresh units and approved
consumer wiring implement this contract; validation conclusions remain bound
to their exact-head receipts. Accepted design choices are not measurements of
implementation equivalence or runtime behavior.

## R3 retirement

The active route implementation uses the owned `stage-*`, `turn-state`,
`conversation-view`, `observation-signals`, `escalation-control`,
`advisor-trigger`, `plan-execute-choice`, `judge-choice`, `judge-replies` and
`hub-prompts` modules. R3 removes the replaced source-port modules and their
ported vector suites, the upstream checker, and the corresponding Apache
license/notice. The owned `stage.ts` compatibility re-export remains.
`RESERVED_SIDECAR = 3` keeps the unused port offset stable; no listener is added.
The Tabler Icons notice remains packaged. This retirement changes no routing
behavior, configuration grammar or generic decision-evidence v1 payload.

## Decision ownership

| Question | Owner | R1 status |
| --- | --- | --- |
| Which eligible model and reasoning effort should serve a stage or plan/execute request? | adec's configured policy, candidate constraints, pins and decider | Existing optional consumer for `decision`; S2 asks the stage question only inside the ambiguity band (below); plan/execute choice stays future |
| Which model/effort should serve an optional judge choice? | adec where separately configured, with an in-house fallback | R2 question design and wiring; no R1 judge request |
| Whether to escalate, request an advisor review, or issue redo feedback | Hub route policy | Preserve the caller boundary; implementation replacement belongs to R2 |
| Whether a task is PII and which peer receives it | PII screen and pure `assign()` | Outside model-choice routing; no adec delegation |
| Which deterministic tier remains when no applicable service choice is applied? | Hub fallback | R1 pure, model-free implementation |
| Whether a turn may execute, use a tool, cross a privacy boundary or spend budget | Current host admission | A route score or service proposal grants no authority |

The active `decision` configuration supports `decision_backend = "adec"` and
`decision_mode = "off" | "shadow"`, default off. `enforce` remains a load-time
refusal naming the #554 follow-up. Shadow preserves the exact fallback model,
effort and forwarded conversation. This is separate from `stay_switch`, whose
existing off/shadow/enforce behavior remains supported. R1 adds no service-call
path, classifier option, gateway effort application, service launch or credential
reader. #554 S2 adds the opt-in stage classifier option and its ambiguity band
below; judge/plan-execute choice questions require later reviewed wiring (R2).

## Route contracts and compatibility

The slice references below record the R1/R2 ownership split. R2 now supplies
the owned host decision and judge implementations; R3 removes their replaced
source-port counterparts.

- `stage` produces stage evidence, a deterministic efficient/capable fallback and
  the existing session-aware switch plan. With `classifier = "decision"` it may
  also ask adec, and only when its own score sits in the ambiguity band; the
  answer is recorded and never replaces the fallback tier.
- `decision` currently uses the same fallback while optionally recording an adec
  proposal through the existing #813 consumer. A failed request, abstention,
  `no_candidate`, invalid pair or unavailable service leaves that fallback.
- `plan_execute` retains its documented capable planning and efficient execution
  boundary after the first mutation. Its replacement and optional adec question
  belong to R2.
- `advisor` retains bounded APPROVE/REDO review of eligible no-tool answers;
  `escalation` retains efficient start and same-category confirmation before a
  capable latch. Their triggers, parsing, prompts and judge backoff belong to R2.
- Explicit model overrides and class fixed-model selections bypass routes as
  before. A missing/retired route keeps the configured fixed-model fallback and
  existing diagnostics. Loading configuration never rewrites operator files.

Keep the current configuration keys: route `type`, `efficient`, `capable`,
`judge`, `confidence_threshold`, `hold_turns`, advisor/escalation settings, the
existing adec endpoint/policy/candidate/timeout keys and the S2 stage
`classifier` / `ambiguous_band`. Default stage configuration
remains efficient `fast`, capable `coding`, confidence threshold 0.5 and hold 2.
Candidate aliases/efforts remain constrained by the existing route parser and
response allowlist; R1 does not create a new policy alias. Doctor and
`ahub route explain` keep their existing fields and pure peer-assignment meaning.

Existing owned relay, local-worker, decision-route and doctor integration
expectations remain acceptance evidence. A discovered observable difference is
reported for an explicit spec/CHANGELOG decision before implementation proceeds;
a new scoring formula alone is not proof of compatible tier decisions. Old
source-port vectors are not an implementation or test oracle for this rewrite.

## Two separate evidence payloads

### Generic decision evidence, unchanged

The existing `buildDecisionEvidence(messages, dimensions, publicText)` function
and its #813 tests remain unchanged. Its version-1 `routing-decision-evidence`
JSON retains four finite dimensions, bounded screened public user/assistant/tool
fragments and screened tool identifiers. Its 8 KiB total cap, whole-source
screen-before-cut rule, 64 KiB source ceiling, per-fragment caps and recent-tool
limits remain its own contract. It never includes full history, system/developer
instructions or tool arguments. R1 does not silently replace this payload or add
new stage fields to it.

### Stage evidence, newly authored

A separate pure builder produces `StageEvidence` for deterministic fallback and
future stage-specific adec questions. This packet contains only closed numeric,
boolean and categorical data. It contains no source fragments, transcript,
command, tool argument, path, tool name, diagnostic text or service error prose.
It is not sent through the generic decision route by this delivery.

Closed schema:

```ts
type StageTier = "efficient" | "capable";
type StageTurn = "user" | "tool_result" | "compaction" | "other";
type FaultClass = "none" | "reported" | "exception" | "critical";
interface StageEvidence {
  schemaVersion: 1;
  kind: "stage-route-evidence";
  turn: StageTurn;
  incomplete: boolean;
  signals: {
    results: number;
    failures: number;
    repeatedFailures: number;
    reads: number;
    mutations: number;
    assistantTurns: number;
    tests: "none" | "pass" | "fail" | "unknown";
    fault: FaultClass;
  };
  dimensions: {
    severity: number;
    spinning: number;
    exploring: number;
    productionIntensity: number;
  };
  scores: { efficient: number; capable: number };
}
```

All dimensions/scores are finite numbers in [0, 1]. Counts describe only inspected
input, are nonnegative integers, and never imply a complete-history count.
The following inspection limits are accepted contract choices from review, not
implementation measurements or permission for an undocumented behavior change:

- Inspect the latest 64 messages and at most 16 completed tool results.
- Inspect at most 32 tool-call entries in total across that window, by bounded
  array positions. A large `tool_calls` array does not permit a full traversal,
  copy, reverse or sort before the cap is applied.
- Call/result identifiers are at most 128 UTF-8 bytes and tool-family names at
  most 64 bytes. Match using a table of at most those 32 inspected calls and 16
  results. Missing, duplicate, oversized or unrecognized associations remain
  unassociated; no repeated search through older calls fills the gap.
- Text inspection has a 64 KiB aggregate UTF-8 budget across the capture and at
  most 32 inspected text-part entries. Oversized/over-budget sources are omitted
  before classification and mark the input incomplete. Neither nested content
  arrays nor tool-call arrays can turn an output cap into unbounded inspection.
- A stage packet has at most 1024 serialized UTF-8 bytes. Counts reflect inspected
  observations only. Malformed/over-cap input is incomplete or unavailable;
  neither a source fragment nor an arbitrary property enters the packet.
  Before service HTTP, measure the serialized non-generic numeric packet with
  `Buffer.byteLength`; overflow is unavailable and sends no request. This is a
  whole-packet refusal, not truncation, and does not change generic decision
  evidence v1 or its separate 8 KiB contract.

The local input view is separate from provider transport. It captures supported
roles, call/result association, explicit outcome flags and bounded local text for
classification; it never mutates, trims, summarizes or replaces the forwarded
conversation. Tool arguments are opaque to the stage packet. Local-only
compatibility data needed by remaining R2 consumers is not part of this schema.
Local-only families include recognized reads, mutations, executions and unknown
actions. Execution recognizes only bounded names `bash` and `exec_command`; it
never inspects arguments. An associated result may carry its local assistant
frame index to count distinct assistant turns. Neither that index nor the
execution family adds a serialized StageEvidence field. The latest non-instruction
message fixes the current boundary: an assistant-only or invalid tail is `other`,
not an earlier tool result or user compaction. An invalid tail also marks input
incomplete; system/developer entries retain their instruction-skip semantics.
A diagnostic fingerprint may be used transiently to detect repetition; neither
its source text nor an unbounded fingerprint list is emitted. A later public
projection uses the closed packet above. A sensitive projection contains only
`schemaVersion`, `kind` and the four dimensions, with no turn category, counts,
scores or incomplete-history information; R1 creates no transport for either.

Reviewed classification contract:

- Count observations within the fixed recent-result window. Unknown tool
  families remain unknown; source words are evidence, not authority.
- Explicit error outcomes and recognizable diagnostics determine a closed fault
  class. Successful inspection output quoting an error does not by itself become
  a critical failure. Execution results containing `segmentation fault` or
  `out of memory` are critical even when the wire omits `is_error`. These phrases
  do not turn an unflagged successful read into a failure; an explicitly flagged
  read error remains a failure. Passing tests clear the corresponding current test-failure
  evidence, while an unrelated failure is not erased. `signals.tests` is the test
  outcome of the latest inspected completed result; a later ordinary read is
  `none`. Chronological pass processing still clears retained test-category
  failures at that position. A historical pass cannot reset a later compaction
  hold.
- A repeated failure means at least two matching failed results in separate
  observations. `repeatedFailures` is the largest matching group among retained
  failures, including both observations, not every line of one diagnostic as a new
  attempt. An unrelated success or a different failure does not erase that group;
  a passing test clears only retained test-category failures. Retained groups
  and `signals.fault` describe the inspected window, not a new failure on every
  assessment. Failure-group spinning divides that largest group by the retained
  failure count only while a failure is current at a tool-result boundary. A zero-failure pass summary stays successful unless an
  explicit error outcome or a separate diagnostic establishes failure. Counted
  zero-failure forms such as `0 tests failed` are excluded before fault detection.
  An explicitly empty run (`0 passed, 0 failed`) is unknown test evidence, never
  a passing recovery that clears retained failures. Recovery requires a positive
  pass count, or an entire affirmative line matching `tests passed`,
  `all tests pass` or `all tests passed` (singular `test` is also accepted), with only
  surrounding horizontal whitespace and an optional final `.` or `!`. Substring
  matches, negated statements and additional prose do not establish an
  unqualified pass. This is a closed lexical grammar, not a language inference.
- Active severity maps the latest completed diagnostic to `0/0.3/0.7/1` at a
  current tool-result boundary; user, compaction and other boundaries have no
  newly completed failure. `signals.fault` remains the retained-window maximum.
  Exploring and production intensity remain inspected read/mutation proportions;
  empty denominators yield zero, not NaN.
- A consecutive streak of eight successful executions across at least eight
  distinct associated assistant turns, without a read or mutation, contributes
  ambiguous spinning 0.46 at a tool-result boundary. A genuine pass, failure,
  read, mutation or unknown family breaks the streak. The local assistant-frame
  count prevents one batched call from manufacturing eight turns. The calibration
  values 0.46 and eight come from the owned benchmark note and corpus, not the
  former implementation: owned #637 corpus rule
  `stage-spinning-below-threshold-stays-efficient` and the
  [model-routing promotion note](../agent-notes/benchmarks.md#model-routing-promotion-rule-637-part-2).
- The fallback risk score is `max(severity, spinning)`; capable score is
  that value and efficient score is its complement. Read/mutation dimensions are
  retained as evidence for future adec questions, not a second hidden tier picker.

Review accepted the bound and score contract above. If retaining an owned
integration expectation requires a different rule, the contract records that
choice before code/tests are authored; no undocumented recalibration is accepted
as an implementation detail.

## Deterministic fallback and session switching

Pure API, with state explicit and no I/O:

```ts
interface FallbackStagePolicy {
  confidenceThreshold?: number;
  holdTurns?: number;
  ambiguousBand?: number;
}
interface FallbackStageState { recoveryHoldRemaining: number }
interface FallbackStageResult {
  tier: StageTier;
  source: "default" | "dimensions" | "override" | "hold";
  score: number;
  state: FallbackStageState;
}
captureStageInput(source: unknown): StageInput | undefined;
buildStageEvidence(input: StageInput): StageEvidence;
selectFallbackStage(
  evidence: StageEvidence,
  policy?: FallbackStagePolicy,
  state?: FallbackStageState,
): FallbackStageResult;
ambiguousStage(
  result: FallbackStageResult,
  policy?: FallbackStagePolicy,
): boolean;
```

Omitted fallback policy fields use the existing confidence 0.5 and hold 2
defaults; an omitted policy is the same convenience. This changes no serialized
evidence field or configuration grammar. `ambiguousBand` belongs to the
question trigger below, not to the tier picker.

`StageInput` is a local-only bounded view, not a service DTO. Capture accepts the
existing message-array and relay-body-with-messages forms; unsupported source
shapes return unavailable without mutating them. The `confidence_threshold` and
`hold_turns` configuration keys map to the new policy names. An omitted state
starts with zero residual recovery hold. The source category is translated only to the
existing route-event categories above. Secondary exports for token estimation
and stay/switch planning retain the argument/return boundary exercised by their
nonported consumers, with newly authored internals; their compatibility
facade and wiring were pinned in the plan after contract review.

The result carries the tier, finite scalar score, a closed reason/source and a new
state. The builder/selector call no model, service, clock, process, file or global
session store. A caller retains state per route/session/configuration; another
session cannot inherit a hold, and a configuration change resets that state.

Fallback priority is explicit compaction, a current critical failure or an
active retained repeated-failure group, then residual configured recovery hold,
then a score above `confidence_threshold`, then an efficient default. A clean
step consumes residual hold rather than rearming an old group. Only a genuine
pass at the current tool-result boundary releases residual hold; retained
unrelated diagnostics remain, and a historical pass on a user, compaction or
other boundary never releases it. Equality/insufficient evidence uses the
declared default; no classifier runs inside the selector. Invalid input cannot
invent an alias or defeat the host's ordinary fixed fallback.

The effective enforced hold has a user-turn boundary floor: recovery remains
pinned through the tool loop until the next user boundary, and `hold_turns` can
extend it past that boundary. It is not a promise of exactly two following model
calls. The fallback's residual hold and the switch planner's session pin remain
separate; off/shadow preserve the owned recorded fallback decisions even when
the shadow plan would stay. Passing-test recovery and session isolation keep
their owned consumer expectations. This preserves the distinction between a
fallback proposal and the effective enforced backend.

Keep the existing switch contract: off and shadow do not change the fallback
choice; shadow adds only a proposed trace. Enforced stay/switch permits recovery
at once, holds a tool-result loop on its pinned tier, and considers other tier
changes at a user/compaction boundary. A downgrade over the configured prefill
bound stays pinned. A tier whose backend cannot fit the whole conversation is
not selected. The existing default prefill limit remains 32000. Sensitive turns
have no text-size-based switch bound and omit `prefillTokens` from events.

The input-token estimate remains an estimate used by existing context admission,
not a tokenizer claim. It covers the whole forwarded conversation and tool
schemas; the bounded recent stage view is never substituted as a full-context
size. An incomplete inspection cannot masquerade as a smaller complete input.
Its compatibility behavior and supported message/tool shapes must be pinned from
owned caller expectations before replacement; no route gains permission to trim
input or silently reduce output headroom.

### Ambiguity band, the question trigger (S2)

`ambiguousStage` answers one question: may this stage route ask the service at
all? It is `abs(score - confidenceThreshold) <= band`, with
`confidenceThreshold` defaulting to 0.5 and `AMBIGUOUS_BAND_DEFAULT` 0.05
(`AMBIGUOUS_BAND_MAX` 0.5 for the `ambiguous_band` key). At the default
threshold the owned repeated-execution reading 0.46 lies four hundredths inside
the band, while a reported failure 0.3 and an exception or critical failure 0.7
and 1 lie two tenths or more outside, so the default asks only for the
indecisive middle. A band outside `[0, 0.5]` and a non-finite threshold or band
are never ambiguous: an invalid value can only reduce asking, never invent one.
`ambiguous_band = 0` asks nothing, and `0.5` covers the whole score range at the
default threshold.

Membership is the whole of the band's effect. It never changes the fallback
tier, the fallback state or the source category, and the answer is recorded as
the route event's decision fields while the heuristic's model, effort and
forwarded conversation stand. The key is accepted only with
`classifier = "decision"`, whose one value is `"decision"`; a `stage` route
without it has no classifier and builds no service payload. The question offers
exactly the route's two tiers, since a tier carries no effort: `efficient` and
`capable` with effort `none`, the heuristic's own tier sent as `current`. One
question is asked per user turn, reused through the tool loop and dropped at the
turn's end.

The question carries R1's own closed `stage-route-evidence` packet
(`schemaVersion`, `kind`, `turn`, `incomplete`, `signals`, `dimensions`,
`scores`), never the generic `routing-decision-evidence` v1 projection, whose
quoted conversation fragments that contract does not allow; a PII or private
turn carries the `sensitiveStageEvidence` view of `schemaVersion`, `kind` and
`dimensions` only. The per-turn reuse keeps the privacy and observer facts an
answer was computed under: a later call republishes the held answer only while
those facts still hold, drops it when they change, and lets an unreadable
authority read propagate as `DecisionPolicyChangedError`.

### Secondary API pins

The new units define the public compatibility types/functions; `stage.ts` becomes
a freshly authored re-export facade, containing no former implementation body.
In particular `CodingAgentDimensions` is defined in `stage-evidence.ts` with the
four existing numeric fields, and `estimateInputTokens` is an export of the new
input-sizing unit. The generic v1 builder/test imports keep their existing path
and behavior; the freshly authored facade remains an owned compatibility API.
R3 removes derived implementations and migrates remaining type-only consumers
to owned types without changing generic v1 evidence bytes.

```ts
type StaySwitchMode = "off" | "shadow" | "enforce";
interface StaySwitchPolicy {
  stay_switch: StaySwitchMode;
  max_switch_prefill_tokens: number;
}
type StageSwitchReason = "new_pin" | "compaction" | "context_fit" |
  "same_tier" | "override" | "tool_loop" | "prefill_bound" | "user_turn";
interface StageSwitchTrace {
  turnType?: Exclude<StageTurn, "other">;
  prefillTokens?: number;
  staySwitch?: "shadow" | "enforce";
  plan?: "stay" | "switch";
  reason?: StageSwitchReason;
}
interface StageSwitchResult {
  tier: StageTier;
  pin: StageTier | undefined;
  trace: StageSwitchTrace;
}
estimateStageInputTokens(
  messages: readonly unknown[], tools?: readonly unknown[],
): number | undefined;
planStageSwitch(
  policy: StaySwitchPolicy | undefined,
  pin: StageTier | undefined,
  fallback: FallbackStageResult,
  turn: StageTurn,
  admission: { inputTokens?: number; fits(tier: StageTier): boolean },
): StageSwitchResult;
```

`DEFAULT_STAY_SWITCH` remains shadow with a 32000 prefill bound. Configuration
continues to reject unknown modes, nonpositive bounds and misplaced nested
keys. The eight reasons and five trace keys above are enumerated by
`docs/events.md`; no additional public reason is invented. Off emits turn type
and applicable public prefill only, omitting staySwitch/plan/reason. Shadow emits
the proposed trace without applying its tier. Enforce applies the existing
recovery/tool-loop/user-boundary rules. Fit remains the host's predicate; a fit
constraint can prevent an otherwise proposed tier. Unknown input does not gain a
new legacy trace turn category merely because the stage packet permits `other`.

The initial `new_pin` establishes the current tier and records `plan: "stay"`,
including sensitive routes; it is not a switch from an earlier tier.
The owned relay/runtime assertions pin initial `new_pin`, recovery `override`,
compaction, tool-loop stay, prefill-bound stay and user-turn switch. The event
contract additionally retains `same_tier` and `context_fit`; this audit does not
claim a new runtime observation of those branches. Relay/local traces share the
same estimator and planner. Sensitive planning omits input size and the prefill policy bound; local
capacity admission remains independent. Neither helper selects an alias, moves a
backend for load, applies effort or changes permission authority.

The sizing alias must use exactly the same computation for the supported owned
relay/context/decision shapes. Supported inputs include complete ChatMessage
arrays (string/null content and function-call/result metadata) and the published
JSON tool schemas. It returns a finite nonnegative integer for an available
estimate, covers the whole input, and never reports a partial recent-window
count. Unpinned shapes round up or conservatively overestimate. Overflow or an
unrepresentable input is explicitly unavailable, not zero, NaN or another small
count; a numeric compatibility call reports a closed sizing-unavailable failure
so the host can refuse capacity admission without disclosing source text.

The read-only helper audit found no independent nonported input-token forecast
in the examined OmniRoute client/usage, relay/MLX/Ollama, local and hub context/
usage helpers. `normalizeUsage` is post-request accounting and `contextHeadroom`
uses native occupancy; neither replaces an input forecast. Reuse the existing
`AutoRouteSelector` fit predicate, relay input-plus-requested-output admission
and `validateOllamaOptions` limits instead of duplicating their headroom policy.

### Whole-wire sizing arithmetic

Root accepted the single public-API observation and this newly authored,
conservative sizing rule under `41435398`:

- Form a local description containing the complete messages argument and, only
  when provided, the complete tools argument. An undefined tools argument has no
  tools field; an empty list remains present.
- Use ordinary compact JSON escaping for that description and count the UTF-8
  bytes of the whole representation. Count all message/call/result and schema
  data needed by that representation, not the bounded recent StageInput view.
- One forecast unit covers four encoded bytes; any remainder rounds upward.
  This is a conservative input estimate, not provider tokenization or billable
  usage. The same function supplies relay, context and decision callers.
- Supported inputs are plain JSON-compatible message/tool data. Cycles,
  executable accessors/custom serialization, unsupported values, unsafe counts
  or resource/serialization overflow are unavailable. Never return a small
  partial count. The physical sizer uses the existing relay's 2,000,000-byte wire
  ceiling as an overflow bound, independently of the 64 KiB stage-feature cap.
- `estimateStageInputTokens` returns a finite nonnegative integer or unavailable;
  its numeric `estimateInputTokens` compatibility export reports a closed
  sizing-unavailable failure instead of passing a fabricated number into an
  unchanged consumer. Existing host fit/output-headroom guards stay authoritative.

On the 24 newly authored fixtures, this rule equals 23 observed scalars and gives
39 for the Unicode fixture whose former public API returned 27. Every result is
at least the observed value. This Unicode conservatism is intentional: capacity
fallback/refusal or a prefill-bound stay may happen earlier than with the former
approximation, without dropping or modifying input. Record that difference in
CHANGELOG. No unique absolute-count pin was found in the inspected owned caller
assertions; their fit outcomes and relay/local equality still remain authority.
A later discovered owned absolute pin must be preserved explicitly.

## Host route policies and model-choice observation (R2)

This section defines the R2 integration contract for review before shared wiring.
The self-contained helpers and focused receipts are separate from acceptance of
that integration. It adds no permission to consult the protected route bodies,
source-port vectors or `src/hub/ports.ts`. R1's four stage units are owned inputs;
R3 retires the derived implementations, provenance checker and corresponding
license/notice, and preserves reserved port offset 3 under a neutral name.

### Configuration and service ownership

Use the existing top-level `decision_backend`, `decision_mode`, `policy_id`,
`adec_endpoint`, `candidates` and `decision_timeout_ms` keys. A `plan_execute`
route with a valid optional service binding asks the phase-model question; an
`advisor` or `escalation` route with a valid binding asks the judge-model question.
An ordinary route without that binding keeps its host policy. No `judge_choice`
block or other TOML key is introduced. Service fields that are present must form
a valid binding rather than being silently ignored. Every supported choice path
defaults off, accepts shadow and refuses enforce at load with the #554 follow-up.

One common service validator checks the existing backend/mode, bounded policy
identifier, numeric-loopback `/v1/route` endpoint, timeout and alias/effort options.
The S2 stage classifier, tier offerings, ambiguity band/defaults and stage-specific
validation retain their existing behavior. It does not turn into the phase or
judge route. The memo purposes are `stage`, `decision`, `phase` and `judge`,
separated by purpose, route, scope, configuration and opaque user turn. S2's
one-stage-question-per-turn held answer remains its own contract. Phase/judge
observation does not cache a valid pair as applied host authority; the service
rechecks its own pins and hard rules.

All these questions use policy-backed `POST /v1/route`. No generic ask or
System One shortcut is added. The host owns whether to review/escalate,
APPROVE/REDO, feedback, PII screening and peer assignment. A configured service
chooses only eligible model/effort pairs; off/shadow leaves the actual fallback
model, effort and forwarded conversation unchanged. Explicit model overrides
continue to bypass optional choice. The two shipped policy examples are
`ahub.stage` and `ahub.plan-execute` under `templates/adec`; the person supplies
provider, aliases and residency and copies policies into their own adec home.
The hub neither reads nor writes that home or a provider key.

### Numeric question evidence

The proposed ordinary R2 packet is closed and contains no transcript or arguments:

```ts
type HostChoicePurpose = "plan_execute_model" |
  "advisor_judge_model" | "escalation_judge_model";
interface HostChoiceEvidence {
  schemaVersion: 1;
  kind: "host-route-choice-evidence";
  purpose: HostChoicePurpose;
  phase?: "planning" | "executing"; // phase question only
  stage: StageEvidence;
}
```

The entire serialized packet must fit 1024 UTF-8 bytes at the request boundary.
Overflow is unavailable and sends no HTTP; no fragment is silently removed to
make it fit. `phase` and `judge` are memo purposes, not additional request-wire
fields. A sensitive request retains only R1's `schemaVersion`, `kind` and four
dimensions, with contextTokens zero; purpose, phase, history counts and text size
are omitted from its evidence. The request's opaque hashed turn identity still
separates purposes. Generic #813 decision evidence v1 and its tests remain
unchanged, including their distinct bounded-fragment contract.

### Host state and completed mutation

`PlanPhase.observe(view, scope)` starts capable/planning and adds the newly
written planning instruction. An associated, individually complete, non-error
mutation result establishes efficient/executing for that scope. Explicit failed,
denied, refused or cancelled results do not prove success. This is protocol
completion evidence, not filesystem-effect attestation. A clipped old history
does not block a complete current mutation; clipped/unknown current text cannot
prove completion. Once established, the scope latch survives later partial views.
A fresh or unavailable no-mutation view remains planning, not presumed execution.

`captureRouteView` reuses R1 association and diagnostics and adds only a local
`sourceTextComplete` observation. It uses the same bounded positions before R1
capture, rejects proxies/accessors/inherited data, and aligns captured results by
chronological tool ordinal. An inspected malformed record can make the local view
unavailable; that is unknown evidence, not proof that no mutation happened.
No completeness bit or other field is added to the StageEvidence wire.

The generic `ScopeStore` intentionally uses explicit 512-entry/one-hour limits:
expiry is since the last successful get or set, so active scopes renew their
idle lifetime and preserve established latches, execution phase, advisor budgets
and stage holds. Reads also update LRU order. Undefined values refuse, and a
backward clock clears all retained state. Opaque
local keys have a new 4096-byte ceiling. These explicit defaults/expiry semantics
are declared choices where the former default/clock behavior was not observed;
they are not claims of measured equivalence and belong in CHANGELOG.

### Advisor and escalation authority

Advisor uses a separate 1024-entry FIFO budget ledger and 1024-scope FIFO stalled
set, not the generic ScopeStore. The `instance` budget entry is never evicted.
A pending reservation is charged immediately; success keeps the charge, failure
refunds one and increments failures. Omitted review budget is one, and three
failed reviews block further review. Check budget before either trigger.

The ordinary primary trigger is a terminal no-tool answer with at least the
configured completed tool-result count (omitted minimum zero). The pattern primary
uses the configured Unicode regular expression instead. Assistant-message count
supplies stall turns. Omitted/zero stall is disabled; a positive threshold offers
a checkpoint at or above that count only when the scope is not already stalled.
Only a stall without a simultaneous primary marks the checkpoint. Success does
not rearm it. Failure settlement, budget-refused reservation and explicit eviction
clear the checkpoint. Automatic budget eviction deletes only its ledger entry;
the stalled set keeps its separate FIFO lifetime.

The capacity correction is intentional: only inserting a new key into a full
ledger trims that ledger. Same-key updates and unrelated-ledger operations cannot
evict charged reviews or rearm stalled scopes. Record this difference in CHANGELOG.
Escalation confirms two fresh same-category replies by default. Explicit old or
negative evidence breaks the streak, category change restarts it, unavailable
reply preserves it and an established latch remains set. Store no judge reason
in event or confirmation state. Runtime accepts only the checked reply parser's
output, never an assert-cast foreign verdict.

### Full local judge context and fresh prompt wording

`captureJudgeConversation` projects full inert native string/null messages,
function-call/result metadata, local opaque argument strings, instruction order,
assistant/tool counts and terminal-answer facts. It is separate from the recent
stage window and the service packet. It rejects malformed/explicitly unknown
fields instead of assembling partial judge context. The actual relay/local caller
must establish the supported native shape; unsupported formats are unavailable,
not blanket claims that every provider format is malformed. The existing 2M-byte
whole-wire ceiling applies before prompt construction and admits all valid
200000-codepoint cases. Getters, custom serialization and proxies do not execute.

Advisor transcript default is 200000 Unicode code points, with the existing
256..200000 validator. Serialize instructions first and messages next as JSON;
then retain floor(cap/4) points at the head and the remaining cap points at the
tail, separated by `\n...<middle of the conversation truncated>...\n`. The marker
is outside the cap. Only afterward append the latest-turn suffix without a byte
cut. Discarded telemetry counts code points. This preserves the recorded main
behavior rather than introducing a new transcript default. Advisor output is
2048 tokens; escalation output is 256. Its owned input window is the most recent
12 assistant turns with their following tool results, the closest preceding user
task, and system/developer instructions. Bound each serialized message to 1500
Unicode code points with an explicit middle-drop marker, then bound the assembled
transcript to 16000 code points including its middle-drop marker. Fixed prompt
and turn headers stay outside those bounds. Discarded telemetry counts omitted
original transcript code points, excluding inserted markers. These owned bounds
retain history for repetition/false-progress assessment while limiting one large
result's share; they provide no live quality or eight-second latency guarantee. Surrounding planning,
review, escalation and redo prompt wording is newly written; the owned caller's
short `senior reviewer` feedback cue remains.
The fresh request bytes invalidate former live request digests for these prompts.
Keep historical receipts unchanged; the new prompt-quality live leg is manual
and UNRUN, without a model call or restamp. Model-free protocol tests do not
establish real-model judgement quality.

Reply parsing is anchored APPROVE/REDO after optional leading Markdown/quote
decoration and an optional `Verdict:` prefix, case-insensitive. Closing verdict
decoration is removed before REDO feedback. Arbitrary leading prose remains
unparsed. Escalation accepts one optionally JSON-fenced object with the documented
consumed fields and closed categories. Unused extra keys remain ignored as before;
surrounding commentary or multiple objects refuse. New accepted-data ceilings
are 64 KiB reply input and 4096 bytes local feedback/reason; oversized input is
unavailable, not a partial verdict. These safety ceilings are declared in
CHANGELOG rather than described as observed former defaults. No prompt, reason,
argument, diagnostic or native identifier enters the numeric service packet.

### Owned observation outcomes and existing progress fences

`observation-signals` follows the owned R1 evidence/diagnostic precedence and
shared critical predicate, not former signal tables or source-port fixtures.
A full outcome batch must not be reported as complete from the recent 16-result
stage window. Unknown/over-bound input stays unavailable and omits an unproven
`next` label rather than inventing an all-clear value. Local native projection
uses the existing 2M whole-wire ceiling; native progress retains its existing
28-observation/name-80/text-500/source-40/turn-120 caller bounds.

The local adapter has explicit per-result facts: `readOnly`, `nativeError`,
`assertionDiagnostic`, `testInvocation` and `testMention`, plus the owned
`diagnoseStageResult` result. Read-only classification includes the owned
`text_editor` operation `view`; command/argument inspection is bounded and local,
never part of StageEvidence or service evidence. A missing/ambiguous association
or malformed flags do not establish a qualified complete batch.

- A successful read/view creates no execution failure, test failure or digest.
  It also does not clear prior qualified test failures.
- Otherwise the shared R1 critical classification has first priority (severity
  1). An explicit native error, AssertionError diagnostic or R1 exception has
  local label severity 0.7. Other reported diagnostics retain 0.3, except an
  unflagged test-failure-only report without those stronger flags is test evidence
  only, with label severity zero. This preserves the owned wrapped numeric-test
  fixture containing `exit code 0` without treating that text as native exit
  attestation. This label adapter does not change stage severity or scoring.
- A test context is an owned test-invocation name/command or an observed test
  term. A qualified failure in that context is retained across the full batch;
  an unrelated execution failure is retained separately. Process all results in
  chronological order. Only a non-read, non-error genuine positive test pass
  accepted by R1's closed grammar clears retained test-category failures, not
  unrelated failures. A commandless result may also inherit a retained qualified
  failure from the exact same declared tool/operation name, within this batch or
  across consecutive decisions in the same tracker run. Its own result must pass
  R1's closed positive-pass grammar, and this inherited pass clears only that
  operation's qualified failures. No retained failure, a different operation or
  an explicit non-test command supplies no inherited test context. This preserves
  recovery labels without turning arbitrary numeric migration summaries into test
  evidence. Numeric failure takes priority over a simultaneous positive pass
  count. An empty zero/zero run creates no pass and clears no failure.
- The tracker's existing private prior-failure entries extend their digest with
  a declared operation name only for qualified test failures. Names are bounded
  to 256 UTF-8 bytes; an oversized/unavailable name cannot grant inherited context.
  Entries retain the existing two-million-byte source admission and at most
  `2000000 / 20` result-entry ceiling. The metadata has the existing decision/turn
  lifetime and is removed when cleared or the turn ends. No arguments, result
  text, diagnostic fingerprint, persisted state, configuration or event field is
  added. Prior context only qualifies the new batch's observed pass; it does not
  copy an earlier batch's severity into a later outcome.
- Retained qualified test failure means `tests: "fail"` even after later plain
  read or `ok` results. With none retained, the latest genuine qualified test pass
  means `pass`; a batch with no eligible test evidence means `none`. Ordinary rows
  do not replace qualified test evidence. This is an explicit LOCAL divergence
  from R1's `signals.tests`, which describes the latest inspected result.
- Retain only SHA256 digests of the owned R1 diagnostic fingerprint for qualified
  failures. Diagnostic text and raw fingerprints are transient local values,
  never state/event fields. Repetition still passes the existing separate native
  cross-turn predicate before progress judging. No source-port calibration is
  inferred from these owned fixtures.

The fresh local APIs are `ToolObservation` (name plus optional command/resultText/
isError/source), `projectOutcomeBatch(assistant, tools)`,
`priorFailureDigests(messages)`, `failureFingerprint(text, isError)` and
`repeatedObservationFailure(observations)`. A batch projection returns bounded
severity, pass/fail/none and failure digests, or unavailable. The runtime obtains
assistant count from its complete JudgeConversation and phase from PlanPhase;
this is not a new general tier-picking ToolSignals formula.

Native `progressDimensions`, its eight-distinct-known-turn rule, cross-turn
failure predicate, attempted-frame deduplication, generation, owner/open-task and
privacy fences remain unchanged. Only owned observation/reply/type dependencies
migrate. Peer-reassignment advice remains a host inference purpose; this change
does not add an adec path to pure peer assignment or PII screening.

### Deadline, currentness and publication ceiling

For optional host judges, fallback has priority and does not wait for the shadow
model-choice answer. Priority means invoking the existing fallback execute port
before observer admission starts, after private common campus/currentness
preparation. The actual house quota transaction runs before that port's first
await; this does not attest downstream provider/GPU generation order or a custom
asynchronous host's physical admission. One absolute deadline covers common preparation and the judge/observation window;
there is no fresh timeout after a slow admission. The current common budget and
campus APIs cannot be cancelled: the deadline races them, it does not join them.
There is no strict physical eight-second completion or zero-pending-common-host
claim. Keep a `ponytail:` ceiling naming the optional abort/currentness API upgrade
if an actual hang is observed. No LocalWorker or OmniRoute API edit is part of
this approved choice. The separately owned `requestAdecRoute` observation is
aborted and joined when fallback finishes. A normal window close is not a failed
service memo or warning; actual failed transports keep bounded failure handling.
Cleanup always aborts the fallback signal even when observer close propagates an
authority or teardown error; preserving that error never skips the abort.

Re-read current actor/privacy/observer facts after awaits and before owned service
HTTP, metadata publication and feedback delivery. Changed/unavailable authority
propagates as `DecisionPolicyChangedError`; it is not converted into fallback or
swallowed as optional telemetry. Review/remote observer exclusion skips service,
and sensitive work requires positive campus admission. A client abort does not
prove the external service stopped provider generation.

The sole additional event field is `RouteEvent.decisionTarget?: "judge"`.
Absence preserves the executor event contract. A judge-choice observation uses a
separate existing `onRoute` callback: `tier` is the requested fallback judge
alias, `source` is `default`, and the remaining metadata uses existing checked
decision fields. It does not claim a served or applied model and adds no purpose
or phase field. Publication bypasses `addDecision` and the executor label path,
with no label, progress or usage credit. Off emits no observation. Recheck
privacy/currentness immediately before publication; sink failures stay optional,
but authority refusals are not swallowed as telemetry errors.

Before emission is enabled, executor consumers exclude `decisionTarget: "judge"`:
the report before timestamp/switch accounting, task research before generic
accumulation/peer involvement, and the owned routing corpus harness before its
last-executor-observation collector. This changes no corpus input, guard, expected
result or scoring. The raw research-quality `events.present` census remains a
truthful count of recorded event types, including metadata; it is not business
or executor credit. Token/cost and SDLC measures retain their separate inputs.
The closed operational projection already withholds the entire `route` kind,
while raw event export retains the target; this adds no console/display feature.

### Internal model-free lifecycle proof seams

An optional third `HubRouteRuntime` constructor proof port may receive
`choicePrepared(ready: Promise<void>)`. The promise is derived from the actual
owned observation result after selection settles; it exposes no choice data,
permission or cancel method, and readiness alone does not attest a valid choice.
The original result is still awaited and confirmed independently. Proof-sink
failure is isolated. With the port absent, no readiness promise is created.
There is no RouteHost, LocalWorker, OmniRoute, configuration or event-field change.

`ChoiceWindow.commonSettled` reports consumption of common preparation fulfillment
or rejection; close does not join it. This lets a controlled late-common test
release its host barrier and await consumption directly without elapsed-time
waits or guessed event-loop turns. The separately started owned HTTP task remains
the only abort-and-join claim.

The owned model-free routing harness has optional `beforeJudgeReply`,
`choicePrepared` and `observeRoute` proof ports. A value-only optional
`turnContext` binds one controlled fake logical user turn using the existing
trusted begin/end API, with end in finally. Its fixture must explicitly name the
owned loopback fake service endpoint, never an implicit default. Default absence
retains canonical missing-turn/no-HTTP behavior; no native/provider/person identity
or inferred multi-user lifecycle is introduced. The first pauses a scripted reply
only after execute arguments have been recorded; the last receives a detached,
frozen copy and has no return authority. An optional `observeExecute` read-only
tap similarly receives a detached/frozen snapshot of the actual requested model,
messages, judge flag and maxTokens arguments, never the signal. It is invoked
only when supplied, introduces no default clone/await/promise, and cannot alter
scripted replies or scoring. Exact host-input JSON bytes are compared, not
claimed as native/provider wire. The execute API has no effort argument, so no
effective/served effort value is invented. Absent ports introduce no new await or
readiness promise in canonical corpus execution. These ports do not change corpus
cases, expected outputs, splits, guards or scoring. Integration proof must still
show an actual judge-target event, off-mode absence and identical actual model,
input, judge-call count and last executor observation; a fulfilled void readiness
promise alone cannot satisfy it.

The test and report name is normalized event parity. In controlled judge-choice
off/shadow comparisons, executor events must be JSON-byte-identical after canonicalizing only `ms` and the opaque decision UUID
through a validated one-to-one mapping, with identical presence, count and type.
Every other field matches exactly. Actual execute model and input stay raw
byte-identical; the execute API exposes no effort argument to normalize or invent.
Judge observations are separate, one per admitted observation call and none when
off. No clock or UUID generation seam is added.

### R2 observation and inspection record

One approved public-API observation ran on committed baseline
`78891c179954f80adc90bec716f9f78107a2e872` with 24 newly authored synthetic cases,
no account/model/decider call, no dependency installation and scalar-only output.
The private guarded driver/fixture/command have distinct hashes; Git blob bindings
identify the opaque baseline APIs. All 24 scalar rows passed the closed collector;
network/process/server/output/write effect counters were zero, native-network and
owned-canary guard controls passed, source bindings matched before/after, and
owned stop/drains/temp cleanup succeeded. This is finite API evidence, not general
implementation equivalence, routing quality or live acceptance.

The committed fixture is `test/fixtures/model-route-public-api-scalars-v1.json`.
The exact argv is retained privately at workspace-relative
`scratchpad/temp/task856/public-api-scalars-v1/command.json`, SHA256
`43e1c7919945847f9d2859822901e42e6418f52488faa90417bacbd5f2395a4d`;
its raw result log SHA256 is
`e9790c07cae5e974cdc9695b08ecf7099bf72d2679a1a747bfc18078a57cb338`.
The fixture's redacted command shape is not executable; an exact-argv reference
requires that retained artifact, not an invented public reproducer. No additional
API probe, model call or TTL wait is implied.

On 2026-11-10 a conductor instruction mistakenly allowed AdvisorGate and text
helper reuse. The AdvisorGate class, one named stall test and the middleDrop
exported signature were read under that instruction. The helper body was not
read, and its temporary import was removed; truncation is newly authored from
the owner's literal behavior contract. The own advisor unit was written and
reviewed against that contract, including the later capacity correction, without
copying a ported function body. An earlier broad historical-doc search exposed
advisor behavior notes; review preparation also exposed limited excluded inventory
expression/key-pattern metadata after initial algorithm commits. These exposures
are recorded as process limits, not represented as unread history. No further
protected body, prompt, vector or ports read/import was authorized under R2.
This is a newly authored rewrite with explicit provenance. R3 removes the derived
implementations and their corresponding license/notice; this process record
remains historical evidence.

## Native progress projection, separate from stage selection

The nonported progress observer has a different public calibration from stage
routing. Its newly authored `progressDimensions(observations)` accepts the
observer's bounded native observations, not legacy ToolSignals or StageEvidence.
It inspects at most the existing latest 28 observations and bounded name/result/
native-turn fields; it does not inspect commands or tool arguments. It emits only
`severity`, `spinning`, `exploring` and `production`.

- An observed error has severity 0.7, including an AssertionError that stage
  fallback treats as a reported failure. Stage scores do not recalibrate this
  observer.
- Recognized reads and mutations contribute their proportions among inspected
  observations. A completed Codex `fileChange` is mutation/production evidence.
- Spinning becomes 1 only after at least eight distinct known native turn IDs
  with no observed mutation in the retained window; otherwise it is zero.
  Missing IDs and repeated tool observations within one turn do not manufacture
  separate attempts. Productive file changes do not become a spinning trigger.
- The existing repeated-failure-across-native-turns predicate remains separate.
  Current privacy, open-task/owner, in-flight generation, latest-frame,
  attempted-turn deduplication and judge/latch fences remain unchanged. A progress
  dimension grants no execution, reassignment or model-routing authority.

This replacement removes the observer's dependency on the former stage helper.
At the R1 boundary, generic decision evidence v1 and the remaining legacy route
signal/judge code were unchanged. R2 supplies the owned signal/judge replacements;
R3 removes the replaced modules. Generic decision evidence v1 stays unchanged,
and the existing owned progress tests remain acceptance authority. The existing
progress observation type is exported as `NativeToolObservation`, including its
optional native `turn`, for host callers; this adds no runtime or event field.

## Privacy, authority and events

Off mode builds no service payload and sends no request. Local fallback features
may still be computed. Before any future stage service payload is built or sent,
the host must apply the current privacy/observer admission. Review-observer
exclusion and remote turns skip the service. PII/private evidence requires
positive `onCampus()` and remains dimensions only even on campus. The decider's
payload/constraints redact context size to zero and expose no stage counts or
text-size feature. That zero is a decider-payload privacy rule, not permission to
bypass existing local/backend context or requested-output headroom checks.
Physical fit admission still considers the whole actual input under its existing
host limits; neither the redacted zero nor a stage-window count is used to admit
an oversized request. The switch planner still omits the sensitive prefill-based
policy bound and trace as described above. Unknown/changed facts
refuse the stale turn, rather than becoming a service failure fallback. Recheck
admission, campus, request and metadata-emission awaits and the original turn
binding. A proposed pick grants no execution or release authority.

Keep current route-event keys and value categories: `route`, `tier`, `source`,
`score`, `ms`; optional decision/turn/task/PII linkage; four numeric dimensions;
existing stay/switch trace; existing decision-mode/alias/effort/margin/latency and
screened decider fields. `source` keeps its current override/dimensions/hold/
classifier/default/decision categories (relay reorder sources remain owned by
the relay). Add no text, arguments, prompt, credential, server error prose or new
unbounded diagnostic field. Labels and telemetry remain optional and cannot
change a route or turn through a sink failure.

The S2 stage question uses those fields and adds none. `source` already carries
the escalation judge's reclassification under `classifier`, so a stage answer
never sets it: the fallback's own category stands and the answer rides the
decision mode, alias, effort, margin, latency, reason and screened decider
fields. Shadow records and changes no tier; abstain, `no_candidate`, a transport
failure or timeout, `decision_mode = off` and an off-campus decider for a
PII/private turn each keep the fallback tier and record a closed reason. An
optional question cannot refuse a turn by itself: a service failure or an ended
turn records nothing to apply. Changed or unavailable privacy or observer
authority is not a service failure, so it keeps refusing the stale turn exactly
as on a `decision` route, never as a model fallback around that refusal.

## Bounded public sizing characterization

Conductor decision `41435398` permits one bounded, model-free, network-free and
account-free characterization of the public `estimateInputTokens` API. Inputs
are newly authored synthetic fixtures shaped by owned caller contracts; outputs
are scalar estimates only, including finite nonnegative fractional baseline
values. Integer/round-up requirements apply to the new estimator; a valid older
fraction is not discarded to make that requirement appear already satisfied.
The former implementation body, function text,
upstream vectors and error stacks are not inspected. This is public-API
observation for compatibility; it does not authorize reconstructing expressions
from source.

The reviewed preparation is under workspace-relative
`scratchpad/temp/task855/sizing-v1`. Root approved its corrected fixed command
before the one invocation. The baseline is committed code
at `2219e9dbd5861d87bc4bddbe857b3bbfd7a9a07c`, identified separately by its Git
tree/module blob. The new private driver, fixture and command have their own
hashes; the untracked contract document and private probe are not labelled as
verified code from that commit. No dependency installation is included.

The characterization used 24 fixtures (78803 JSON bytes, under a 128 KiB
bound), with an 8-second worker wall bound, 3-second CPU bound and 16 KiB closed
scalar-output bound. A private HOME/cache/cwd, empty npm configuration, no-auto-
install flag, kernel no-network/credential restrictions and transport/process/
output guards surround the import. An owned synthetic read-open canary is used;
no real credential file is read. Arbitrary stdout and all stderr/stacks are
excluded from the retained scalar record. The worker is addressed only through
its own created process handle, with bounded stop and source-binding checks.
Only the driver's own closed failure phase and optional authored fixture id
survive an unsuccessful response; error objects, prose and stacks do not.
The single invocation completed with exit 0, owned stop and drained output,
with all 24 finite nonnegative scalars accepted (fractional values were allowed).
Baseline/component bindings passed before and after. Observed baseline effect
counters were zero; guard and owned-canary controls passed. The result SHA-256 is
`d551376c2959c948792f34985c44fca5bb4c602c56062f6a1321919b5ee953e9`.
This is scalar API compatibility evidence, not routing-gain, model or account
proof.

This is a 24-scalar CPU-bounded probe, not a heavy gate. The Mac placement reason
is the Seatbelt no-network/real-home fence, with ordinary successful work expected
below the roughly four-second remote synchronization cost; that expectation is
not a timing measurement. If preparation indicates greater normal cost, a remote
alternative needs approval rather than an implicit local fallback. Actual local
invocation requires fresh complete resource/thermal/ownership admission.

The new estimator must be at least each observed scalar on every authored
fixture and exactly satisfy values pinned by owned tests. Unsupported/unpinned shapes round up or conservatively overestimate;
overflow remains unavailable. The arithmetic was written in our own words
before production implementation. The authored inputs and expected scalars are
committed as our fixture at `test/fixtures/model-stage-sizing-v1.json`. The PR
records that the former function was observed only through its public API.
No second characterization, model request or quiet/no-op follow-up is implied.

## Historical R1 implementation and consumer map

This section records the R1 boundary before R2 replacement and R3 retirement.
Fresh stage-only units were added under the reviewed task plan:

| Unit | Responsibility |
| --- | --- |
| `src/models/route/stage-input.ts` | Bounded local input capture, turn kind and token-estimate compatibility |
| `src/models/route/stage-diagnostics.ts` | Own diagnostic classification and transient repetition keys |
| `src/models/route/stage-evidence.ts` | Closed StageEvidence builder/validation and public numeric projection |
| `src/models/route/stage-fallback.ts` | Pure fallback state and stay/switch planning |

The following API map comes from nonported consumer source, not the replaced
implementations:

| Consumer | Existing boundary to preserve |
| --- | --- |
| `src/models/route/runtime.ts` | Stage state, tier/default/hold source, dimensions, token estimate and stay/switch result; R2 normalize/signal/review branches remain separately owned |
| `src/models/route/relay-selector.ts` | Stage result, session pin, fit predicate, source mapping and switch trace; backend override/reorder remains outside fallback |
| `src/models/relay.ts` | Token estimate and StaySwitchPolicy type; context/output headroom and fixed alias order remain unchanged |
| `src/hub/routing.ts` | DEFAULT_STAY_SWITCH and StaySwitchMode imports; `assign()` and config grammar remain unchanged |
| `src/adapters/local-worker.ts` | StaySwitchPolicy import; generic ToolObservation/research callback remains outside stage evidence |
| `src/models/route/decision.ts` | Four dimensions and token estimate; generic #813 evidence/transport/privacy fences remain unchanged |
| `src/models/route/decision-evidence.ts` | Four-dimension type dependency only; its function, payload and tests stay unchanged |
| `src/models/route/labels.ts` / `src/hub/inference.ts` | Remaining generic normalization/signal/fingerprint or Conversation consumers; migration/compatibility needs separate path approval |

At R1, `parseAdvisorVerdict` and legacy `text.ts` remained R2 work. Generic
normalization, signal/observation and outcome-label consumers still existed; R1
did not remove those bodies by assuming the stage route was their only consumer.
A small newly authored compatibility facade could retain an existing type/import
boundary where required by unchanged consumers. A replaced stage-function file
with no remaining consumer was removed without reading its removed body. The R1 PR listed retained
R2/R3 source-port files; R1 did not remove licenses/notices or upstream tooling.
R2 supplies the owned replacements and R3 retires the remaining derived modules
and vectors without reading or copying their bodies. Nonported integration
assertions remain in place, with owned type/import bindings where needed.

The precise new exports, compatibility facade and consumer wiring paths were
pinned in the board plan before production edits. The own unit tests are
`test/model-stage-input.test.ts`, `test/model-stage-diagnostics.test.ts`,
`test/model-stage-evidence.test.ts` and `test/model-stage-fallback.test.ts`, with
independently authored cases from this contract. Existing relay/local-worker/decision/doctor tests remain authority;
no source-port golden cases are read or copied. Seed review uses id/path/test
metadata only. Current route-directory seed count is zero; any consumer anchor
that wiring touches is reviewed/rebound without weakening its named guard.

### Owned benchmark binding migration (R2)

The existing model-routing benchmark binds its prompt identities to the fresh
exported host prompt constants. This is the R2 test-binding migration: assertions,
corpus vectors, splits, guards, scores and thresholds remain unchanged. The receipt
request builder captures the same completed advisor conversation and latest-turn
suffix as the runtime, and preserves the public conversation-turn marker. This
checks measurement fidelity; it supplies no live quality or promotion evidence.
