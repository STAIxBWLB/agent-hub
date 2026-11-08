# Kimi sliced wire-log drain (#1283)

Date: 2026-11-08. Scope: deterministic synthetic fixtures only. No personal wire log, account, model call or native session was used.

## Baseline and after

`scripts/benchmarks/kimi-wire-drain-1283.ts` creates three agents with the same append backlog and forces 16 minimum-sized reader slices. Baseline has no scheduler and retains the original synchronous 16-pass behavior. Sliced mode uses the daemon scheduler and a 0 ms continuation between slices.

| Measurement | Baseline | Sliced |
| --- | ---: | ---: |
| Slices | 16 | 16 |
| Drain wall time | 34.401 ms | 33.824 ms |
| Longest synchronous slice | 34.373 ms | 3.296 ms |
| Discovery calls | 32 | 32 |
| Bytes read | 2,082,248 | 2,082,248 |
| Yields | 0 | 15 |
| Caught-up reports | 1 | 1 |

These are one local run's raw values, not a production latency or percentage claim. Discovery and bytes are unchanged; each scheduled invocation returns after one bounded read/commit, and control traffic can run before the next slice. All 16 continuation callbacks are timed individually. The terminal offline read still drains synchronously before drop, and a failed attempt uses the bounded 250 ms follow-up instead of an unbounded 0 ms retry.

## Acceptance criteria

- [x] AC1: the same fixture reports before/after longest synchronous slice and discovery count, with raw values and no inferred percentage.
- [x] AC2: a real daemon `status` request completed between two slices; the test asserts pending-slice ordering, not elapsed milliseconds.
- [x] AC3: fault injection after reader offset advancement proves cancellation cannot discard the uncommitted slice; the delayed timer also contains an event failure and keeps its bounded retry.
- [x] AC4: a new agent created between slices is discovered and counted by the next fresh validation pass.
- [x] AC5: protocol, privacy, rotation, hard-link, shrunk-file, malformed-row and partial-line tests pass; earlier successful rows survive a later failure exactly once.
- [x] AC6: concurrent cues remain serialized at one pending drain, and stop/session replacement cannot rebind the old session.
- [x] AC7: `scripts/check.sh --changed` passed at `a9b777a947ab2636f36da704b71cae8dc157fb6e`, with 12698 pass, 102 skip and 0 fail, ending `check: OK`.

Focused result: 43 tests across the benchmark, delayed-usage, daemon and wire suites passed, plus typecheck. Baseline/sliced receipt generation and the benchmark test also passed independently.
