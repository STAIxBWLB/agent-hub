# Headless Record integration (#1320)

This is a source and disposable-fixture receipt, with no live rollout. Agent-mem
0.23.1 is published and the hub source now imports its public `recordsEnabled`
accessor. The production path uses the active memory home and execution repository;
malformed, unavailable or unbound policy disables Records. No real memory home,
native account, model, provider or person profile was used.

## Published API boundary

Npm metadata identifies exact 0.23.1 at gitHead
`6b26a529989098aa9f8d5f0b6fa6625cd76e3662`, with integrity
`sha512-IJdymWpy5kVJgIpqCJyjCWBIFjdfXGS4cXGbdo6IojntvQIIlxspUxmFzARhe7rwDrOpSaDx4yMdnckSfEzBag==`.
The [public barrel](https://github.com/STAIxBWLB/agent-mem/blob/6b26a529989098aa9f8d5f0b6fa6625cd76e3662/src/index.ts)
exports `recordsEnabled(base, cwd?)`; its
[implementation](https://github.com/STAIxBWLB/agent-mem/blob/6b26a529989098aa9f8d5f0b6fa6625cd76e3662/src/memory/config.ts)
uses the same machine/repository narrowing as native hooks. Either false disables,
missing configuration enables, and malformed configuration throws. The boolean
revision binds only this flag; fresh package and hub screens still guard current
privacy independently. The fixture override is host-only, not a project setting.
New disposable production-path cases cover both false-inheritance directions,
malformed machine/repository config and late revocation. These cases passed in
the production-source run below.

## Verified source boundary

- The package owns `RECORD_INSTRUCTION`, Record grammar and `CaptureStore`.
- Instruction sampling follows owned input and the busy transition, once per
  managed headless turn. Claude, isolated reviewers, native-client prompts and
  steer keep their existing paths.
- Only complete, current public final answers can append Record rows. Tests
  cover owner/turn/session/generation/profile/policy drift, PII/private/review/
  invocation/remote exclusion, monotone unsafe-steering exclusion and current
  package/hub screening before storage or read selection.
- Stripping precedes shared envelopes, digest rendering, invocation result
  handling and console envelope taps. Explicit send tools retain their old
  route. Invalid lines are stripped too; ordinary text and priority remain.
- Only successful, cleared `Tasks.note` writes supply generated-note IDs and raw
  anchors. Manual remember, failed/withheld/private/PII writes, foreign-repository
  ambiguity and incomplete anchor metadata provide no replacement proof.
- Replacement preserves unrelated/protected notes and the old byte footprint.
  Complete known rows can be used from a bounded partial window, with a visible
  partial marker included in the budget. Restart and LRU eviction preserve old
  unproved note content; no new persistence or amem schema is introduced.

## Checks

At `00cc1bdeb14b54eea2edaab23a5edc82976f5a7b`, the published 0.23.1 package
passed strict typecheck, inventory and 141 tests across twelve files in the
disposable Linux runner. The generated lock changes only the exact amem pin
and SRI; the value matches npm metadata above. Bun 1.4.2 rebuilt the bundles
after dependency installation. Committed-artifact freshness and the canonical
changed-scope gate are the next checks; this run is not a full-suite result.

At `1ac11d3a2ad6d2d889329f959880596e712e8c05`, the committed source passed strict
typechecking, inventory and 117 tests across ten files in a disposable Linux runner using
Bun 1.4.2 and agent-mem 0.23.0. Existing memory, recall, intent-library brief and
corpus concurrency assertions were retained. The initial optional-await dedupe
regression was corrected in the implementation.

The same run reached inventory checking and identified twelve new feature keys.
The reviewer's direct ruling clarifies that the blind-80 gate applies to batches
relabeling existing baseline keys, not new author-added feature literals. The
informational blind samples scored 64/80 and 67/80. New keys use the call-site
labels below; the baseline is unchanged.

| New key / call site | Label | Reason |
| --- | --- | --- |
| `projectRecordRecall` original length 64 KiB | safety floor | recalled peer text admission |
| `projectRecordRecall` original byte length 64 KiB | safety floor | recalled peer text admission |
| `projectRecordRecall` items 32 | operational | host result-list cap |
| `projectRecordRecall` preferRecordItems 32 | operational | host result-list cap |
| `kind` regex group 2 | contract | parsed structure position |
| `Tasks.note` about length below 64 | operational | same label as committed saveNative slice64 |
| Registry notes 1024 | safety floor | entries originate in another process's calls |
| Registry anchors 64 | safety floor | peer-supplied references |
| Registry anchor bytes 512 | safety floor | peer-supplied references |
| Registry query anchors 1024 | safety floor | derived peer-supplied references |
| Registry matches 32 | operational | host result-list cap |
| Registry matching limit below 1 | contract | parameter meaning |

The eight earlier author-added source keys use these same call-site rules:

| New key / call site | Label | Reason |
| --- | --- | --- |
| Brief `RECORD_BYTES` 2048 | safety floor | admission bound on model/native-authored stored excerpts before parsing |
| Brief `RECORD_ROWS` 32 | contract | published package candidate-window shape |
| Brief `legacyBytes` 2048 | operational | old rendered-block byte budget |
| Brief `indexLines.reduce` 0 | operational | internal byte-sum initialization (R5) |
| Brief `maximumLineBytes` 2048 | operational | host rendering budget |
| Brief `maxBytes ?? 2048` | operational | host rendering default |
| Capture session digest prefix 16 | contract | stored opaque identity width |
| Capture turn/status digest prefix 16 | contract | stored opaque identity width |

At `865a017ba5f4601323abfab8159289d434edd68f`, typecheck, inventory and 169 tests
across thirteen files passed, including the unchanged actual roster scenario.
Record read revisions now track relevant memory/profile/privacy/flag state rather
than unrelated configuration reloads. Current privacy screens, capture's stricter
turn-generation fence and off-roster attachment admission remain independent.
The frozen lock and generated bundles were stable on the second build.

At `9365c5650ffdecb81f1b4de36218857c67e8c133`, typecheck, inventory and 191 tests
across fourteen files passed, including the unchanged ACP no-override observer
case and roster preface case. The final-answer bridge now preserves the current
`onMessage` chain once, with a host-only scoped marker and stale-owner exclusion.
The frozen lock and generated bundle were stable on the additional build.

An earlier full-suite attempt also reported one unchanged `route-relay` cooldown
case. Exact-head and immutable main `cd2080ecf8e54145c34ec8259ec35fa4909c3b7d`
probes each passed the unchanged original case and a metadata-only instrumented
copy, with transport failures and the expected cooldown. The original test and
product routing code remained unchanged. A closed-port reuse path is a candidate,
not a confirmed cause; a passing focused retry is not full-suite evidence.
A completed canonical correction run is recorded below.

## Completed canonical evidence

The full run at `978880761507c5e3b2f85e513cf9a79a1055ee9e` completed with
13,289 pass, 102 skip and four failures across 1,025 files. Three failures were
source-sliced startup functions receiving a new implicit binding dependency;
registration was moved to the four verified real factory callers without changing
permission/admission/bus commit order. The fourth was the static native-branch
guard following a new generic local alias into unrelated file-wide aliases; a
Record-specific peer-id name removes that false connection. The original tests,
ratchet table, resolution depth and assertions remain unchanged.

At `35e1bdfa22bb99c278d6b6b5bde3c486b7bd3334`, strict typecheck, inventory and
92 targeted tests across six files passed, including the original startup/proxy
and native-branch tests. Then `scripts/check.sh --changed 978880761507c5e3b2f85e513cf9a79a1055ee9e`
passed with 3,435 pass, 30 skip and zero failures across 296 files, ending
`check: OK (changed)` (1,212 seconds including setup). Its typecheck, pinned bundle
freshness, tarball, facts and daemon-leak checks passed. This is a completed full
attempt plus a passing verification of its corrected delta, not a claim of a
new zero-failure full run. Final-head hosted full CI remains a merge gate.

## Synthetic byte measurements

| Projection | Before UTF-8 bytes | After UTF-8 bytes |
| --- | ---: | ---: |
| Shared final-answer body | 60 | 5 |
| Rendered digest | 155 | 100 |
| Proven-overlap brief lines | 261 | 178 |
| Rendered recall block | 523 | 387 |

These are actual callback/rendered values from the deterministic fixtures.
Recall includes the mixed-source header identifying capture Records as uncurated;
its change contributes to the byte difference. These are
not production averages or model-quality measurements. The recall fixture uses
the existing generated-title ceiling of 120 characters. The same fixture retains
the unrelated contract and coverage/trailing notices, calls context injection once,
and verifies conservative fallback after the registry is cleared.

## Remaining gates

- Final-head hosted CI and review.
- Native/provider-backed Record generation and real-home/coordinated-upgrade
  behavior remain unrun; fixture success does not claim those observations.
