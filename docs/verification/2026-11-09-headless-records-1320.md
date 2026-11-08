# Headless Record integration (#1320)

This is a source and disposable-fixture receipt. Production activation is held
until agent-mem 0.23.1 is published, exact-pinned and its effective Record policy
export is wired. The host seam currently defaults off. No real memory home,
native account, model, provider or person profile was used.

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

At `cd6d87de595f1ba8247ddab577e85457151242d7`, the committed source passed strict
typechecking and 109 tests across ten files in a disposable Linux runner using
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

## Synthetic byte measurements

| Projection | Before UTF-8 bytes | After UTF-8 bytes |
| --- | ---: | ---: |
| Shared final-answer body | 60 | 5 |
| Rendered digest | 155 | 100 |
| Proven-overlap brief lines | 261 | 178 |
| Rendered recall block | 523 | 440 |

These are actual callback/rendered values from the deterministic fixtures,
not production averages or model-quality measurements. The recall fixture uses
the existing generated-title ceiling of 120 characters. The same fixture retains
the unrelated contract and coverage/trailing notices, calls context injection once,
and verifies conservative fallback after the registry is cleared.

## Remaining gates

- Published 0.23.1 pin and real effective-policy export, including machine/repo
  `records: false` inheritance; no copied parser or private import is used.
- Final inventory check of the new keys under the call-site ruling.
- Final pinned bundle freshness and canonical changed-scope check.
- Final-head hosted CI and review.
- Native/provider-backed Record generation and real-home/coordinated-upgrade
  behavior remain unrun; fixture success does not claim those observations.
