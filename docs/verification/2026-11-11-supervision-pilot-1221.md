# Supervision pilot receipt (#1221 T3, AC5)

Date: 2026-11-11 (KST). Task 866, Refs #1221. **Wave 1, mode `shadow`.**

Sealed at wave start, before the queue held anything: the frozen case set, the stopping rule,
the E1 thresholds and the outcome classes below were written while `hub_supervision_list`
answered `mode shadow`, no proposal, `refused 0`. They do not change when the numbers arrive.
This is a pilot on this repository's own hub, not the agent-research fixture corpus.

Sealed at `16b8251657a2` (main), running hub 0.36.0, `supervision.mode` set to `shadow` by the
person with `ahub settings set supervision.mode shadow`. The value is machine-local, off by
default, and absent from `.agenthub/config.json`.

Added after reading 3, with the frame above unchanged. The release merge `95c1e533294`
(2026-11-11 20:00:53 KST) landed after reading 3, so readings 0 through 3 were taken on hub
0.36.0 and every later reading names the hub version that produced it (the installed `ahub`
reports 0.37.0). The measured sources are byte-identical between the seal commit and that merge:
`git diff --name-only 16b8251657a2..95c1e533294 -- 'src/hub/supervision*' src/hub/conductor.ts
src/hub/settled-roles.ts` prints nothing, so the frozen case set, the stopping rule and the
thresholds below still describe the code under measurement.

