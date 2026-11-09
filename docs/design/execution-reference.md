---
id: execution-reference
type: module
title: Execution Reference and Bounded Lineage
status: draft
parent: agent-hub-architecture
depends-on: [task-board, bus]
references: [task-board, bus]
implements: []
covers: [execution-reference]
tags: [agent-hub]
paths:
  - src/hub/execution-reference.ts
  - src/hub/execution-lineage.ts
  - src/hub/execution-lineage-owner.ts
  - src/hub/execution-links.ts
  - src/cli/lineage.ts
  - test/execution-lineage-admission.test.ts
  - test/execution-link-tasks.test.ts
  - test/execution-lineage-owner.test.ts
  - test/execution-lineage-control.test.ts
  - test/execution-lineage-cli.test.ts
  - test/execution-lineage-console.test.ts
  - test/execution-lineage-performance.test.ts
  - test/execution-reference.test.ts
  - test/execution-lineage.test.ts
  - src/ui/lineage-view.ts
  - test/fixtures/execution-reference-v1.json
---

# ExecutionReferenceV1

Source-owner contract for [#1220](https://github.com/STAIxBWLB/agent-hub/issues/1220).
T1 supplies an address validator, neutral vectors and a pure reader. T2 adds
Tasks admission and CLI/MCP wiring; T3 owns the console and measured performance.
The only new persistence is admitted, deduplicated external-reference metadata.
There is no automatic resolver, backfill or runtime polling.

## Address contract

An address is `{v: 1, tool, projectKey, kind, id, revision?, sha256?}`.
It names evidence; it does not attest to it or grant access to it.

| Field | Rule |
| --- | --- |
| `v` | Exactly the integer 1 |
| `tool` | Known producer id: `ahub`, `ares`, `amem`, `vmem` |
| `projectKey` | Opaque producer project identity, nonempty, at most 256 UTF-8 bytes |
| `kind` | Producer-namespaced by `(tool, kind)`, lowercase token matching `[a-z][a-z0-9._-]*`, at most 64 bytes |
| `id` | Opaque source identity, nonempty, at most 256 UTF-8 bytes |
| `revision` | Optional nonempty opaque source revision, at most 128 UTF-8 bytes |
| `sha256` | Optional lowercase 64-hex content hash |

Reject unknown fields, unsupported producers/versions, null optional fields,
control characters, unpaired surrogates, accessors, symbol keys and inherited
objects. Do not trim, case-fold or Unicode-normalize identity. Absent optional
fields stay absent. The producer vocabulary identifies owners, not enabled
resolvers: an unknown kind can be syntactically valid yet unsupported by its owner.
Consumers validate this boundary locally without importing hub internals or a new
shared runtime dependency. Neutral valid/invalid JSON vectors live in
`test/fixtures/execution-reference-v1.json`; UTF-8 limits include multibyte cases.

A path-like or URL-like id is still opaque data. Never open, execute, fetch,
route to another node or interpret credentials from any address field. A resolver
must separately select a known source owner and its authorized project; no
implicit node or project fallback is allowed. Every `ahub` node has the source
hub project key. A foreign producer key is allowed only on an admitted
`declared-external` target node, with declared strength. It stays verbatim and is
never compared with the hub namespace, resolved, fetched or used for routing.
The live hub derives its stable opaque source key once at startup from its existing
project identity; it does not emit a raw directory or use the per-start instance id.
Foreign roots and outgoing foreign edges are unsupported. The host supplies the
explicit admitted-target projection; a producer-supplied edge alone proves no admission.

## Pure source boundary

`readExecutionLineage(source, query)` receives a host-owned snapshot of an explicit
root neighborhood and returns values only. It does not construct a Board,
DeliveryJournal or CompletionStore (their constructors can write), read files,
call a model, spawn a process, probe, replay, fetch or write memory. The host reuses
already-open owner readers and explicit relationships to assemble the snapshot;
it must not scan the entire board on a read.

The host pins `id`, `revision`, `projectKey` and caller `scope`, source `health`,
source-read `authorized` authority, diagnostic authority and the explicit
`admittedExternalTargets` projection from saved public declarations. These are never
accepted from a producer or query. A snapshot contains metadata nodes and explicit
edges, already privacy-projected by the source owner. Each node carries its own
source reference, state token and evidence strength; no title, note, path,
session-native identifier or review body enters this projection. States keep
their owner's meaning: a completed dispatch is not a successful attempt; an
approved review does not change a failed attempt.

Evidence strengths are `declared`, `host-observed`, `runner-attested` and
`unknown`. Relations are `dispatched`, `attempted`, `produced`, `reviewed` and
`declared-external`. An edge is emitted only when both endpoints are visible.
An external declaration remains declared; a reference/hash never upgrades it.
The reader never infers edges from names, titles, timestamps, shared paths,
trace ids, current roles or matching hashes alone.

### Existing owner mappings and missing observations

| Existing relationship | Valid projection | Ceiling |
| --- | --- | --- |
| Task `offer.envelopeId` and matching journal `originals[].id` / `refs.task` | Task to explicitly scoped journal dispatch | Offer envelope ids are not journal row ids; no reverse discovery or invented dispatch state |
| `ExperimentAttemptRecord.attempt.taskId` | Task to research attempt | Does not identify the dispatch that caused it |
| Attempt id on output event and host observations | Attempt to output | Event is declared unless its stored owner observation proves more |
| Verified runner receipt `attemptId`, `protocolHash`, output name/hash | Attempt/output evidence | Preserve verified runner provenance; a runner output name is not a hub deliverable id |
| Review history `deliverables[].id/sha256`, `reviewedHead` | Output or recorded head to review | Historical exact-hash/head binding, not current approval of edited bytes |
| Journal `previousId` | Exact predecessor metadata | `attempt` is a retry ordinal, not a research attempt id |

There is currently no persisted dispatch-to-research-attempt relationship.
`JournalDelivery.out` is rendered input handed to a peer, not produced output.
The fixture modeling current record relationships therefore leaves this gap. A separate deterministic
full-chain fixture supplies an explicit `declared-external` edge and keeps that
edge declared. This proves traversal, not native causal coverage. T1 does not
introduce a new relationship writer to make the gap disappear.

## Bounds, privacy and pages

Pages contain at most 100 nodes, 200 edges and 262144 UTF-8 bytes of serialized
JSON, including metadata and cursor. A query can lower the node/edge ceilings;
its byte budget is between 4096 and 262144 bytes. Nodes and edges have independent
continuations: a page's edge may refer to a node in another page. Consumers combine
pages by the complete source reference and never label a truncated page complete.
Traversal follows only explicit edges in either direction from the named root.

After owner privacy projection, snapshot admission bounds query-local work to 2048 nodes, 4096 edges and 4 MiB of
projected metadata. Oversized sources are unavailable, not an empty or silently
partial successful graph. The owner must supply a complete indexed neighborhood
within this ceiling; larger graphs require a future owner paging contract.
This is a bounded projection ceiling, not a performance or full-board coverage claim.

The reader checks source authority before reading health, records or the root.
For callers without source-read authority, absent, denied and unavailable all
return exactly `{state: "unavailable"}`. Ordinary authorized readers get the
same shape for hidden or missing roots. Only an already authorized diagnostic
operator can see the closed reason `missing`, `corrupt`, `unsupported`, `withheld`,
`cursor_invalid` or `invalid`; never a hidden id, count or source prose.
Host privacy applies in the source owner's indexed read before assembling this
snapshot, so hidden rows never enter even its bound calculations or cursor.
Only the host supplies these snapshots; accepting a producer-supplied graph or
policy flags would violate this boundary. A hidden requested root is a source
`withheld` result. Hidden records neither consume public page slots nor create
dangling edges; a dangling edge in an admitted public snapshot is corrupt.

An available page has `{state: "available", nodes, edges, truncated, cursor?}`.
The cursor is an opaque continuation bound to source id/revision, caller scope,
root, limits and the visible graph. Changed source snapshots, privacy views,
roots or limits invalidate it. Cursor contents grant no authority. A cursor
is authenticated with a host-owned ephemeral HMAC key (32 to 128 UTF-8 bytes),
never a key supplied by a query. This reader creates or persists no key; key
rotation/restart invalidates prior cursors. Edited offsets are refused.
A cursor
must be used only with the same admitted source; on invalidation refresh from
the root. Source health failure is never a complete empty graph. No cursor is
returned on a complete page.

## Verification boundary

`test/execution-reference.test.ts` consumes the neutral vectors and pins closed
parsing. `test/execution-lineage.test.ts` pins explicit traversal, missing edges,
independent states, evidence ceilings, privacy, unavailable equivalence, bounded
pages and source/scope/root invalidation. Fixtures run without a daemon, native
agent or account. CLI/MCP and console equivalence, admission and review currency
are pinned by the T2/T3 tests below; native coverage remains unverified.


## Tasks admission and owner-scoped reads (T2)

`Tasks.linkExecutionReference` is the only external-reference write boundary.
The input binds the task id, its creation identity and current flow revision,
and one closed ExecutionReferenceV1 target. An optional `from` names an exact
local source node already in that task's bounded neighborhood; without it, the
source is the task reference. The current actor must retain the task role
and local project scope. PII tasks and private turns refuse before capture or
persistence. Current authority, task revision and privacy are checked again after
screening and immediately before the atomic write. Identical admitted metadata
returns the existing declaration; changed or stale admission never silently
rewrites an old record. A reference is inert declared metadata, never a runner
receipt or an external read instruction.

Reads expand the bounded admitted local neighborhoods to a fixed point before
emitting declared edges. A protocol or runner-receipt origin remains visible
regardless of declaration id order; expansion follows only those explicit links.

The table stores only admitted source/target reference metadata and its local task
binding. Its uniqueness key includes the canonical source and target, so repeated
admission preserves the original actor and timestamp without rewriting it. There is no derived relationship table, migration backfill or implicit
reverse-discovery index. Task roots resolve forward from their own task row,
current offer and recorded deliverables/reviews. Attempt roots resolve from their
own attempt row and its explicit task id, protocol, events and receipts. Dispatch,
deliverable and output roots require an explicit owning-task scope (id and
creation identity) and exact recorded membership in that task's row. Without it,
the result is unavailable, with `unsupported` visible only to diagnostic operators.
This is the historical-coverage ceiling for AC5, not a claim of missing records.
Owner-maintained derived indexes are the future upgrade path.

The read path uses only repository identities warmed at startup or by normal
Tasks mutations. An unknown refs identity is unavailable rather than causing a
Git or path probe. Its metadata screen is pure: when a private-path or deny policy
is configured, path-shaped fields and stored paths without cached alias proof are
withheld. A task with path/section selectors under a private-path policy is also
withheld. This conservative ceiling prevents a read from resolving symlinks or
probing a producer address; a future owner-maintained public metadata projection
can recover those slices without weakening privacy.

Attempt-event projection also requires a host-owned capability derived from the
current policy. Any configured PII path, local deny entry or routing PII pattern
makes raw event paging unsupported: neither zero filtered rows nor a longer raw
page proves a complete public neighborhood. This includes historical public
events whose fields a later policy narrowing would now withhold; the refusal is
data-independent and does not disclose whether such a row exists. Attempt/output roots and local
attempt/output traversals then refuse before event paging, including task-root
neighborhoods whose declarations require those records; they never return a
partial graph as complete. Task, head, deliverable and foreign declared metadata
remain available when their own privacy checks pass and no event source is needed.
This capability is not query-selectable. The upgrade path is a privacy-aware page
source supplying complete public metadata, not a derived privacy index, backfill
or unbounded scan added by T2.

No read infers an edge from a title, time, shared path or matching hash. The
missing dispatch-to-attempt observation remains missing unless a separately
admitted declaration explicitly names it; declared metadata never upgrades the
strength of surrounding evidence. Read operations never spawn, probe, fetch,
replay, write memory or admit a reference.

Historical review metadata stays visible only through its public source view.
Review currency binds the full reviewed public id/hash set and submitted head to the
latest public deliverable submission, using the existing delivery-history semantics.
Approved and changes-requested review copies are not new submissions. A public
replacement, addition or removal outside that reviewed set invalidates the old
verdict even when a retained artifact's hash and head are unchanged; reordered
identical sets remain equivalent. Wholly private or withheld submission updates do
not change public currency or cursor bindings. Historical evidence remains visible
under its original verdict and exact hash/head references. This is currency against
recorded public source metadata, not a blanket task approval or a live file or Git
freshness probe; unrecorded changes remain unknown. Source revisions and cursors
bind only the authorized public graph, never raw history counts or unprojected task
fields. A declared external reference cannot make a review current. Code-only reviews
retain an explicit recorded-head node even when no deliverable was submitted;
a head string alone is declared source metadata, not a Git observation. Review
state tokens retain the original verdict with a stale or unknown suffix when
its binding is no longer current or cannot be established.

T2 exposes diagnostic reasons only to the authenticated console person. Agents,
including the conductor, receive the neutral unavailable shape for denied, hidden,
invalid and absent reads; a global role never grants access to staged backlog ids.

The ordinary CLI/MCP surfaces share the same Tasks projection. Configured
read-only MCP sessions keep their existing publication list, and isolated
reviewers keep exactly their existing two tools. The new metadata-link operation
never becomes a read-only tool.

## Console surface and measured reads (T3)

The acon console reads lineage through a provider port, not a panel id and not a
dashboard action. `projectConsole(...).lineage` in `src/hub/manager.ts` sends the
console role's existing `lineage_show` control message, which the hub answers
in-stack from the same `Tasks` projection the CLI and MCP read. No protocol
message, panel id or action id is added: `manifest.panels` stays exactly
`DASHBOARD_VIEWS`, the advertised action list is unchanged, and an older console
that never asks for the view keeps working. Equivalent admitted views are
therefore a property of one read path, not a comparison of two.

`src/ui/plugin.ts` answers `snapshot({panel: "lineage", ...})` with
`{ok: true, panel: "lineage", lineage, lines}`. The lines come from
`executionLineageLines` in `src/ui/lineage-view.ts`, the same pure view
`ahub lineage show` renders, so one admitted page has one presentation. The CLI is
a terminal and applies `terminalText` at its own boundary; the console passes the
view's strings as data, and neither surface re-derives a page.

The query is the closed owner selector list (`taskId`, `attemptId`, `root`,
`task`, `cursor`, `nodes`, `edges`, `bytes`). A field outside it is dropped before
forwarding, and the manager refuses one that reaches it, because the hub's owner
parser refuses the whole read on an unknown field. The control message carries no
project, instance, panel or page-supplied field. Reading never becomes a
`ui_action`, and nothing on this path can link, probe, fetch, replay, spawn a
process or write memory: `lineage_link` is not reachable from the console.

An unavailable source is not an empty successful graph. The console returns the
unavailable page with its refusal line and never a node, edge or `Page complete.`
line. A reply that fails the closed shape check (`parseLineageResult`, shared with
the CLI) is refused as `{ok: false, panel: "lineage", error}` naming the
unsupported shape, so a page from a newer hub or a corrupted one is never rendered
as a complete graph.

`test/execution-lineage-console.test.ts` pins the equivalence (the console's lines
equal `renderExecutionLineage` of the same page), the exact control message, the
absence of any action and of any widened panel or action list, the drop of an
unnamed selector, and the refusals above. `test/execution-lineage-performance.test.ts`
is the AC6 receipt on a synthetic board: 200 samples per point at 0, 200 and 2000
filler tasks, a p95 under 250 ms, the same page and byte size at every board size
(the read projects one root's neighborhood, so the board around it adds nothing),
the 64-link per-task ceiling (65 nodes, 64 edges, within 262144 bytes), a 5-node
page truncating with an opaque source-bound cursor that a different node bound
refuses, and a 4096-byte page staying inside its budget. The recorded numbers and
the recipe that reproduces them live in `docs/dogfood.md`. Those figures describe
one host: a number measured elsewhere may differ, and a missing measurement is
unknown rather than zero.

Native coverage stays unverified. No running native agent produced these pages, so
the console and performance receipts are host and fixture evidence, not a native
lineage receipt.
