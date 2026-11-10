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
---

# Hub Model Routes

This document defines agent-hub's replacement route design for issue #1352. Its
inputs are the project's configuration, operational contracts and nonported
consumers. It is a newly authored rewrite. R1 covers
stage evidence and deterministic fallback; R2 owns the remaining route decisions
and judge/prompt replacement; R3 owns notice and remnant cleanup.

**Review basis:** the recorded R1 contract review for issue #1352 accepted the
ownership split, packet bounds and numerical contract. The sizing
characterization and conservative arithmetic were approved, and the task path
plan was expanded before new unit/consumer/test edits. Source, test and spec
review preceded commits and remote checks. The four fresh units and approved
consumer wiring implement this contract; validation conclusions remain bound
to their exact-head receipts. Accepted design choices are not measurements of
implementation equivalence or runtime behavior.

## Decision ownership

| Question | Owner | R1 status |
| --- | --- | --- |
| Which eligible model and reasoning effort should serve a stage or plan/execute request? | adec's configured policy, candidate constraints, pins and decider | Preserve the existing optional consumer; future stage-specific questions use the new evidence contract |
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
reader. #554 S2 and judge/plan-execute choice questions require later reviewed
wiring.

## Route contracts and compatibility

- `stage` produces stage evidence, a deterministic efficient/capable fallback and
  the existing session-aware switch plan.
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
`judge`, `confidence_threshold`, `hold_turns`, advisor/escalation settings and the
existing adec endpoint/policy/candidate/timeout keys. Default stage configuration
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
```

Omitted fallback policy fields use the existing confidence 0.5 and hold 2
defaults; an omitted policy is the same convenience. This changes no serialized
evidence field or configuration grammar.

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

### Secondary API pins

The new units define the public compatibility types/functions; `stage.ts` becomes
a freshly authored re-export facade, containing no former implementation body.
In particular `CodingAgentDimensions` is defined in `stage-evidence.ts` with the
four existing numeric fields, and `estimateInputTokens` is an export of the new
input-sizing unit. The generic v1 builder/test imports keep their existing path
and behavior until R3 retires that compatibility boundary.

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
Generic decision evidence v1 and remaining legacy route signal/judge code are
unchanged. The existing owned progress tests remain acceptance authority.

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

## Implementation and consumer map

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

`parseAdvisorVerdict` and legacy `text.ts` remain R2. Generic normalization,
signal/observation and outcome-label consumers still exist; R1 does not remove
those bodies by assuming the stage route was their only consumer. A small newly
authored compatibility facade may retain an existing type/import boundary where
required by unchanged consumers. A replaced stage-function file with no remaining
consumer is removed without reading its removed body. The PR lists retained
R2/R3 source-port files; R1 does not remove licenses/notices or upstream tooling.

The precise new exports, compatibility facade and consumer wiring paths were
pinned in the board plan before production edits. The own unit tests are
`test/model-stage-input.test.ts`, `test/model-stage-diagnostics.test.ts`,
`test/model-stage-evidence.test.ts` and `test/model-stage-fallback.test.ts`, with
independently authored cases from this contract. Existing relay/local-worker/decision/doctor tests remain authority;
no source-port golden cases are read or copied. Seed review uses id/path/test
metadata only. Current route-directory seed count is zero; any consumer anchor
that wiring touches is reviewed/rebound without weakening its named guard.
