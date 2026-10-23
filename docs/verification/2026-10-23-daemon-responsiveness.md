# Daemon responsiveness, 2026-10-23

## Read-only live evidence

The running released 0.14.0 daemon was sampled for five seconds without restart, mutation or signalling unrelated processes. Of 3,898 main-thread samples, 2,860 were kernel waits. SQLite appeared in 504 samples, including 303 sorter/merge samples; guarded pwrite appeared in 240 leaf samples. These native stacks lack JavaScript symbol attribution. The initial process listing showed lifetime-average CPU 83.9% and RSS about 1.4 GB, while the sample reported a smaller current physical footprint; those are different measurements, not evidence of a sustained current 83.9% load or a GC cause.

Bounded read-only queries found 2,051 delivery rows (only three accepted), with about 8.7 MB of originals/out JSON. `list()` and `snapshot()` sorted full payload rows through a temporary B-tree. The released one-second supervision path called `queueList()` (list plus snapshot for revision) and `knownPeers()` (another full list). Held-row/status and superseded-delivery paths added further whole-history reads. A capped read-only SQL probe measured 16.49 ms for the sorted full read versus 5.56 ms unsorted, excluding JSON parsing.

The board had 398 tasks, seven active/non-backlog tasks and at most 28 history entries per task; planner-WIP probes were below 0.2 ms. Usage tables were small (39 native-rollup and 256 token-rollup rows), and the persisted log offset was only 472 bytes behind the 51.1 MB events file. These observations make those queries weaker explanations for the sampled sustained sorter activity. They do not rule out a cold-start fold stall.

## Candidate and synthetic comparison

The candidate uses pending-state metadata/rows on periodic roster, supervision and held-delivery paths, with a pending-state index. Queue revision is read as metadata; integrity calculations that need queues omit the journal snapshot. Explicit queue/history and recovery snapshots retain terminal history. Usage passes retain their byte cap and atomic rows/offset transaction and stop at a 20 ms boundary between whole records. One record and the existing corrupt-line skip remain indivisible. Launch-only connections retry transport timeouts/unclean closes up to 15 seconds with one busy notice; ordinary three-second connect defaults and terminal authentication/protocol/identity refusals remain.

A fresh synthetic journal contained 2,048 terminal and three pending rows with 2 KiB envelope bodies. Ten measured iterations followed two warm-ups, using the same data and process:

| Query bundle | Median ms | Max ms |
| --- | ---: | ---: |
| Former roster/list/revision-snapshot reads | 67.413 | 69.536 |
| Pending metadata/rows and direct revision | 0.125 | 0.135 |

This is an isolated query-bundle comparison, not a claim about installed daemon CPU, RSS, total request latency or an improvement factor for the whole application. No live database was copied into the fixture.

## Regression evidence

- Reintroducing full-history roster reads or recovery-snapshot revision reads fails a named no-throw assertion against a journal that refuses those hot-path calls. Explicit history still returns its 513 fixture rows.
- Removing the fold time boundary fails the named byte-offset assertion for a zero-budget slice. Complete Unicode record boundaries and rebuild parity remain checked.
- A real daemon with a cold log larger than 50 MiB starts a launch socket inside its actual catch-up pass and answers the authenticated status request. This end-to-end check is separate from the deterministic slice regression; it does not claim an old implementation always exceeded three seconds.
- A fake-clock test exhausts the launch budget at exactly 15 seconds, checks backoff and a single busy notice, and proves immediate unreachable-listener, authentication, wire, instance and unclassified refusals are not retried.
- Focused five-file verification passed 45 tests and 253 expectations on pinned Bun 1.4.2 after the fixture-size correction. The initial fixture-size assertion was retained; its data was increased above 50 MiB.

Installed-runtime CPU/RSS and account-backed native launches remain unverified for this candidate. The existing live daemon was left running unchanged.

The first complete changed gate passed 3,366 tests but exposed one real regression: retrying immediate connection refusal made three failed-launch ownership checks exceed their unchanged 20-second test deadline. The code now treats an unreachable listener as terminal and retries the busy timeout/unclean-close classes only. The original recovery test and timeout are unchanged.

After that fix, the native six-file focused run passed 63 tests/392 expectations using the gate's normal isolated identity/color/Git environment, including the unchanged three-failed-launch ownership test. A prior direct invocation retained agent markers and got two fixture-init refusals; those tests and product authority checks were not changed. The corrected invocation uses exactly the environment clearing already present in `scripts/check.sh`.
