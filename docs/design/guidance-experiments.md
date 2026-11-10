---
id: guidance-experiments
type: module
title: Immutable Guidance Variants
status: draft
parent: agent-hub-architecture
depends-on: [execution-reference, task-board]
references: [execution-reference, task-board]
implements: []
covers: [guidance-experiments]
tags: [agent-hub]
paths:
  - src/hub/roles.ts
  - src/hub/guidance-variants.ts
  - test/guidance-variants.test.ts
  - test/fixtures/guidance-variant-v1.json
  - test/guidance-variants-lifecycle.test.ts
  - test/guidance-variants-privacy.test.ts
  - test/guidance-variants-recovery.test.ts
  - src/cli/guidance.ts
  - src/ui/guidance-view.ts
  - src/ui/guidance-panel.ts
  - test/guidance-views.test.ts
  - test/guidance-control.test.ts
  - test/guidance-console.test.ts
  - test/guidance-pagination.test.ts
---

# Immutable guidance variants

This is the T1/T2 contract for [#1225](https://github.com/STAIxBWLB/agent-hub/issues/1225).
T1 represents a proposed change to one task role as immutable local data. Its
pure APIs do not persist an experiment. T2 adds Tasks admission and private
lifecycle storage. Neither slice creates a live role, rewrites a catalog, changes
a session, grants permission or runs a probe. Public CLI/MCP/console dispatch is
T3; actual confined handoff and probe receipts belong to #1226. Parsing establishes shape and binding comparisons, not semantic safety,
authority, testing, model consumption or improvement.

## Closed V1 record

`GuidanceVariantV1` has exactly these fields:

- `v`: integer 1.
- `id`: lowercase 64-hex content key.
- `projectKey`, `experimentId`: nonempty opaque identities. Project keys use the
  ExecutionReferenceV1 project-key bound; experiment ids use its id bound. There
  is no trimming, Unicode normalization, path interpretation or resolver.
- `taskId`, `taskCreated`, `flowRevision`: safe integers; id is positive and the
  existing task creation epoch and flow revision are nonnegative.
- `baseline`: exactly `{roleId, layer, sha256, bytes}`. The layer is `shipped` or
  `project`. `bytes` is the exact admitted UTF-8 role text, represented as a JSON
  string. `sha256` is its lowercase raw UTF-8 digest, including original spacing
  and final newlines. The role id must match the role file's flat header.
- `candidate`: exactly `{sha256, bytes}` with the same raw snapshot/hash rules,
  parsed for the baseline role id and layer.
- `author`: the existing local execution-link actor grammar with controls and
  unpaired surrogates rejected before that check, compared verbatim with the host
  context actor. It grants no role or authority.
- `rationale`: exactly `{problemHypothesis, expectedObservableDifference}`,
  containing nonempty prose-shaped strings.
- `evidenceRefs`: an ordered list of distinct ExecutionReferenceV1 addresses.
  Each address uses the existing closed producer parser and canonical key.
  References are inert declarations, not proof of existence, source-read
  admission, provenance or a resolver instruction.

Reject unknown fields, unsupported versions, accessors, proxies detectable by
Node's `types.isProxy`, symbol/nonenumerable properties, non-plain objects and
sparse/accessor/decorated arrays. Normalize only into new own-data objects; never
invoke a producer getter, iterator or `toJSON`. Successful parses clone and freeze
all record containers. This protects the admitted value from later caller
mutation; it does not authenticate a caller or make arbitrary host JavaScript
immutable.

| Bound | V1 meaning |
| --- | --- |
| Role file | At most 8192 UTF-8 bytes, using the existing role parser |
| Complete guidance | At most 2000 JavaScript UTF-16 units, including the existing task-role header; no truncation |
| Rationale | At most 2000 UTF-8 bytes of the complete canonical rationale object, including keys and JSON escapes |
| Full record | At most 32768 UTF-8 bytes of normalized record JSON, including id and both snapshots |
| Evidence refs | At most 16, with no duplicate canonical reference |
| Experiment variants | At most 16 historical keys, including withdrawn variants |

These are contract bounds, not tunable operational settings. Existing catalog
parse/render behavior remains unchanged. In particular, the role parser's body
limit and the complete `taskRoleText` limit retain their existing UTF-16 units;
they are not substituted with UTF-8 byte counts.

## Restricted source difference

`parseRoleDocument` first calls the existing `parseRole`. It then retains the raw
header including delimiters, the body prefix before Scope, and the six ordered
heading/content slices from the original text. Offsets are explicitly UTF-16
string offsets, not UTF-8 byte offsets. A section starts at its heading and ends
immediately before the next heading, including its own newline/blank/trailing
spacing. Evidence extends to the actual source EOF. The helper does not reuse the
parser's trimmed body to reconstruct admitted bytes.

The candidate must keep the raw metadata header, body prefix and every heading
line identical. Complete `Not in scope`, `Hub use` and `Review duties` sections
must be byte-identical. Only the content spans of `Scope`, `Deliverables` and
`Evidence` may differ. Existing code/tool text in protected baseline sections
stays unchanged if the original role parser admits it. No canonical reconstruction
or sanitization is used to excuse a protected-byte change.

Editable content and rationale use a conservative prose-shaped grammar:

- Lines are blank ASCII-space lines or sentences, optionally prefixed by one
  `- ` bullet. A nonempty sentence starts with a Unicode letter and ends with
  `.`, `!` or `?`.
- Characters are Unicode letters, marks and numbers, ASCII spaces, and only the
  ASCII punctuation `. , : ; ! ? ' " ( ) / -`. Tabs, carriage returns, controls,
  format characters and unpaired surrogates are excluded.
- Reject `--`, an identifier directly followed by `(`, hub/channel header syntax,
  fences/backticks, headings, links/HTML, braces/brackets, variable, assignment,
  pipeline and escape syntax.
- Reject command-shaped leading executable tokens, including the existing role
  parser's command vocabulary plus common Node/package/shell executors; reject
  code-statement prefixes such as import, function, const and await. The source
  validator defines the exact closed vocabulary for V1.

This deliberately declines some harmless formatting. It recognizes a lexical
shape, not the meaning of natural language or every possible custom executable.
A prose sentence can still be unsafe, false or manipulative. Mandatory host tool,
permission, privacy, routing and role policy remain authoritative; review and
later Tasks admission are still required. A model-supplied origin or confidence
flag cannot elevate this text.

## Content identity and current context

Canonical payload order is `v`, `projectKey`, `experimentId`, `taskId`,
`taskCreated`, `flowRevision`, `baseline`, `candidate`, `author`, `rationale`,
`evidenceRefs`. Nested objects use the field order shown above; references use the
existing parser's field order and retain their declared list order. The key is
SHA-256 of UTF-8 `JSON.stringify(["agent-hub.guidance-variant/v1", payload])`,
excluding only `id`. Both raw snapshots, actor and rationale are part of the
identity. Reordered producer properties produce the same key; changed content
cannot reuse it. A digest is not an attestation.

`GuidanceVariantContext` is separate host-owned data with exactly
`projectKey`, `experimentId`, `taskId`, `taskCreated`, `flowRevision`, `actor`,
`baseline`, `currentBaseline` and `variantIds`. Its baseline is the experiment's
frozen admitted snapshot, never a live catalog value silently substituted into
an old experiment. `currentBaseline` is a separately obtained current
`roleIdentity`: `{id, layer, hash}`. Record baseline, frozen snapshot and current
catalog identity must all agree, and the record/frozen raw bytes must agree.
A current baseline change requires a new experiment binding.

The validator compares author to host actor and all supplied project/task/epoch/
revision/experiment fields exactly. It does not discover the task, authenticate
an actor, know whether a host snapshot is fresh or recheck policy across awaits.
T2 must build the context from current authorized owner data and recheck its live
fences before effects. Producer-supplied context or a matching string is never
Tasks authority.

`variantIds` is the host's full historical key set for that experiment, including
withdrawn records. A new key at sixteen refuses; an identical existing key can be
revalidated at the cap. This is a pure cardinality check. T2 still owns storage,
original-record replay, withdrawal intent, audit history and prevention of later
probe use. T1 performs none of those effects.

## Pure API and readback ceiling

- `parseGuidanceVariantV1(value)` checks closed shape, raw hashes, restricted diff,
  grammar, content id and full size without host context.
- `validateGuidanceVariantV1(value, context)` adds exact host binding and historical
  cardinality checks. Its actor comparison is not authorization.
- `guidanceVariantKey(payload)` validates the unsigned closed payload before
  computing its deterministic key.
- `renderGuidanceVariantV1(value, review)` self-validates and delegates to existing
  `taskRoleText`. Historical rendering is untrusted advisory data, not a claim
  that the experiment is current or that the text may be handed to a model.

There is no file read, catalog loader, Board/Tasks construction, memory operation,
clock, model, subprocess, network, probe or live configuration write in these
functions. T2/T3 must screen public metadata and enforce source/task privacy before
exposing ids, counts, rationale or snapshots. A stored historical record cannot
be activated by parsing or rendering it. Missing/denied source equivalence and
actual-handoff receipts remain with their owning later boundaries.

`test/fixtures/guidance-variant-v1.json` contains independently authored role and
mutation vectors and one complete wire record/key generated with Python's
standard-library SHA-256 and compact UTF-8 JSON, without the target validator.
The companion test also constructs expected keys with Node crypto independently
of the validator, covers protected-byte differences,
opaque references, host drift, UTF-8/UTF-16 boundaries, aggregate JSON size and
inert/frozen containers. These conformance vectors do not claim semantic safety, native consumption or
measured runtime improvement. The T2 fixtures separately exercise the lifecycle
and privacy admission described below.


## Tasks lifecycle and private persistence (T2)

Only `Tasks.guidanceVariantCreate`, `guidanceVariantRead` and
`guidanceVariantWithdraw` admit lifecycle operations. `guidanceVariantApplicable`
is a fresh read predicate for a later confined probe boundary, not handoff,
activation or model-consumption evidence. T2 adds no CLI, MCP, console dispatch,
model route, probe runner, role assignment or effective configuration change.

Creation accepts a complete closed V1 record. Its first successful transaction
freezes the experiment's baseline in `guidance_experiments`; immutable canonical
variant bytes and their digest live in `guidance_variants`. Both tables are
private local hub state, separate from `Task`, refs, plan, history, public task
views, bus notices and memory. The experiment key is the host project key, task
id, task creation epoch and experiment id. The variant key adds its content id.
No read interprets an opaque address as a locator, URL or path to resolve.

Write authority follows task-role admission: the person or the task's current
rostered owner with the configured base for its class. An agent cannot write
under review; every actor is refused on an approved or cancelled task. A
conductor designation alone grants no write. Creation additionally requires the
current task role and class-compatible current catalog identity to match the
record and frozen experiment. A changed baseline requires a new experiment;
neither a retry nor a catalog reload silently rebases an existing one.

Task epoch, flow revision, owner, state, task role, catalog identity, repository,
current task privacy and authenticated request/session authority are checked
before reads and again after configured local privacy screening, immediately before
the synchronous transaction. Known input/admission refusals are pre-effect only;
unknown storage, wrapped write or readback failures remain ordinary fixed safe
errors, including a transaction that rolled back. They never authorize an
adapter to assume safe automatic retry. Existing configured local privacy screening may
inspect new proposal text; unknown or failed screening refuses. There is no new
generation or model route. A present-but-unknown native session-generation port
refuses. The request also fences replacement peer objects, native session and
current delivered-input identity. These are current-operation fences, not
persisted session attestations or permanent authority on the immutable record.
The future probe boundary must capture and revalidate its own runtime/turn facts.

Private turns, review-observer input and PII task state refuse all actors before
experiment identifiers, counts or bodies are read. Reads use the existing task
visibility boundary, including its staged-task restriction. Missing, denied,
corrupt and unsupported ordinary reads share `{state: "unavailable"}`. Public
task views never gain snapshot fields.

The lifecycle read result is a closed metadata projection, not the private stored
record. It contains experiment/variant identity, task epoch/revision, author,
role id/layer, baseline/candidate SHA-256, changed editable section names,
baseline/candidate/record byte counts, declaration/withdrawal status, current
applicability, and canonical evidence digests with declaration availability.
Neither raw role snapshot, attribution header, body, evidence address nor private
creation/withdrawal actor/time metadata is returned. An unrelated deny policy
cannot make a valid shipped role disappear because its protected attribution
contains a path.

Only the two rationale texts and caller-opaque experiment id are field-screened
on this read path, using existing pure
nameable/secret/lexical policy behavior. A field that does not clear is the
literal `withheld`; it does not hide the variant or change applicability. Under
active path policy, path-shaped rationale without alias proof is withheld as a
field. Reads do not invoke `publicMetadataText`'s filesystem discovery, a model or
an address resolver to manufacture that proof. Other closed enum/id/hash metadata does not pass
through the opaque-address/path heuristic. The experiment id remains its exact
immutable private identity, not a hash or a renamed key. Its public field is the
raw id when clear and literal `withheld` otherwise; this does not hide the
variant or change applicability. The same field projection applies to creation
and withdrawal receipt echoes, so narrowing privacy never sends an old private
id back merely because a write succeeded. Raw snapshots remain private local
state and never become public merely because a field is withheld.

Admission precedes duplicate lookup. An unchanged duplicate returns the original
record and original attribution without writing only while current create
admission still holds. A stale original create refuses; authorized historical
readback is separate and can return `applicable: false`. Concurrent identical
creates converge on one row. Sixteen historical variant ids include withdrawn
ones; there is no experiment-count cap. No task-list scan is introduced in T2;
T3 owns bounded experiment-list pagination.

Withdrawal accepts a current task epoch/flow wrapper and an exact stored
experiment/variant id. It records one terminal withdrawal actor/time without
changing the payload or deleting history. Historical baseline drift does not
prevent this narrowing operation. An unchanged repeat preserves the first
withdrawal. Creation replay never clears it, and it always makes the variant
inapplicable. Closed tasks remain immutable. Withdrawal introduces no free text
and has no awaited screen between its final authority checks and atomic write.
It does not re-screen stored raw prose or a newly withheld rationale: it narrows
intent and returns only the closed receipt. Current task/turn privacy and exact
scope/revision/authority checks still apply.

The immutable declaration and host creation/withdrawal metadata remain in the
private store; public metadata applicability is evaluated separately against
current task/catalog context. After source-port reads, the task revision/role
binding, selected immutable and withdrawal metadata, and task privacy are read
again. A changed snapshot is unavailable. Current applicability and rationale
field projection are recomputed only after those fences.

Source references are declarations only. Their public keys are the existing
`executionReferenceDigest`, SHA-256 of the canonical reference, never
`executionReferenceKey`'s raw canonical JSON or an opaque producer address. An
exact currently visible local source can be labelled `declared`; missing,
denied, external and unsupported sources are all `unavailable`. Neither label
asserts testing, runner provenance, actual handoff, model attention, result
quality or improvement. Read and applicability paths invoke no model, network
or external resolver.

## Storage and controlled recovery bounds

Each normal read uses one indexed experiment key and at most seventeen variant
rows. The seventeenth is an overflow sentinel: it refuses corrupt storage rather
than returning a truncated complete experiment. SQL checks raw JSON byte lengths
before hydration, then validates canonical payload hashes, experiment bindings,
host attribution and paired withdrawal fields. First experiment plus variant,
and a withdrawal plus its status revision, commit atomically; refusals and
replays change no row, task history or status revision. Restart retains exact
immutable and terminal metadata.

The additive tables do not advance the database schema marker. Retained rows
require the `guidance_variants` recovery feature. A conditional digest covers
both tables, including withdrawn history; absent tables' data leave legacy
empty-state recovery integrity unchanged. Startup verifies canonical retained
state and a supplied recovery digest before accepting it as current. An unknown
compatibility or integrity read refuses instead of certifying an empty store.

Recovery alone streams ordered experiment keys, followed by each exact-key
variant page of at most seventeen rows, with bounded per-row/page memory. Its
total work is O(historical experiments), including the corresponding bounded
variant pages and orphan detection. This follows the existing full-stream
integrity convention. If measured recovery time warrants a change, the upgrade
is keyset pages with a verification budget; a partial scan must never certify
complete integrity. T2 adds no experiment-count cap, new recovery budget or
partial-scan success/refusal mode.

`test/guidance-variants-lifecycle.test.ts`,
`test/guidance-variants-privacy.test.ts` and
`test/guidance-variants-recovery.test.ts` use only scratch state and fake peers.
Their source assertions cover idempotent creation, atomic rollback, restart,
withdrawal, currentness/privacy narrowing, malformed stored rows, bounded SQL
hydration and conditional recovery metadata. These are fixture contracts, not a
native/live trial or a measured read-cost receipt; T3 and #1226 retain those
separate obligations.


## Public surfaces and editable-section diff (T3)

The four operations are `guidance create`, `list`, `show` and `withdraw`, and
`hub_guidance_create`, `hub_guidance_list`, `hub_guidance_show` and
`hub_guidance_withdraw` on CLI/MCP. The producer console is read-only in T3:
it agrees on list/show metadata and section diff, and directs mutations to the
CLI/MCP. All surfaces use the same Tasks admission and closed public reply
parsers. Creation takes a complete V1 record; the CLI reads an explicitly named
JSON file of at most 32768 UTF-8 bytes. No surface reconstructs private baseline
bytes from readback, rewrites an author or grants a proposal trust. Proposal
generation, activation and actual handoff remain outside this surface.

`guidance_views` advertises these operations separately from T2's retained-state
`guidance_variants` feature. An older daemon or plugin keeps its old behavior;
new callers refuse unsupported operations with upgrade/restart guidance. Every
control request with a rid receives a reply. There is no protocol-version or
schema-marker bump. Old task, role, private snapshot and T2 API records retain
their existing meaning.

### Selection and current binding

Public selection is `{taskId, taskCreated, id}`, using the existing variant
content id. Public experiment-id text is a label, never a selector: `withheld`
never becomes an experiment key. After current task/actor/privacy admission,
an additive task-scope/id index supports one exact lookup with LIMIT 2. Two
matches are ambiguous and refuse; raw experiment identity is resolved only
inside Tasks/Board. No new hashed experiment identity, unbounded scan or caller
actor/authority flag is introduced. Existing explicit experiment selectors
remain supported by the T2 library API.

List/show replies carry `current: {taskId, taskCreated, flowRevision}` separately
from the record's historical `flowRevision`. Withdrawal requires the current
wrapper revision, not the old proposal revision. A historical proposal remains
readable without becoming current or resurrecting a withdrawal. The server
rechecks this binding and current actor/session/privacy at effects and after
source-port reads. A displayed label or cursor grants no authority.

### List wire bounds

A page contains at most 32 public metadata records and at most 262144 UTF-8 bytes
of its complete guidance-page JSON payload. Transport wrappers and the shared
human rendering remain separate surface framing. SQL uses the task-scope/id index, `id > after` and
LIMIT 33. The extra row is an overflow sentinel, not a truncated complete page;
raw stored JSON is byte-bounded before hydration. Duplicate variant ids within
the task scope refuse as ambiguous rather than being lost at a page boundary.
There is no experiment-count cap, OFFSET scan or whole guidance-history hydration.
Existing owning-task visibility and source-evidence context reads remain in use.

The optional cursor is at most 512 ASCII bytes. Its closed payload carries a
version, last public variant content id and HMAC signature. The signature binds
the host project namespace, authenticated actor, task epoch, current flow and
last id using the existing host-only cursor key. Raw experiment ids and global
row ids never enter the token. A changed scope, task flow or signing generation
requires refresh without the cursor. Pages are bounded current reads, not a
frozen snapshot across concurrent additions; refresh to include newly inserted
earlier ids. Privacy is applied before any identifier or count is exposed.

### Separate section-diff reply

`Tasks.guidanceVariantDiff` returns one public metadata record, its current
binding, and the three editable section names with baseline/candidate text
fields. It does not widen the T2 metadata-only read or list projection.
Only Scope, Deliverables and Evidence bodies may cross this boundary. Each
whole field first passes current pure nameable/secret/lexical policy, then
`sanitize()`. A refusing, unknown or oversized field is literal `withheld`;
it does not hide safe metadata or change applicability. There is no per-line
screen, partial truncation, model screen or filesystem/address resolution.
Each section field remains within the existing 8192-byte role ceiling.

The same raw-first field guard also covers inherited T2 reads and create/withdraw
receipt labels: nameable and secret checks examine the original string before
JSON escaping, then the existing pure lexical policy runs. A pattern spanning
an actual newline therefore withholds the whole field instead of disappearing
behind JSON escape characters. Safe metadata and applicability remain available.

The protected section names Not in scope, Hub use and Review duties are shown
as unchanged by T1 construction, with no body. Raw headers, attribution,
body prefix, protected bodies, full snapshots and opaque evidence addresses
never enter a public reply. Rendered diff text is untrusted advisory presentation,
not exact private bytes for a new record or proof of testing/model consumption.

### Surface authority and side effects

CLI create/withdraw keep the authenticated peer and refuse delegated
`--live-test` person promotion. MCP schemas are publication only; Tasks parses
closed input again. Private/review input, current task PII, read-only mutations,
recovery and shutdown cannot be bypassed by a peer field or an old connection.
All four guidance tools exclude arguments and results from capture and do not
count as owner task progress. Reads start no probe, model, delivery or memory
write. An unknown write or malformed receipt is unconfirmed, never permission
for automatic retry.

The producer console has its own Guidance panel and dedicated pinned-project
manager port, separate from the dashboard action whitelist and candidate inbox.
Its dedicated manager port permits list/show only. No console mutation,
confirmation, person-metadata adaptation or snapshot token is introduced;
existing question/person/receipt helpers remain unchanged. A future console
withdrawal requires its own contract. Fixed CLI instructions do not execute
anything. Existing dashboard panels and their behavior stay available. The
panel renders the provider's shared lines as text, not HTML, and late responses
cannot replace a newly selected project/task view.

Source fixtures compare all three ports, field withholding, immutable legacy
records, SQL/keyset/reply bounds, source callbacks, actor/session/private guards,
old-feature refusal and capture/progress exclusion. The dogfood row records
actual source-only variant size/read cost after measurement; native/account
coverage and actual confined handoff remain separately unverified.
