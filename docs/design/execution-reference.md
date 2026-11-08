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
  - test/execution-reference.test.ts
  - test/execution-lineage.test.ts
  - test/fixtures/execution-reference-v1.json
---

# ExecutionReferenceV1

Source-owner contract for [#1220](https://github.com/STAIxBWLB/agent-hub/issues/1220).
T1 supplies an address validator, neutral vectors and a pure reader. T2 owns
Tasks admission and CLI/MCP wiring; T3 owns the console and measured performance.
There is no new persistence, automatic resolver or runtime polling in T1.

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
implicit node or project fallback is allowed.

## Pure source boundary

`readExecutionLineage(source, query)` receives a host-owned snapshot of an explicit
root neighborhood and returns values only. It does not construct a Board,
DeliveryJournal or CompletionStore (their constructors can write), read files,
call a model, spawn a process, probe, replay, fetch or write memory. T2 must reuse
already-open owner readers and indexed relationships to assemble the snapshot;
it must not scan the entire board on every inbox poll.

The host pins `id`, `revision`, `projectKey` and caller `scope`, source `health`,
source-read `authorized` authority and diagnostic authority. These are never
accepted from a producer or query. A snapshot contains metadata nodes and explicit
edges, with a host policy `readable` decision on each. Each node carries its own
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
| Task `offer.envelopeId` and matching journal `originals[].id` / `refs.task` | Task to dispatch | Dispatch/handout observation, not model consumption |
| `ExperimentAttemptRecord.attempt.taskId` | Task to research attempt | Does not identify the dispatch that caused it |
| Attempt id on output event and host observations | Attempt to output | Event is declared unless its stored owner observation proves more |
| Verified runner receipt `attemptId`, `protocolHash`, output id/hash | Attempt/output evidence | Preserve verified runner provenance only |
| Review history `deliverables[].id/sha256`, `reviewedHead` | Output to review | Historical exact-hash/head binding, not current approval of edited bytes |
| Journal `previousId` | Exact predecessor metadata | `attempt` is a retry ordinal, not a research attempt id |

There is currently no persisted dispatch-to-research-attempt relationship.
`JournalDelivery.out` is rendered input handed to a peer, not produced output.
The real-record fixture therefore leaves this gap. A separate deterministic
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

Snapshot admission bounds query-local work to 2048 nodes, 4096 edges and 4 MiB of
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
Host privacy applies before emitted ids, relationships, counts and pagination.
Hidden records neither consume public page slots nor create dangling edges.

An available page has `{state: "available", nodes, edges, truncated, cursor?}`.
The cursor is an opaque continuation bound to source id/revision, caller scope,
root, limits and the visible graph. Changed source snapshots, privacy views,
roots or limits invalidate it. Cursor contents grant no authority. A cursor
must be used only with the same admitted source; on invalidation refresh from
the root. Source health failure is never a complete empty graph. No cursor is
returned on a complete page.

## Verification boundary

`test/execution-reference.test.ts` consumes the neutral vectors and pins closed
parsing. `test/execution-lineage.test.ts` pins explicit traversal, missing edges,
independent states, evidence ceilings, privacy, unavailable equivalence, bounded
pages and source/scope/root invalidation. Fixtures run without a daemon, native
agent or account. CLI/MCP equivalence, admission, review currency and native
coverage remain T2/T3 work; these fixtures do not claim those acceptance legs.
