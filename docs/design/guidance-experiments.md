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
---

# Immutable guidance variants

This is the T1 contract for [#1225](https://github.com/STAIxBWLB/agent-hub/issues/1225).
It represents a proposed change to one task role as immutable local data. It does
not create a role, rewrite a catalog, change a session, grant permission, persist
an experiment or run a probe. Tasks admission and lifecycle are T2; public
CLI/MCP/console views are T3; actual confined handoff and probe receipts belong to
#1226. Parsing establishes shape and binding comparisons, not semantic safety,
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
inert/frozen containers. These tests do not claim semantic safety, lifecycle,
public-view admission, native consumption or measured runtime improvement.
