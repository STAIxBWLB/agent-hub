# Supervision pilot receipt (#1221 T3, AC5)

Date: 2026-11-11 (KST). Task 866, Refs #1221. **Wave 1, mode `shadow`.**

Sealed at wave start, before the queue held anything: the frozen case set, the stopping rule,
the E1 thresholds and the outcome classes below were written while `hub_supervision_list`
answered `mode shadow`, no proposal, `refused 0`. They do not change when the numbers arrive.
This is a pilot on this repository's own hub, not the agent-research fixture corpus.

Sealed at `16b8251657a2` (main), running hub 0.36.0, `supervision.mode` set to `shadow` by the
person with `ahub settings set supervision.mode shadow`. The value is machine-local, off by
default, and absent from `.agenthub/config.json`.

## Frozen case set

The rules under measurement are the merged T1 rules, at version 1 of each family. The set is
closed: a rule added later is a different pilot and needs its own seal.

| rule | fires when | action | reason |
| --- | --- | --- | --- |
| `repeated_failure` | one revision shows 2 equal classified failures (`REPEAT_FLOOR`); a check pass, an integration or an approval clears the streak; an owner episode starts at accept, reassign, escalate or reopen | `escalate` | `repeated_failure` |
| `deliverable_invalidated_check` | a file delivered before the recorded check pass changed since that pass, as the hub's own deliverable measurement reads it | `recheck` | `stale_check` |
| `declared_overlap_without_integration` | both owners of a declared overlapping pair accepted and no integration is recorded since, bound to the pair's lower task id | `request_integration` | `unintegrated_overlap` |

Reading bounds fixed by the code, and therefore part of the frame: 64 records read per revision
(`MAX_RECORDS`), 8 refs per observation (`MAX_REFS`), 100 stored proposals (`MAX_OBSERVATIONS`,
`MAX_PROPOSALS`), 3 per task revision (`MAX_PER_REVISION`), 400 retained rows
(`MAX_PROPOSAL_ROWS`), 50 rows per read (`MAX_PROPOSAL_READ`).

Gaps are not triggers and are never a zero: `no-history`, `no-deliverable-measurement`,
`history-truncated`. A truncated revision proposes nothing of its own and is reported as
missing coverage.

## Stopping rule

The conductor set the wave length: every rule family read twice over 10 or more task revisions,
with a 7-day cap. Preregistered reading of that sentence, fixed here so it cannot be bent when
the numbers land:

- coverage: each of the three families has at least 2 separate readings (separate observe
  passes), and the wave's readings together span at least 10 distinct `(task, revision)` pairs;
- cap: the wave closes on 2026-11-18 (KST) whatever the coverage, and a family short of it is
  reported as insufficient evidence rather than as a clean reading;
- the stricter variant (each family twice per revision) is also reported if the numbers hold it,
  and its absence is not a failure of the wave.

## E1 thresholds (preregistered, agent-research#63)

Quoted from agent-research issue #63, "Proposed product acceptance thresholds, not measured
claims":

> For supervision require improved accepted-outcome rate OR >=20% lower recovery time, with no
> increase in total cost/person decisions; otherwise retain shadow/off. Report sample
> uncertainty; these small trials justify only bounded adoption.

And from the same issue's measurement clause: correct accepted outcomes; total measured
compute, wall, storage, transfer and verification costs; idle and person time separately;
intervention burden; unknowns reported as unknown, never summed across incomparable clocks.

A small live sample cannot reach either threshold. This receipt therefore reports counts and
sample uncertainty, and the recommendation stays bounded: retain `shadow`, or return to `off`.

## Outcome classes

- helpful: a proposal whose named action was right, as a later review, check or the person
  confirmed.
- false: a proposal whose action was unnecessary or wrong.
- missed: a condition a later review or the person found that no rule named.
- unknown: not established from a stored record. Never counted as 0 and never as a non-trigger.
- unsupported: a case whose facts lie outside the T1 inputs (retry budgets, dispatch acks, 429
  waits, owner constraints, human waits). Per the agent-research#63 ruling of 2026-11-10, an
  unsupported case is never counted as missed and never as a correct non-trigger.

## Raw-count method

| source | durability | what it can answer |
| --- | --- | --- |
| `supervision_proposals` rows in `hub.db` | durable; one row per unique `(rule, task, revision, trigger)`; terminal states kept with their receipt | proposals stored, expired, accepted, dismissed, refused by an action fence |
| `evaluated` and `gap` lists of one evaluation | in memory only, never stored | coverage, recomputed by replaying `evaluateSupervision` over a read-only board snapshot; the rules are pure, clock-free and read only admitted board facts, so a replay of revision R equals the daemon's reading of R |
| `refusedReadings()` | per daemon lifetime; a restart resets it | the refusals of the current queue only, sampled at each read; spans across restarts are unknown |
| board history | durable | the denominator: task revisions in the window |

Two limits of the ledger are recorded rather than smoothed: `prune()` keeps 400 rows, so the
oldest rows can drop out of a long wave (an undercount, named as such), and a proposal whose
reading stops holding is expired by the next reading, which keeps the row but moves it out of
pending.

No model call and no memory write is part of this pilot: the rules and the queue import only the
board, the deliverable measurement, the database schema and `node:crypto`; there is no inference
path. Cost is therefore daemon CPU per task change plus one row per stored proposal.

## Reading 0 (wave start)

| at | mode | stored proposals | refused | board head |
| --- | --- | --- | --- | --- |
| 2026-11-11, first read | `shadow` | 0 | 0 (current queue) | `16b8251657a2` |

Evaluated revisions at this reading: not stored, replay pending at fill time. Recorded as
unknown rather than 0.

## Numbers (filled from stored records as the wave runs)

| reading | at | distinct revisions read | `repeated_failure` | `deliverable_invalidated_check` | `declared_overlap_without_integration` | stored | refused | expired |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 2026-11-11 | pending | pending | pending | pending | 0 | 0 | 0 |

## Proposal ledger

| proposal | rule | task | revision | trigger | action | outcome | evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| none yet | | | | | | | |

## Cost

| item | shadow wave |
| --- | --- |
| model calls | 0 (no inference path in the rules or the queue) |
| memory writes | 0 |
| daemon evaluations | pending (replayed from board revisions) |
| rows written | 0 |
| wall time | wave open 2026-11-11, cap 2026-11-18 |

## Person burden

Shadow mode shows nothing by construction: no inbox row, no notice, no message. Person burden
in this wave is therefore 0 proposals shown, 0 accepted, 0 dismissed, and it stays 0 for as long
as the mode stays `shadow`. The advisory burden is measured after the person switches the mode,
and is not part of this wave.

## What stayed unknown

- coverage per rule family, until the replay at wave end;
- refusals that happened before a daemon restart, which the counter does not carry;
- rows dropped by the 400-row prune, if the wave ever reaches it;
- every threshold that needs a live sample larger than this pilot can produce.
