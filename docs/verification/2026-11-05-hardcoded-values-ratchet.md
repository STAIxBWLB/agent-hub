# Hard-coded values inventory: why it drifted, and the ratchet that stops it (#1180, task #719)

Date: 2026-11-05. Refs #1180. The issue stays open: its AC1 (zero unknown keys) is not met by this change. This record exists so the follow-up that classifies the rest starts from measurements, not from a guess.

## Cause

Not a generator bug. `scripts/inventory-hardcoded-values.ts` and `scripts/inventory-hardcoded-values.classifications.json` were committed together by #764 on 2026-10-24, and nothing ever ran the generator again: no step of `scripts/check.sh`, no workflow and no test. The file was edited by hand twice (#1099 changed one value, #1167 removed 11 keys), and every other change to `src/` and `scripts/` added constants nobody classified.

Measured by running the generator at past commits:

| Commit | Date | Unknown keys |
| --- | --- | ---: |
| `7c1d2065` (#764, the commit that added the inventory) | 2026-10-24 | 22 |
| `b454e527` | 2026-10-25 | 63 |
| `438e9b23` | 2026-10-28 | 527 |
| `9680a4db` | 2026-11-02 | 1065 |
| `8511d01a` (#1099) | 2026-11-02 | 1087 |
| main at `4b34fab1` | 2026-11-05 | 1438 |

The 22 at #764's own head are the memory-code files that landed in the same week. The 1282 in the issue and the 1438 here are the same drift counted at two commits. At this commit 3243 inventory entries exist, 1805 were decided, 1438 were unknown and 36 committed keys matched nothing (the code they named had moved or changed).

## What this change does

1. Removes the 36 stale keys.
2. Classifies 216 unknown keys by precedent in the file itself, and nothing else. A key is adopted only when every already-decided key sharing its parts agrees, taking the tiers in this order and stopping at the first that decides:
   - same file, kind, name and value (82 keys): leave-one-out accuracy over the committed decisions 99.4%;
   - same file, kind and name (44 keys): 97.6%;
   - same kind, name and value, with at least two agreeing precedents (72 keys): 95.7%;
   - same kind and name, with at least two agreeing precedents (18 keys): 94.1%.
   The same two weaker tiers with a single precedent measured 92.6% and 89.2%, which is why they need two. The 216 are 109 contract, 81 operational, 23 safety floor and 3 test seam.
3. Puts the other 1222 unknown keys in `scripts/inventory-hardcoded-values.baseline.json`, the list of known-unclassified keys. They are not classified. `bun scripts/inventory-hardcoded-values.ts --check` fails on any unknown key that is not in that list, on a baseline key that has since been classified, and on a baseline key that matches no entry. The baseline only shrinks. `scripts/check.sh` runs the check with the other once-only steps.

## What this change does not do, and why

It classifies none of the 1222 remaining keys. The attempt was measured first. 190 of them were labelled by reading each literal's source line against the K01-K18 reasons of `2026-10-30-operational-settings-closure.md`, then 80 already-decided entries (seeded random draw, labels hidden) were labelled the same way and compared with the committed file: **47 of 80 agreed (58%)**. The disagreements were systematic, not noise:

| Committed class | I labelled | Count | Typical case |
| --- | --- | ---: | --- |
| operational | safety floor | 12 | a hub-internal cap constant (`MAX_STATES = 256`, `tasks.length > 500`, a 1024-entry map) |
| operational | contract | 7 | a saturating `Math.max(0, ...)`, a `limit < 1` check |
| operational | test seam | 6 | a smoke script's `deadline`, an injected `opts.x ?? N` default |
| contract | safety floor | 5 | a short id or text slice bound |
| safety floor | operational | 2 | a `termMs`/`killMs` in a review-isolation stop |

So the file's operative rule for `operational` is wider than the prose of the K groups: a hub-internal cap, an injected default and a script deadline all count as operational, and the prose does not say so. A rule pass built from the K-group text was 65% accurate on the 1805 decided entries and a text-feature classifier 71%, so neither decides anything. Writing 1222 labels at 58% would be the blind classification the issue forbids.

## How the remaining 1222 get classified

As a separate task, in batches a person can review, under these rules:

- Before the first batch, write the rule for each confusable case into the header of the classifications file or this record: hub-internal caps, injected `opts.x ?? N` defaults, script deadlines, short id and hash slices, saturating zero bounds.
- Each batch is labelled by those written rules, never by feel.
- Each batch needs a fresh blind sample of 80 already-decided entries labelled by the same rules, and an agreement of 85% or more with the committed file, before the batch is written.
- Classifying a key means adding it to the classifications file and removing it from the baseline in the same commit; `--check` refuses the half-done state.
- Do not regenerate `docs/verification/2026-10-24-hardcoded-values.md`: `test/operational-settings.test.ts` reads it by row.