Added after reading 5, with the frame above unchanged. The 0.38.0 release merge `e886c15b0`
(2026-11-12) and its follow-ups to main `0af9fb5a1` landed after reading 4, so reading 5 is the
first on hub 0.38.0. One measured source moved: `src/hub/supervision.ts` changed at `649715ef8`
(#1401), and only in the `SupervisionFeed.needsReview` notice text, where the conductor is told
to hand the person a queue command rather than a bare verb. The evaluator and the proposals
queue are byte-identical between the seal commit and `0af9fb5a1`
(`git diff --stat 16b8251657a2..0af9fb5a1 -- src/hub/supervision-rules.ts
src/hub/supervision-proposals.ts src/hub/settled-roles.ts` prints nothing), so the frozen case
set, the stopping rule and the thresholds below still describe the code under measurement.

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

Reading rule, set by the conductor on 2026-11-11 after the wave opened and recorded before any
number below is filled:

- the pilot takes no count by reading hub state files directly, `sqlite3` on `hub.db` included
  and read-only included; `hub_supervision_list` scopes rows to the caller's roles on purpose,
  so a direct read would step around a fence the feature carries;
- my own tool reads are therefore a lower bound, and a pilot total comes from them plus a
  conductor-scope count the conductor sends by `hub_send`; the receipt cites that message as the
  source of the total;
- one read-only count was taken before this rule existed, to answer the conductor's own readiness
  check on 2026-11-11 (7 rows, all `declared_overlap_without_integration`). It is disclosed here,
  it is not the source of any number in this receipt, and it was not repeated after the rule.

No model call and no memory write is part of this pilot: the rules and the queue import only the
board, the deliverable measurement, the database schema and `node:crypto`; there is no inference
path. Cost is therefore daemon CPU per task change plus one row per stored proposal.

## Reading 0 (wave start)

| at | mode | stored proposals | refused | board head |
| --- | --- | --- | --- | --- |
| 2026-11-11, first read | `shadow` | 0 (role-scoped tool read) | 0 (current queue) | `16b8251657a2` |

Evaluated revisions at this reading: not stored, replay pending at fill time. Recorded as
unknown rather than 0.

## Conductor reads (source of the totals)

| read | at | total rows | by rule | by state | note |
| --- | --- | --- | --- | --- | --- |
| 1 | 2026-11-11, conductor-scope | 7 | `declared_overlap_without_integration` 7 | 5 pending, 2 expired | both expired rows are on #856, superseded by its revision 12:11 |

At this read the other two families had stored nothing, which is unknown coverage and not zero:
the ledger holds only what a rule produced.

## Numbers (filled from stored records as the wave runs)

Scope is part of a reading: a conductor-scope count covers the queue, while a role-scoped tool
read covers only the tasks I hold a role on and is a lower bound. A per-family cell counts the
rows a reading returned, so `0 on my tasks` is not a claim about the queue. Reading 5 added a
second reason a role-scoped read undercounts: the page bound (`MAX_PROPOSAL_READ`, 50) is applied
across all tasks before the role filter, so a row on my own task can be absent from an unfiltered
read and present in a `task`-narrowed one.

| reading | scope | at | distinct revisions read | `repeated_failure` | `deliverable_invalidated_check` | `declared_overlap_without_integration` | stored | refused | expired |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | role-scoped (task 866), wave start | 2026-11-11 | unknown (not stored) | 0 on my tasks | 0 on my tasks | 0 on my tasks | 0 | 0 (current queue) | 0 |
| 1 | role-scoped (task 866) | 2026-11-11 06:28 KST | unknown (not stored) | 0 on my tasks | 0 on my tasks | 3 | 3 | 0 (current queue) | 2 |
| 2 | role-scoped (task 866) | 2026-11-11 08:36 KST | unknown (not stored) | 0 on my tasks | 0 on my tasks | 3 | 3 | 0 (current queue) | 3 |
| 3 | role-scoped (task 866) | 2026-11-11 17:19 KST | unknown (not stored) | 0 on my tasks | 0 on my tasks | 3 | 3 | 0 (current queue) | 3 |
| 4 | role-scoped (task 866) | 2026-11-12 00:37 KST, hub 0.37.0 | unknown (not stored) | 0 on my tasks | 0 on my tasks | 3 | 3 | 0 since the daemon start at 20:51 (unknown before it) | 3 |
| 5 | role-scoped (task 866), hub 0.38.0; unfiltered read 2, `task: 866` read 3 (page, below) | 2026-11-12 15:55 KST | unknown (not stored) | 0 on my tasks | 0 on my tasks | 3 | 3 | 0 since the daemon start (unknown before it) | 3 |

Reading 1 answered `mode shadow` with the three rows in the ledger below: one pending, two
expired by the queue at their partner's approving verdict. By reading 2 the third had expired the
same way, 2 s after its partner's review time, and the queue had stored nothing new on this task.
Reading 3, nine hours later, returned the same three expired rows, the same revision (`8:3`) and
`refused 0`: the queue stored no new proposal on this task, and its last partner had merged by
then. Coverage (`evaluated`) is not part of a role-scoped read and stays unknown at every reading,
never zero.

Reading 4 is the first on 0.37.0 and the first after the daemon restart that followed the upgrade
(this project's state was written at 20:51 KST). It returned the same three expired rows at the
same revision (`8:3`) under `mode shadow`, so the ledger and its receipts survived both the
restart and the version change, and no new proposal was stored on this task in the seven hours
since reading 3. Its `refused 0` covers that window only: the counter resets at a daemon start,
so refusals before 20:51 stay unknown, as listed at the end.

Reading 5 is the first on 0.38.0 and the first after a second daemon restart (the upgrade). It
returned the same three expired rows, the same revision (`8:3`) and `refused 0`, again with no new
proposal on this task, so the rows and their receipts survived a second version change and a
second restart. It also measured a bound the earlier readings could not: the unfiltered read
answered two rows, and the `task: 866` read answered three. `ProposalStore.list` applies its read
page (`MAX_PROPOSAL_READ`, 50) in SQL, ordered pending first and then `created_at DESC` across
every task, before the caller's role filter runs, so a project whose queue exceeds one page can
return fewer rows than the caller's own tasks hold, and the oldest terminal row drops off first.
The `task` argument narrows the SQL, which is how the third row was recovered; `refused 0` is
unaffected, because that counter records rows a storage bound refused, not rows a page left out.
The two reads together are also the first evidence that the project's queue passed one page:
at least 48 rows outside my roles sit ahead of `sup-067f72d97dd1` in the read order, and none of
them is visible to a role-scoped caller.

## Proposal ledger

| proposal | rule | task | revision | trigger | action | outcome | evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `sup-067f72d97dd1` | `declared_overlap_without_integration` | 866 | `8:3` | `overlap:866:873` | `request_integration` | expired by the queue 1.3 s after #873's review time; unknown from stored records | #873 has one row of its own in `docs/dogfood.md` (`Console agent-hub versions (#1385)`) and this task inserts one row after the `Supervision rules and proposals (#1221 T1, T2)` row, so the overlap was file-level only; an approved side is a closed side, so the pair left supervision at the verdict, and #873's merge (`2d341c298`) landed with no row naming it |
| `sup-67b2b2319f69` | `declared_overlap_without_integration` | 866 | `8:3` | `overlap:866:874` | `request_integration` | expired by the queue 1.3 s after #874's review time; unknown from stored records | #874 adds one row to `docs/dogfood.md` several dozen rows above this task's anchor (read at `0c427dd0`); same closure rule, and #874's merge (`89e69a38a`) landed with no row naming it |
| `sup-adb3295ebc9b` | `declared_overlap_without_integration` | 866 | `8:3` | `overlap:866:881` | `request_integration` | expired by the queue 1.4 s after #881's review time; unknown from stored records | #881 rewrites the Orca O0 row at 124, deletes the O1-O3 rows at 126-128, and collapses the Herdr H0-H3 rows at 251-254 plus the Claude Code row at 255 into two (measured at `45ed8d5c`), while this task inserts one row after the supervision row; jcode asked on 2026-11-11 and confirmed the ranges, so the pair needed no integration record; #881 was still in review at reading 2 and merged as `60db687fd` (#1392) before reading 3, with no row naming that merge either |

A pending proposal stays pending until the wave closes: classifying one while later revisions are
already in view would let its outcome be chosen to fit them. No row on this task is pending at
reading 3. An expiry is the queue's own disposition and not a classification: it records that the
reading stopped holding, and it counts neither as a helpful or false intervention nor as a clean
non-trigger.

## Cost

| item | shadow wave |
| --- | --- |
| model calls | 0 (no inference path in the rules or the queue) |
| memory writes | 0 |
| daemon evaluations | pending (replayed from board revisions) |
| rows written | 7 at the first conductor read, 3 of them on this task, written by the daemon on a task change and not by this task |
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
- whether an expired row would have been helpful or false: the expiry records no classification,
  and no later record can name what an action that never ran would have found;
- an integration that lands with the merge itself. All three `declared_overlap_without_integration`
  rows on this task expired 1.3 to 1.4 s after their partner's recorded review time, so the pair
  leaves supervision at the approving verdict and no row can name the merge as its integration.
  All three of those partners then merged on main (`2d341c298`, `89e69a38a`, `60db687fd`) and no
  row named any of the three merges, though the third had merged before reading 3 returned its
  expired row. Measured four times on 2026-11-11; it is a limit of the reading window, not a
  defect of any task;
- every row the read page left out. Reading 5 measured the page bound for the first time: the
  unfiltered read returned two of my three rows because the other 48 slots of the 50-row page went
  to rows on tasks I cannot decide, and the `task`-narrowed read returned all three. The size of
  the queue past one page is therefore unknown from a role-scoped read, and a wave total that adds
  up role-scoped reads without narrowing by task is an undercount;
- every threshold that needs a live sample larger than this pilot can produce.
