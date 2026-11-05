# Rooms presence producer cost

Refs #1204, CI task 742. Source candidate and Linux evidence only at this stage;
macOS reference measurements and exact-head hosted acceptance are pending.

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
- The [temporary macOS reference run](https://github.com/STAIxBWLB/agent-hub/actions/runs/42106515415)
  was last observed queued. It compares b7, b5c, 3185 and failed head 924,
  natural and controlled modes, sequentially. Its workflow is diagnostic-only
  and is not retained in the final change.
- The original failed macOS jobs did not record per-flip counters. Attribution
  of those executions to this reproduced path remains an inference until the
  hosted measurements are available. Linux timing is not macOS acceptance.
- No original test assertion or timeout was changed. No Mac-local gate, live
  room enrollment, native-account acceptance or release is claimed.
