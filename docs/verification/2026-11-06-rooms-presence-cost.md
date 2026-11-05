# Rooms presence producer cost

Refs #1204, CI task 742. Historical macOS comparisons and Linux candidate
measurements are recorded below. macOS candidate acceptance is still pending.

## Failed jobs and revision attribution

- [PR 1217 macOS job](https://github.com/STAIxBWLB/agent-hub/actions/runs/42098376188/job/127501666095)
  checked out `92486ab5c48b4c0281643750590fa6693aaaa7e6` and timed out the
  unchanged 1,000-flip test at 20,025.68 ms.
- [PR 1215 macOS job](https://github.com/STAIxBWLB/agent-hub/actions/runs/42074839676/job/127420743582)
  checked out `dc9e482c659a29fa3f6b4597bc04219f5b5f3fbd` and timed out at
  20,034.80 ms.
- The workflow checks out the PR head. Neither failed head contains T2 commit
  `3185dd4c57e36213a8ca398dd304f3284daa03ed`. Their rooms files, Bus,
  delivery journal and delivery test are byte-identical to
  `b7aec7d5621e25e0ea1df1e5b8b7366b92512bfe` in those paths.
- The requested b7..3185 range has only two intervening commits: handoff T2
  `b5c2525495b42a986207308af815e530f78c0c61`, then rooms T2. The old
  producer path reproduces at b7 itself, so the observed failures do not establish
  T2 as a first bad commit.

## Measured producer paths

The repo-only preload `scripts/diagnose-presence-cost-742.ts` counts fixed
method names and inclusive wall time, never argument text or ids. The original
test and its 20-second guard are unchanged.

The natural run is separate from a controlled scheduling probe. In the probe,
the first hot publication waits for the existing serial seal before calling the
original producer. No state flag is overwritten. This exercises an idle producer
instead of relying on a boot-time publication still being in flight.

Pinned Bun 1.4.2, Linux x64, frozen installs on dgx02:

| Runtime and mode | Flip phase | Sequence reservations in phase | Store transactions in phase | Bus persists, whole case |
| --- | ---: | ---: | ---: | ---: |
| Pre-fix natural, `0a32d86a` | 2 ms | 0 | 0 | 4 |
| b7, controlled idle entry | 10,645 ms | 1,000 | 3,173 | 4 |
| b5c, controlled idle entry | 11,324 ms | 1,000 | 3,161 | 4 |
| Pre-fix `ab751794`, controlled idle entry | 11,868 ms | 1,000 | 4,145 | 4 |
| Fixed FIFO candidate `2452b905`, controlled idle entry | 109 ms | 7 | 33 | 4 |

The pre-fix ab751 phase spent 2,401 ms inside sequence reservation and 5,205 ms
inside Store transactions. These measurements overlap and must not be added.
Transaction timing includes SQL and durable I/O; this is not a separate fsync
syscall trace. The Store uses DELETE journaling and synchronous EXTRA. The data
does not attribute all remaining time to either crypto or the filesystem.

b7 and b5c were separate historical checkouts with the same diagnostic preload.
0a32/ab751 include only close guards and the diagnostic on top of 3185; their room
producer was still unchanged. The b7/b5c comparison and named-red checks ran from
the diagnostic harness at `11e3121f51eff2a9cd60eb95400e568051163072`.

The code defect is cancellation of scheduled coalesced work: ordinary calls
clear the pending republish before starting another seal. If the producer is
already busy, calls collapse; if it starts idle, an awaited loop can repeatedly
reserve durable counters. Task 740's persist fix remains effective: all measured
cases retain four Bus persists.

## Fix and regressions

- Ordinary calls reuse pending republish; response/forced-request priority stays.
- Chat observations precede the chat, and the chat slot is reserved synchronously
  before awaiting the earlier presence. This avoids overtaking by a concurrent
  chat. Tests check ciphertext and real Store insertion order.
- Receipt durability, ACK ordering, caps and actual-send exposure/current fences
  remain covered by unchanged backpressure tests and new focused regressions.
- Closed public and deferred publication return before touching the journal or
  observers. Live storage failures still propagate.
- A failed presence barrier remains an error of its reserved chat, rather than
  a successful empty send or an unhandled rejection.

## Hosted macOS reference comparison

The [reference job](https://github.com/STAIxBWLB/agent-hub/actions/runs/42106515415/job/127522644864)
ran on Darwin arm64 with Bun 1.4.2. Each result below is the unchanged test with
the same diagnostic preload; controlled scheduling is labelled separately.

| Runtime and mode | Whole test | Flip phase | Reservations | Store transaction time in phase |
| --- | ---: | ---: | ---: | ---: |
| b7, natural | 17,806.52 ms | 17,110 ms | 1,000 | 1,194 ms |
| b7, controlled idle entry | 18,798.21 ms | 16,656 ms | 1,000 | 1,438 ms |
| b5c, natural | 698.92 ms | 4 ms | 0 | 0 ms |
| b5c, controlled idle entry | 17,084.92 ms | 16,440 ms | 1,000 | 1,065 ms |
| 3185, natural | 710.99 ms | 2 ms | 0 | 0 ms |
| 3185, controlled idle entry | 17,604.82 ms | 16,902 ms | 1,000 | 1,139 ms |

The slow producer therefore costs about 16.4-17.1 ms per flip on this runner.
For 3185, sequence reservation accounts for 511 ms inside the overlapping
1,139 ms Store transaction time; durable I/O is not the dominant measured time.
The remaining seal/async producer work was not split into separate CPU/syscall
traces. All cases retain four Bus persists, confirming the task-740 fix remains.

The range's lower bound is not unconditionally fast: b7 naturally selects the
slow path in this job. A monotonic good/bad bisect cannot assign the defect to a
newer commit; exhaustive comparison of the two intervening commits shows the
pre-existing scheduling path. This is not a claim that the failed jobs merely
needed their timeout increased.

The job completed all six cases above, then failed because abbreviated reference
924 was absent from that checkout. That final workflow error does not invalidate
the completed cases, but supplies no 924 measurement. The follow-up explicitly
fetches its full SHA and checks the candidate separately.

Controlled red evidence uses unchanged historical source with only the new
regression file copied into an isolated checkout:

- At 3185, the count test fails its named assertion: expected one reserve,
  received 1,001.
- At pre-FIFO-fix 7b99, the concurrent-chat test fails its named assertion with
  B before A.
- The existing seed classifier accepted both as assertion failures, not timeouts
  or runtime diagnostics.

## Evidence limits

- Latest focused source check at 11e312 passed 12 tests, 0 failed, 94 expectations.
  Earlier 2452 passed 18 focused/backpressure tests and the controlled AC1 case.
- The reference run above measured b7, b5c and 3185, not 924. Its temporary
  workflow is diagnostic-only and is not retained in the final change.
- The original failed macOS jobs did not record per-flip counters. Attribution
  of those exact executions to this reproduced path remains an inference;
  hosted reference measurements establish the slow path, not candidate
  acceptance. Linux timing is not macOS acceptance.
- No original test assertion or timeout was changed. No Mac-local gate, live
  room enrollment, native-account acceptance or release is claimed.
