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

Added after reading 6, with the frame above unchanged. Main advanced twice more while the wave ran:
`01ae0922c` (#1415, task #906) and `14831c93d` (#1416, task #891), each inserting one row into
`docs/dogfood.md` above this task's anchor, so the `Supervision rules and proposals (#1221 T1, T2)`
row now reads 130 on main instead of 128 and the pilot's own row is re-found by that text at the
wave close. Neither PR touched `docs/design/supervision.md` or this receipt, and no measured source
moved between `0af9fb5a1` and `14831c93d`
(`git diff --stat 0af9fb5a1..14831c93d -- src/hub/supervision-rules.ts
src/hub/supervision-proposals.ts src/hub/settled-roles.ts` prints nothing), so readings 5 and 6
measure the same evaluator and queue.

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
| 6 | role-scoped (task 866), hub 0.38.0 | 2026-11-13 01:30 KST | unknown (not stored) | 0 on my tasks | 0 on my tasks | 3 | 3 | 2 since the daemon start (unknown which bound, task or rule; unknown before it) | 3 |
| 7 | role-scoped (task 866), hub 0.38.0, pid 92515; its start (2026-11-12 11:09:48 KST) puts readings 5, 6 and 7 in one daemon lifetime | 2026-11-13 04:05 KST | unknown (not stored) | 0 on my tasks | 0 on my tasks | 3 | 3 | 4 since that daemon start, 2 of them after reading 6 (unknown which bound, task or rule) | 3 |
| 8 | role-scoped (task 866), hub 0.38.0, pid 92515 (start 2026-11-12 11:09:48 KST), same lifetime as readings 5, 6 and 7 | 2026-11-13 06:14 KST | unknown (not stored) | 0 on my tasks | 0 on my tasks | 3 | 3 | 5 since that daemon start, 1 of them after reading 7 (unknown which bound, task or rule) | 3 |
| 9 | role-scoped (task 866), hub 0.38.0, pid 92515, same lifetime as readings 5 to 8 | 2026-11-13 08:15 KST | unknown (not stored) | 0 on my tasks | 0 on my tasks | 3 | 3 | 6 since that daemon start, 1 of them after reading 8 (unknown which bound, task or rule) | 3 |
| 10 | role-scoped (task 866), hub 0.38.0, pid 45122 (start 2026-11-13 11:59:44 KST); a new daemon lifetime, so the refusal counter restarts | 2026-11-13 13:25 KST | unknown (not stored) | 0 on my tasks | 0 on my tasks | 5 | 5 | 0 since this daemon start (unknown before it; the previous lifetime ended at 6) | 5 |
| 11 | role-scoped (task 866), hub 0.38.0, pid 45122, same lifetime as reading 10 (`etime` 6 h 46 m) | 2026-11-13 18:45 KST | unknown (not stored) | 0 on my tasks | 0 on my tasks | 8 | 8 | 3 since this daemon start, all three after reading 10 (unknown which bound, task or rule) | 7 |
| 12 | role-scoped (task 866), hub 0.38.0, pid 45122, same lifetime as readings 10 and 11 (`etime` 8 h 50 m) | 2026-11-13 20:50 KST | unknown (not stored) | 0 on my tasks | 0 on my tasks | 9 | 9 | 3 since this daemon start, unchanged since reading 11, so none in the 2 h 05 m between them (unknown which bound, task or rule) | 9 |
| 13 | role-scoped (task 866), hub 0.38.0, pid 45122, same lifetime as readings 10 to 12 (`etime` 15 h 03 m) | 2026-11-14 03:02 KST | unknown (not stored) | 0 on my tasks | 0 on my tasks | 15 | 15 | 16 since this daemon start, 13 of them after reading 12 (unknown which bound, task or rule) | 13 |
| 14 | role-scoped (task 866), hub 0.38.0, pid 45122, same lifetime as readings 10 to 13 (`etime` 15 h 55 m) | 2026-11-14 03:55 KST | unknown (not stored) | 0 on my tasks | 0 on my tasks | 15 | 15 | 28 since this daemon start, 12 of them in the 53 m after reading 13 (unknown which bound, task or rule) | 14 |

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

Reading 6 is the first with a nonzero refusal. Nine hours after reading 5 on the same build, the
`task: 866` read returned the same three expired rows at revision `8:3`, and `refused` had moved
from 0 to 2. That counter is queue-wide and per daemon lifetime: `observe()` increments it at store
time when either storage bound refuses one observation, the 100-pending queue or the
3-per-task-revision budget, after the duplicate-key check and with no role filter anywhere in the
path. Which bound refused the two, on which task and by which rule, is unknown from a role-scoped
read and is listed at the end.

The per-revision bound makes one possibility concrete rather than theoretical: revision `8:3`
already holds exactly three rows, which is the whole per-revision budget, so a fourth distinct
observation on this task would be refused at store time and would appear in neither the read nor
the ledger. The two refusals may therefore include my own task, and if they do, then a rule that
fired on `866` at `8:3` produced nothing this reading can see. That is a measured gap in coverage,
never evidence that no condition held. A restart between readings 5 and 6 also cannot be excluded,
because a role-scoped read carries no daemon start time, so the delta reads as "2 refusals in the
current daemon lifetime", not "2 in the last nine hours".

Reading 7 bounds that window instead of leaving it unknown, and the bound is what the counter was
missing. At 2026-11-13 04:05 KST, on the same build (`ahub status` reports agent-hub 0.38.0,
pid 92515, mode `shadow`), the `task: 866` read returned the same three expired rows at revision
`8:3` and `refused` had moved from 2 to 4. `ps -o lstart= -p 92515` puts that process's start at
2026-11-12 11:09:48 KST, cross-checked against its own `etime` of 16 h 55 m 48 s at 04:05:36 KST,
so readings 5 (15:55), 6 (01:30) and 7 (04:05) all ran under one daemon. The series 0, 2, 4 is
therefore a single lifetime, and the two refusals after reading 6 accumulated in 2 h 35 min. That
closes the question reading 6 had to leave open, since it carried no start time and could not
exclude a restart, and it changes what the number means: a refusal is not a startup artefact. The
storage bounds refused four observations in about seventeen hours while the role-scoped read kept
returning an unchanged three-row ledger at one revision, so the refusals sit in a part of the
queue this caller cannot see and, as reading 6 noted, may include this task. Which bound refused
them, on which task and by which rule, is still unknown from a role-scoped read and stays in the
list below. Provenance at this reading: board head `08d4b893b`, the single merge #1420 (#1402 T4),
which changes no file either anchor depends on, so `docs/dogfood.md` still carries the
`Supervision rules and proposals (#1221 T1, T2)` row at 130; and the evaluator and the queue are
byte-identical from the seal `16b8251657a2` to `08d4b893b` (`supervision-rules.ts`,
`supervision-proposals.ts` and `settled-roles.ts` print nothing under `git diff --stat`), so the
frozen case set still describes the code that measured it. Reading 8 corrects this sentence, which
had also named `supervision.ts` among the unchanged files: that file moved by 3 insertions and 2
deletions at `649715ef8` (#1401), the notice-text change recorded after reading 5, so the narrower
claim above is the true one.

Reading 8 is the fifth read of a single daemon lifetime: nothing in the ledger moved, and the
refusal counter did. At 2026-11-13 06:14 KST, on the same build (`ahub status` reports agent-hub
0.38.0, pid 92515, mode `shadow`), the `task: 866` read returned the same three expired rows at
revision `8:3`, and `refused` had moved from 4 to 5. The daemon's own record is unchanged:
`ps -o lstart= -p 92515` still reports a start of 2026-11-12 11:09:48 KST, cross-checked against
the same process's `etime` of 19 h 03 m 57 s at 06:13:45 KST, so readings 5, 6, 7 and 8 all ran
under one process. The single refusal therefore arrived in the 2 h 09 min since reading 7, and the
series over that lifetime now reads 0, 2, 4, 5: the queue refused five observations in 19 hours
while every role-scoped read in that time returned the same three rows at one revision. A steady
trickle rather than one burst is what a queue sitting at its storage bounds looks like from outside,
and it stays unattributable from here, so that stays in the list below.

Provenance at this reading: board head `c6347fe19`, two merges since reading 7, #1421 (#1402 T5)
and #1417 (#1411 T2). Both insert into `docs/dogfood.md` below this task's anchor, one the `ahub
roles` and doctor shared-config row at 188 and one the observed-model row at 207, so the
`Supervision rules and proposals (#1221 T1, T2)` row still reads 130 when found by that text.
`docs/design/supervision.md` moved in neither merge (`git diff --stat` prints nothing) and still
ends at `## Deliberately outside this contract` (119), so the subsection this task appends last is
still new. The evaluator and the queue are byte-identical from `0af9fb5a1`, where reading 5 pinned
them, to `c6347fe19` (`supervision-rules.ts`, `supervision-proposals.ts` and `settled-roles.ts` all
print nothing under `git diff --stat`), so the frozen case set still describes the code under
measurement.

Reading 9 extends the same series and separately confirms a shift this receipt predicted before it
happened. At 2026-11-13 08:15 KST, on the same build and the same process (agent-hub 0.38.0, pid
92515, `etime` 21 h 05 m 39 s against the unchanged start 2026-11-12 11:09:48 KST), the `task: 866`
read returned the same three expired rows at revision `8:3` and `refused` moved from 5 to 6: one
more refusal in the 2 h 01 min since reading 8, and six in 21 hours of one daemon lifetime. The
series over that lifetime now reads 0, 2, 4, 5, 6, so readings 8 and 9 each added exactly one after
reading 7 added two. That is a rate a role-scoped read can state and cannot explain; the attribution
stays in the list below.

Provenance at this reading: board head `f89a0f646`, where #1429 merged (`[security] paths require a
recorded security pass`, hub task 895, #1403 T2). It inserts its `Security pass for sensitive paths
(#1403 T2)` row at 104 as `@@ -103,0 +104 @@`, which moves the `Supervision rules and proposals
(#1221 T1, T2)` row from 130 to 131. That is the shift this receipt predicted twice before the fact:
from #895's plan-level notice while it had no PR, and again from PR #1429's rebased head, both times
as 131 for the anchor and 132 for the row this task inserts after it. The row is now found at 131 by
its text, so the wave close still does not depend on the number. Neither anchor file was in the
merge (`git diff --stat` from `4fd1cc561` to `f89a0f646` on this receipt and on
`docs/design/supervision.md` prints nothing), and the design doc still ends at `## Deliberately
outside this contract` (119) with no `Observed limits` heading. The evaluator and the queue are
byte-identical from `0af9fb5a1`, where reading 5 pinned them, to `f89a0f646`
(`supervision-rules.ts`, `supervision-proposals.ts` and `settled-roles.ts` all print nothing under
`git diff --stat`), so the frozen case set still describes the code under measurement.

Reading 10 is the first read of a new daemon lifetime, and it is the first that shows rows written
after the queue had already entered its steady refusal. At 2026-11-13 13:25 KST (agent-hub 0.38.0,
pid 45122, `ps -o lstart= -p 45122` reporting 2026-11-13 11:59:44 KST and `etime` 1 h 25 m), the
`task: 866` read returned five expired rows at two revisions: the same three at `8:3` that readings
1 to 9 saw, and two at `11:4` that no earlier reading could see. `overlap:866:915` was written at
12:11 KST and expired at 12:17; `overlap:866:919` was written at 12:15 and expired at 12:46.
Neither is a new rule firing: the pair of them is the first time this wave stored a row for a peer
whose task was still open, and both expired on the queue's own schedule before either PR merged.

`refused` reads 0, and that is the reading's own correction of the series rather than a drop: the
counter belongs to a daemon lifetime, and reading 9's process is gone. The lifetime that started
2026-11-12 11:09:48 KST and carried readings 5 to 9 ended at six refusals; the lifetime that began
11:59:44 KST has refused none of its own reads. So the pilot total has to name the lifetime, never
the wave, and a restart after a counting series is indistinguishable from a quiet queue if the pid
is not read first. The previous lifetime's final state is recorded here as 6 and is not carried
forward: nothing in the new process inherits it, and the wave-wide figure is unknown.

Provenance at this reading: board head `722c1e17f` (`feat(sdlc): ahub sdlc audit start|show with a
hub-written coverage ledger`), one merge since reading 9's `f89a0f646`. It inserts one row into
`docs/dogfood.md` at `@@ -102,6 +102,7 @@`, which moves the `Supervision rules and proposals
(#1221 T1, T2)` row from 131 to 132; this task's row is still inserted after it, and the row is
still located by its text. Neither file this task touches appears in that merge, and
`docs/design/supervision.md` still ends at `## Deliberately outside this contract` (119) with no
`Observed limits` heading. The evaluator and the queue are byte-identical from `0af9fb5a1`, where
reading 5 pinned them, to `722c1e17f` (`supervision-rules.ts`, `supervision-proposals.ts` and
`settled-roles.ts` all print nothing under `git diff --stat`), so the frozen case set still
describes the code under measurement.

Both new triggers were file-level only, measured at the heads that carried them: #915 (PR #1442,
`5de20de20`) inserts `GSD migration guidance (#1431)` at `@@ -67,2 +67,3 @@` and adds one new
`test/init-gsd-migration.test.ts`, and #919 (PR #1444, `9648a1b94`) inserts `Planner pull routing
diagnostics (#1430)` at the same two neighbours. The two inserts therefore collide with each other
and not with this task, whose row goes after the supervision row at 132 and whose only new file is
this receipt; that collision was reported to their shared owner rather than treated as an overlap
of this task.

Reading 11 (2026-11-13 18:45 KST) is the first read that both grows the ledger and reports refusals
from the same daemon process. `ps -o lstart= -p 45122` still answers 2026-11-13 11:59:44 KST with
`etime` 6 h 46 m, so this is reading 10's lifetime. The `task: 866` read returned eight rows at
three revisions: the same three at `8:3`, the same two at `11:4`, and three new ones at `14:5`, all
`declared_overlap_without_integration`. `overlap:866:918` was written at 15:17:49 and expired at
16:34:20 (76 m 31 s); `overlap:866:894` was written at 17:25:46 and expired at 18:16:16 (50 m 30 s);
`overlap:866:917` was written at 18:40:41 and was still pending five minutes later, the first row
this wave has seen pending since reading 1.

`refused` reads 3 against reading 10's 0 in the same process, so the three are additions inside one
lifetime and not a reset artefact: the counter rose between readings 10 and 11, inside a window the
receipt can date to the minute at both ends, and that is the first refusal evidence the pilot can
pin rather than bracket. What it still does not carry is attribution — no task, rule, revision or
bound — and the conductor's queue read is the only source that could name one. A window with three
refusals and three new stored rows in 5 h 20 m says the queue is both writing and shedding at its
own bounds; it does not say which bound refused.

Neither of the two expiries is a verdict this receipt can see. #918's proposal expired at 16:34:20
and its PR #1451 merged later, as `376283a25` at 18:37:04 KST, so the row left supervision before
the merge and cannot name it. #894's PR #1453 is still open with no review decision recorded, and
its row expired at 18:16:16, 16 s after a bot `COMMENTED` review that is a quota notice and not an
approval; nothing in the stored record names a verdict for that expiry either. #917 has no open
pull request at this reading (open: #1453, #1452, #1450 and #1390), so its pending row is
plan-level, and a pending row is classified at the wave close and not now.

Provenance at this reading: board head `376283a25` (`feat(budget): observe paused Codex resets and
safe credit diagnostics (#1440)`), seven commits since reading 10's `722c1e17f`. The supervision row
moved three times in that window, always by an insert above it — 132 at `722c1e17f`, 133 at
`228b6085c`, 134 at `c0be55924`, 135 at `adf4f99c0` — and reads 135 at this head, so the row is
still located by its text and still has this task's row inserted after it. Neither file this task
touches appears in those seven commits, `docs/design/supervision.md` still ends at
`## Deliberately outside this contract` (119) with no `Observed limits` heading, and the evaluator
and the queue are byte-identical from `0af9fb5a1`, where reading 5 pinned them, to `376283a25`
(`supervision-rules.ts`, `supervision-proposals.ts` and `settled-roles.ts` all print nothing under
`git diff --stat`), so the frozen case set still describes the code under measurement.

Reading 12 (2026-11-13 20:50 KST) is the first read where a row that was pending at the previous
reading has left the ledger, and the first where a pair closed at the partner's filing rather than
at a verdict. `ps -o lstart= -p 45122` still answers 2026-11-13 11:59:44 KST with `etime` 8 h 50 m,
so this is the lifetime of readings 10 and 11. The `task: 866` read returned nine rows at four
revisions: the same three at `8:3`, the same two at `11:4`, the same three at `14:5`, and one at
`15:6` that no earlier reading could see.

`sup-e8c72e6a6600`, pending at reading 11, expired at 18:49:46 KST, 9 m 05 s after it was written,
and the row at `15:6` was written at that same second. The revision therefore moved `14:5` to
`15:6` between the two, and the only change on this task this receipt can name in that window is
its own plan refresh, recorded by the hub at 18:45:02 KST (`hub_task_accept` with an updated plan).
The measured part is the coincidence of the two timestamps: a row at a new revision opened at the
second the old one closed, which is what a revision-keyed pair (`rule`, `task`, `revision`,
`trigger` per the design) looks like from outside. Whether the queue closed the old row because of
that, or on its own schedule, is not in the stored record, and neither is whether the plan refresh
is what advanced the revision.

`sup-9b89abfbd309` is that new row, and it expired at 20:23:59 KST, 1 h 34 m 13 s after its write.
#917's PR #1456 was created at 20:23:05 KST (`createdAt` 2026-11-13T11:23:05Z), 54 s before the
expiry, and re-filed at 20:28:01 KST, after the row had already closed, so this pair also left
supervision before any merge and before any approval of it. Which of the rule's exits closed it is
not visible from a role-scoped read: `unintegratedOverlap` (`src/hub/supervision-rules.ts`) produces
the row only while both sides' latest episode is an `accepted` one, neither side is closed
(`approved` or `cancelled`, `isClosedTaskState` in `src/hub/board.ts`), no integration evidence
(`integration requested`, `integrated`, `integration unresolved`) was recorded after either
acceptance, and neither side's window is clipped. An expiry therefore means one of those four
stopped holding, and the stored row names none of them. What the wave can say is that its closes
now fall at three different boundaries: readings 1 to 3 saw them 1.3 to 1.4 s after a review time,
reading 11 saw one 16 s after a bot `COMMENTED` review on a PR whose decision was never recorded,
and reading 12 sees one 54 s after the partner's PR appeared.

`refused` still reads 3, unchanged over the 2 h 05 m since reading 11, during which the queue wrote
one row and closed two. Refusals therefore do not track rows written: this is the first window in
the wave with queue activity and no refusal, and the lifetime total stays 3 across 8 h 50 m, so the
attribution limit in the list below is unchanged rather than lifted.

Provenance at this reading: board head `c78468289` (`fix(review): recurring-finding cards ignore
review-local positional finding ids`, #1452), one merge since reading 11's `376283a25`. It touches
neither `docs/dogfood.md` nor `docs/design/supervision.md`, so the `Supervision rules and proposals
(#1221 T1, T2)` row still reads 135 when found by that text and this task's row is still inserted
after it, and the design doc still ends at `## Deliberately outside this contract` (119) with no
`Observed limits` heading. The evaluator and the queue are byte-identical from `0af9fb5a1`, where
reading 5 pinned them, to `c78468289` (`supervision-rules.ts`, `supervision-proposals.ts` and
`settled-roles.ts` all print nothing under `git diff --stat`), so the frozen case set still
describes the code under measurement.

Reading 13 (2026-11-14 03:02 KST) is the first read that ends with rows still pending, and the
first whose close a task event the hub recorded explains rather than a nearby timestamp.
`ps -o lstart= -p 45122` still answers 2026-11-13 11:59:44 KST with `etime` 15 h 03 m, so this is
the lifetime of readings 10 to 12. The `task: 866` read returned fifteen rows at six revisions: the
same three at `8:3`, the same two at `11:4`, the same three at `14:5`, the same one at `15:6`,
three at `19:8` and three at `22:9`. Thirteen are expired and two are pending.

The `19:8` rows closed at 01:50:04 KST, and this task's own history names what happened in that
second: the hub's idle sweep reassigned it away from its owner (`idle sweep: idle-owner; from
qwen`), and the rule stopped holding because my side's latest episode was no longer an accepted
one. pi declined in the same minute (the conductor told it the time-gated pilot and the row's
reservation are qwen's, and it made no edits), the hub reassigned the task back, and my accept was
recorded at 01:50:19.669 KST. Three rows were written at `22:9` at 01:50:20.009, 338 ms later. So
the pair left supervision at a reassignment and not at a verdict, returned at the re-accept, and
the revision advanced across both: this is the first close in the wave that a stored board event
explains, and it prices an idle-owner sweep at three closed rows on a task nobody edited.

The same read measures the write latency the Cost table could only call "on a task change". Each
`19:8` row was written within a fifth of a second of the accept that completed its pair:
`sup-0aeb441a4c3f` 149 ms after #897's accept (23:55:49.464 to 23:55:49.613 KST),
`sup-2167e4441732` 175 ms after #921's (01:07:29.692 to 01:07:29.867) and `sup-e16589b19f9d`
177 ms after #916's (01:12:29.432 to 01:12:29.609). Three partners, three sub-200 ms gaps, so
`observe()` runs on the accept path and not on a periodic scan.

`sup-913163059a34` (revision `22:9`, `overlap:866:921`) expired at 03:01:15.994 KST, 0.56 s after
#921's review request was recorded (`actualDates.reviewAt` 03:01:15.436; the task now reads
`in_review`). That is the first close this wave can tell apart from a verdict: readings 1 to 3 also
saw closes 1.3 to 1.4 s after a review time, but their partners were approved and merged, so a
review request and a verdict could not be separated there. #921 has no approval recorded, so the
condition that stopped holding was the accepted episode itself, which `hub_task_done` ends and the
row follows half a second later. The two pairs whose partners are still open survive: #897 and #916
are both `in_progress` with no pull request, so their `22:9` rows are pending and stay pending
until the wave closes.

`refused` reads 16 against reading 12's 3, thirteen more in 6 h 12 m, while this task wrote six rows
in the same window. That is the widest refusal window the wave has measured and the first that runs
while rows hold: the two pending rows keep their slots through it, and revision `22:9` already
carries this task's whole 3-row budget, so a fourth distinct observation on it would be refused at
store time. Which bound refused the thirteen stays unknown for the reason the earlier readings
record, but a queue that keeps rows instead of shedding them is the condition a full 100-pending
bound produces, and this is the first window that both wrote and held.

Provenance at this reading: board head `9f65b79b1` (`feat(sdlc): settle a verified audit finding as
fixed or false_positive, and drop the unused Board.auditVerify`, hub task 920, #1403), nine commits
since reading 12's `c78468289`. Four of them rewrite a `docs/dogfood.md` row in place and none
inserts one: `@@ -121 +121 @@` (`Plan conformance (#481 S2, #1403 T6)`, #894), `@@ -215 +215 @@`
(`Claim evidence links and synthesis readiness (#931 T1-T3)`, #699), `@@ -247 +247 @@` (`Upgrade and
recovery (#1426)`, #917) and `@@ -249 +249 @@` (`acon console plugin (#935)`, this repository's
#923 merge). The `Supervision rules and proposals (#1221 T1, T2)` row therefore still reads 135 when
found by that text, and the two in-place rewrites above it are the case the wave predicted: a
rewrite moves nothing, an insert does. `docs/design/supervision.md` was touched by none of the nine
and still ends at `## Deliberately outside this contract` (119) with no `Observed limits` heading.
The evaluator and the queue are byte-identical from `0af9fb5a1`, where reading 5 pinned them, to
`9f65b79b1` (`supervision-rules.ts`, `supervision-proposals.ts` and `settled-roles.ts` all print
nothing under `git diff --stat`), so the frozen case set still describes the code under measurement.

Reading 14 (2026-11-14 03:55 KST) is the second consecutive read with a pending row, and it wrote
no row of its own. `ps -o lstart= -p 45122` still answers 2026-11-13 11:59:44 KST with `etime`
15 h 55 m, so this is the lifetime of readings 10 to 13. The `task: 866` read returned the same
fifteen rows at the same six revisions: fourteen expired, one pending.

`sup-4e799e1e9952` (revision `22:9`, `overlap:866:916`) expired at 03:06:27.826 KST, 0.63 s after
#916's review request was recorded (`actualDates.reviewAt` 03:06:27.197; the task reads `in_review`
on PR #1463 with no approval). That is the same close reading 13 measured on #921, 0.56 s, and the
second partner to produce it, so the half-second follow behind `hub_task_done` is the rule's normal
close and not a coincidence of one pair. The one row left pending is `sup-d55cbd37434e`, #897,
which still has no pull request.

#921's PR #1462 merged as `1410628a0` before this read, after its row had closed at the review
request, so that pair's merge went unnamed like the others: a pair that leaves supervision at the
review request cannot report the merge that follows it either, and this is the same limit the
readings of 2026-11-11 recorded at approving verdicts, now measured on the other side of the same
boundary.

`refused` reads 28 against reading 13's 16, twelve more in 53 minutes — about 13.6 an hour against
the 2.1 an hour between readings 12 and 13, and the fastest rate the wave has measured. The ledger
did not grow while the counter did, and revision `22:9` still carries this task's whole 3-row
budget, so on this task a new distinct observation would be refused rather than stored; which bound
refused the twelve, and on which task, stays unknown for the reason the earlier readings give. The
two numbers moving apart is what the pilot can state: a queue refusing at a high rate and a
role-scoped ledger that held still are both true of the same 53 minutes.

Provenance at this reading: board head `1410628a0` (`chore(compat): verify Claude implementer
2.1.323 (#888)`, #1462), the only merge since reading 13's `9f65b79b1`. It touches neither
`docs/dogfood.md` nor `docs/design/supervision.md` (`git diff --stat` over both prints nothing), so
the `Supervision rules and proposals (#1221 T1, T2)` row still reads 135 when found by that text and
the design doc still ends at `## Deliberately outside this contract` (119) with no `Observed limits`
heading. The evaluator and the queue are byte-identical from `0af9fb5a1`, where reading 5 pinned
them, to `1410628a0` (`supervision-rules.ts`, `supervision-proposals.ts` and `settled-roles.ts` all
print nothing under `git diff --stat`), so the frozen case set still describes the code under
measurement.

## Proposal ledger

| proposal | rule | task | revision | trigger | action | outcome | evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `sup-067f72d97dd1` | `declared_overlap_without_integration` | 866 | `8:3` | `overlap:866:873` | `request_integration` | expired by the queue 1.3 s after #873's review time; unknown from stored records | #873 has one row of its own in `docs/dogfood.md` (`Console agent-hub versions (#1385)`) and this task inserts one row after the `Supervision rules and proposals (#1221 T1, T2)` row, so the overlap was file-level only; an approved side is a closed side, so the pair left supervision at the verdict, and #873's merge (`2d341c298`) landed with no row naming it |
| `sup-67b2b2319f69` | `declared_overlap_without_integration` | 866 | `8:3` | `overlap:866:874` | `request_integration` | expired by the queue 1.3 s after #874's review time; unknown from stored records | #874 adds one row to `docs/dogfood.md` several dozen rows above this task's anchor (read at `0c427dd0`); same closure rule, and #874's merge (`89e69a38a`) landed with no row naming it |
| `sup-adb3295ebc9b` | `declared_overlap_without_integration` | 866 | `8:3` | `overlap:866:881` | `request_integration` | expired by the queue 1.4 s after #881's review time; unknown from stored records | #881 rewrites the Orca O0 row at 124, deletes the O1-O3 rows at 126-128, and collapses the Herdr H0-H3 rows at 251-254 plus the Claude Code row at 255 into two (measured at `45ed8d5c`), while this task inserts one row after the supervision row; jcode asked on 2026-11-11 and confirmed the ranges, so the pair needed no integration record; #881 was still in review at reading 2 and merged as `60db687fd` (#1392) before reading 3, with no row naming that merge either |
| `sup-aea2246b2b5d` | `declared_overlap_without_integration` | 866 | `11:4` | `overlap:866:915` | `request_integration` | expired by the queue 5 m 56 s after it was written (12:11 to 12:17 KST on 2026-11-13); unknown from stored records | #915 (PR #1442, `5de20de20`) inserts one row of its own, `GSD migration guidance (#1431)`, at `@@ -67,2 +67,3 @@`, plus one new `test/init-gsd-migration.test.ts`; this task inserts one row after the supervision row at 132 and adds no test, so the overlap was file-level only |
| `sup-bd8af58defb8` | `declared_overlap_without_integration` | 866 | `11:4` | `overlap:866:919` | `request_integration` | expired by the queue 30 m 50 s after it was written (12:15 to 12:46 KST on 2026-11-13); unknown from stored records | #919 (PR #1444, `9648a1b94`) inserts `Planner pull routing diagnostics (#1430)` at the same two neighbours as #915's row and one new `test/planner-pull-routing-refusal.test.ts`; neither file is one this task writes, and the two inserts collide with each other rather than with this task's row |
| `sup-2b47ddbc1bad` | `declared_overlap_without_integration` | 866 | `14:5` | `overlap:866:918` | `request_integration` | expired by the queue 76 m 31 s after it was written (15:17:49 to 16:34:20 KST on 2026-11-13), 2 h 02 m before #918 merged; unknown from stored records | #918 (PR #1451, `793ac556b`, merged as `376283a25` at 18:37:04 KST) rewrites the existing `Quota budgets and pauses` row in place at `@@ -160 +160 @@` and changes `src/hub/budget.ts`, `src/hub/quota-account.ts`, `src/adapters/codex-appserver.ts`, `src/adapters/definitions/native-quota.ts` and `test/codex-budget-*.test.ts`; this task inserts one row after the supervision row and adds no source file, so the overlap was file-level only |
| `sup-acc96e5922b7` | `declared_overlap_without_integration` | 866 | `14:5` | `overlap:866:894` | `request_integration` | expired by the queue 50 m 30 s after it was written (17:25:46 to 18:16:16 KST on 2026-11-13), 16 s after a bot `COMMENTED` review on #1453 that is a quota notice and not an approval; the PR is still open with no review decision recorded | #894 (PR #1453, `7ebb77858`, base `adf4f99c0`) rewrites the existing `Plan conformance (#481 S2, #1403 T6)` row in place at `@@ -121 +121 @@` and changes `src/hub/plan-conformance.ts`, `src/hub/tasks.ts`, `src/hub/board.ts`, `src/hub/daemon.ts`, `docs/design/task-board.md`, `docs/sdlc.md`, `scripts/seeds.json` and three plan tests; this task's row and its one new file are untouched, so the overlap was file-level only |
| `sup-e8c72e6a6600` | `declared_overlap_without_integration` | 866 | `14:5` | `overlap:866:917` | `request_integration` | pending at reading 11 (written 18:40:41 KST); expired at 18:49:46 KST, 9 m 05 s after the write and at the same second a row at revision `15:6` was written, so the revision moved under it; unknown from stored records whether the queue closed it because the revision moved or on its own schedule | #917 (codex) had no open pull request at reading 11; its plan names `src/cli/terminal-recovery.ts`, `src/cli/recovery-launch.ts` and the `src/cli/upgrade*.ts` slice, and its owner stated the dogfood edit rewrites the existing upgrade/recovery row in place rather than inserting one, so the overlap is file-level and plan-level only |
| `sup-9b89abfbd309` | `declared_overlap_without_integration` | 866 | `15:6` | `overlap:866:917` | `request_integration` | expired at 20:23:59 KST, 1 h 34 m 13 s after it was written, 54 s after #917's PR #1456 was created (20:23:05 KST); the PR was re-filed at 20:28:01 KST, after the row had closed; unknown from stored records whether that filing is what closed it | #917 (codex) filed PR #1456 for #1426. At head `1a5dc48f8`, and again at the re-filed `3b6307ace`, its only `docs/dogfood.md` change is `@@ -247 +247 @@`: the existing `Upgrade and recovery` row rewritten in place to `Upgrade and recovery (#1426)`, one line out and one in. This task inserts one row after the supervision row at 135, so the overlap is file-level only and the two rows sit 112 apart |
| `sup-0aeb441a4c3f` | `declared_overlap_without_integration` | 866 | `19:8` | `overlap:866:897` | `request_integration` | written at 23:55:49.613 KST on 2026-11-13, 149 ms after #897's accept (23:55:49.464); expired at 01:50:04 KST on 2026-11-14, the second the hub's idle sweep reassigned this task away from its owner, so my side's latest episode stopped being an accepted one | #897 (codex) is `agent-hub#1403 T7`, the advisor survey and the considered-and-rejected ledger: `in_progress`, no pull request, blockers `PR identity missing` and `current PR evidence unknown`. Its plan lists `docs/dogfood.md` among its paths and its settled row goes after the security-audit row at 107, 28 rows above this task's insert at 135, so the overlap is file-level only |
| `sup-2167e4441732` | `declared_overlap_without_integration` | 866 | `19:8` | `overlap:866:921` | `request_integration` | written at 01:07:29.867 KST on 2026-11-14, 175 ms after #921's accept (01:07:29.692); expired in the same sweep second as the row above (01:50:04 KST) | #921 (codex) is the Claude Code 2.1.323 implementer receipt, `in_review` on PR #1462 at `b4d5ee1b9`. Its five paths include a new `docs/verification/2026-11-13-claude-implementer-2.1.323.md` receipt, a different new file in the same directory as this pilot's, so the overlap is directory-level only |
| `sup-e16589b19f9d` | `declared_overlap_without_integration` | 866 | `19:8` | `overlap:866:916` | `request_integration` | written at 01:12:29.609 KST on 2026-11-14, 177 ms after #916's accept (01:12:29.432); expired in the same sweep second (01:50:04 KST) | #916 (codex) is the configured conductor switching a project between `off` and `advise` (`#1432`): `in_progress`, no pull request, and its `feat/1432-conductor-sdlc` branch is a worktree at main's tip with no commit of its own. Its plan lists `docs/dogfood.md` and a `src/hub/` slice; this task writes no source file, so the overlap is file-level only |
| `sup-d55cbd37434e` | `declared_overlap_without_integration` | 866 | `22:9` | `overlap:866:897` | `request_integration` | written at 01:50:20.009 KST, 338 ms after this task's re-accept (01:50:19.669); **pending at readings 13 and 14**, and pending until the wave closes because #897 is still open | same file-level settlement as `sup-0aeb441a4c3f`; the row is the pair's second incarnation after the revision moved, which is what a revision-keyed proposal looks like when the same condition holds again |
| `sup-4e799e1e9952` | `declared_overlap_without_integration` | 866 | `22:9` | `overlap:866:916` | `request_integration` | written at the same 01:50:20.009 KST, **pending at reading 13** and **expired at 03:06:27.826 KST**, 0.63 s after #916's review request (`reviewAt` 03:06:27.197, PR #1463, still `in_review` with no approval) | same file-level settlement as `sup-e16589b19f9d` |
| `sup-913163059a34` | `declared_overlap_without_integration` | 866 | `22:9` | `overlap:866:921` | `request_integration` | written at 01:50:20.009 KST; expired at 03:01:15.994 KST, 0.56 s after #921's review request was recorded (`reviewAt` 03:01:15.436), so the pair left supervision at `hub_task_done` and not at a verdict: #921 reads `in_review` with no approval | same directory-level settlement as `sup-2167e4441732`; #921's PR #1462 was already open at the row's write, so the write and the close bracket the review request rather than a filing |

A pending proposal stays pending until the wave closes: classifying one while later revisions are
already in view would let its outcome be chosen to fit them. No row on this task was pending at
readings 3 to 10, reading 11 had one (`sup-e8c72e6a6600`), and none is pending at reading 12: it
expired 9 m 05 s after the read that saw it, so twelve readings have carried two pending rows and
both closed before the next reading. Reading 13 is the first read that ends with rows still
pending: `sup-d55cbd37434e` and `sup-4e799e1e9952` were written at revision `22:9` at
2026-11-14 01:50:20 KST and were still pending at 03:02 KST, because #897 and #916 are both open,
so they stay pending into the close unless a partner finishes first. Reading 14 leaves one of them:
#916's ended at 03:06:27 KST, 0.63 s after its review request, and `sup-d55cbd37434e` still holds on
#897, which has no pull request. An expiry is the queue's own
disposition and not a classification: it records that the reading stopped holding, and it counts
neither as a helpful or false intervention nor as a clean non-trigger.

## Cost

| item | shadow wave |
| --- | --- |
| model calls | 0 (no inference path in the rules or the queue) |
| memory writes | 0 |
| daemon evaluations | pending (replayed from board revisions) |
| rows written | 7 at the first conductor read, 3 of them on this task; the task-narrowed read shows 9 at reading 12: the same three, two written and expired before reading 10, three more written between readings 10 and 11 (two expired, one still pending at that read), and one at `15:6` written at 18:49:46 KST as that pending row closed. All nine are expired at reading 12. Fifteen at reading 13, six more: three at `19:8` written 149 to 177 ms after their partner's own accept and all closed in one second by the idle sweep's reassignment at 01:50:04 KST, and three at `22:9` written 338 ms after this task's re-accept, one expired 0.56 s after #921's review request and two still pending. The write latency is measured rather than inferred: `observe()` runs on the accept path, not on a scan. Reading 14 wrote none of its own and closed the #916 row, so the ledger held at fifteen while the refusal counter rose. Written by the daemon on a task change and not by this task |
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
  defect of any task. Reading 12 adds two closes this list cannot attribute: the `14:5` row closed
  at the instant the revision moved under it, and the `15:6` row closed 54 s after #917's PR
  appeared and before any approval of it. Both ended the pair at something other than an approving
  verdict, and neither stored row names which of the rule's four conditions stopped holding;
  reading 14 adds the mirror case, since #921's row had already closed 0.56 s after its review
  request when PR #1462 merged as `1410628a0`, so that merge could not be named either — a pair
  that leaves at the verdict, the filing or the review request loses the merge that follows it;
- every row the read page left out. Reading 5 measured the page bound for the first time: the
  unfiltered read returned two of my three rows because the other 48 slots of the 50-row page went
  to rows on tasks I cannot decide, and the `task`-narrowed read returned all three. The size of
  the queue past one page is therefore unknown from a role-scoped read, and a wave total that adds
  up role-scoped reads without narrowing by task is an undercount;
- the six refusals readings 6, 7, 8 and 9 reported. `refused` is a bare counter: it names no task,
  rule, revision or bound, and only the conductor's queue read could say which. Readings 7, 8 and 9
  narrowed its window rather than its cause: the daemon's own start time (2026-11-12 11:09:48 KST)
  puts readings 5 through 9 in one lifetime, so the six are real additions and not a reset
  artefact, and every increase after reading 6 arrived inside a window the receipt could pin (2 h
  35 min, then 2 h 09 min, then 2 h 01 min). What stays unknown is the attribution, and the earlier
  readings predate that window, so the wave's refusal total remains a lower bound built from
  per-read samples;
- the three refusals reading 11 added inside reading 10's own lifetime (0 to 3 in 5 h 20 m, windows
  13:25 to 18:45 KST). This is the tightest window the wave can pin and it still names no task,
  rule or bound, so it dates the refusals without attributing them; the lifetime total is 3 and the
  wave total is unknown because two lifetimes preceded it (6 in the lifetime that ended, and an
  unknown number before it). Reading 12 added none in the following 2 h 05 m, a window in which the
  queue wrote a row and closed two, so the lifetime total stays 3 across 8 h 50 m; reading 13 then
  added thirteen in 6 h 12 m (3 to 16) while this task wrote six rows and held two pending, the
  widest refusal window the wave has measured, and it is still a count without an attribution;
  reading 14 added twelve more in 53 m (16 to 28), 13.6 an hour, with no row written and one
  closed, so inside one window the counter and the ledger moved in opposite directions;
- whether this task's own plan refresh advanced the revision from `14:5` to `15:6`. The hub
  recorded the update at 18:45:02 KST, the queue wrote a row at `15:6` 4 m 44 s later, and the
  `14:5` row closed at that same second. A role-scoped read carries the revision pair on each row
  and not what derived it, so the attribution stays open even though the ordering is measured;
- which task event derived revision `19:8`. Between reading 12 at 20:50 KST and the first `19:8` row
  at 23:55:49 KST this task's history records only the 22:45 KST reassignment, pi's decline and my
  re-accept, so one of them derived it and the read cannot say which. Revision `22:9` is not in
  this list: the sweep, the decline, the reassignment back and my accept all sit in the same minute,
  and the three rows were written 338 ms after the accept that ended that minute;
- every threshold that needs a live sample larger than this pilot can produce.
