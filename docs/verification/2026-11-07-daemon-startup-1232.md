# Daemon startup and pending readiness (#1232)

Date: 2026-11-07. Refs #1232, task #770.

The historical 11-16 second startup did not reproduce. An isolated real-state
copy started in 2503 ms before the change and 2171 ms after it. The representative
synthetic fixture on dgx02 took 2201 ms before and 1382 ms after. These are single
observations, with different runtimes and different event mixes as described
below; they do not establish a general speedup or the historical cause.

The measured redundant work was three full `events.jsonl` seed reads. They now
share one lossless streaming pass. No persistent index, migration, log rotation
or historical-key truncation was added. The index follow-up is #1266.

## Method and boundaries

Each sample used a fresh isolated project and state copy. Wall time starts with
the measured child launch and includes imports and daemon initialization through
readiness. Copying or generating the fixture happens before that clock. The
phase line measures exclusive boundaries inside `startDaemon`; import time is
reported separately from those phases.

The real state remained on this Mac. Its copied database used SQLite's online
read-only backup; only the destination was normalized out of WAL mode so the
first Bun read did not depend on missing sidecars. The event copy retained a
complete append-only prefix. Private files and directories had private modes.
The measured child had isolated HOME/tool homes, a loopback port allocated at
startup, no peers, no gateway/model/sync work, and both application effect guards
and a Seatbelt profile denying outbound networking and the original state paths.
Storage and cache initialization remained enabled. Every successful observation
reported zero prohibited effects, stopped its owned child and removed the copy.
The real hub's listener identity was unchanged.

The authorized three-attempt limit was exhausted, including the first failed
attempt: it stopped before daemon startup because a freshly backed-up WAL-mode
database lacked sidecars for Bun's read-only open. That attempt has no startup
timing claim. A public WAL-backup regression covers the correction. Attempts 2
and 3 are the before/after Mac observations below. No private state was sent to
dgx02, and no task or event body was read into the model.

The dgx02 fixture matches the before-copy counts and aggregate byte sizes, not
its private contents. Every synthetic event is a native-end record, a worst-case
dedupe-set workload rather than the real event-type distribution. Its rollup is
cold; the real copy retains its existing rollup cursor. SQLite page padding makes
the synthetic DB 8192 bytes larger than requested. The private `ready` phase is
about 1.24 seconds and is not reproduced by this aggregate synthetic fixture.

## Observation bindings

| Observation | Head | Runtime | Wall ms | Import plus startup ms | Phase total ms |
| --- | --- | --- | ---: | ---: | ---: |
| Mac copied state, before, attempt 2 | `efe43fdbc62b35495a160dcf71ba119479fc12f3` | Bun 1.4.4, macOS arm64 | 2503 | 2479 | 2346 |
| Mac copied state, after, attempt 3 | `b4ae2e66dacb80f537a55e1daef701498d117449` | Bun 1.4.4, macOS arm64 | 2171 | 2144 | 1995 |
| dgx02 synthetic, before | `efe43fdbc62b35495a160dcf71ba119479fc12f3` | Bun 1.4.2, Linux x64 | 2201 | 2182 | 1989 |
| dgx02 synthetic, after | `a87e3c5d7e243d350ee19dc7d38c6d792b9f7873` | Bun 1.4.2, Linux x64 | 1382 | 1362 | 1167 |

| Profile | Mac before / synthetic | Mac after |
| --- | ---: | ---: |
| DB bytes | 38260736 / 38268928 | 38260736 |
| Tasks / history entries | 773 / 8383 | 775 / 8425 |
| Task text bytes | 941219 | 943364 |
| Delivery rows / payload bytes | 2052 / 10429841 | 2052 / 10383407 |
| Event bytes / lines | 135894851 / 723243 | 136341131 / 725816 |
| Abandoned files / aggregate bytes | 7 / 94021653 | 7 / 94021653 |
| Largest abandoned file bytes | 16932725 | 16932725 |

The real hub continued running between copies, so its two profiles differ.

## Phase timings

All values are milliseconds. The phase names and numeric-only line shape are
fixed; unavailable or regressing diagnostic clocks cannot fail startup.

| Phase | Mac before | Mac after | Synthetic before | Synthetic after |
| --- | ---: | ---: | ---: | ---: |
| schema | 1 | 1 | 1 | 1 |
| source | 38 | 41 | 24 | 24 |
| configuration | 1 | 2 | 3 | 3 |
| control | 3 | 2 | 6 | 6 |
| recovery | 1 | 2 | 0 | 1 |
| journal | 45 | 44 | 38 | 42 |
| bus | 71 | 91 | 88 | 100 |
| memory | 87 | 88 | 61 | 59 |
| model_runtime | 0 | 0 | 1 | 0 |
| board | 2 | 2 | 1 | 2 |
| task_runtime | 170 | 177 | 38 | 37 |
| native_stop_seed | 209 | 229 | 598 | 685 |
| budget | 1 | 1 | 7 | 9 |
| usage_seed | 223 | 36 | 535 | 79 |
| usage_rollup | 2 | 2 | 33 | 33 |
| token_runtime | 13 | 10 | 13 | 13 |
| token_seed | 14 | 14 | 10 | 12 |
| services | 14 | 15 | 25 | 28 |
| transcript_usage_seed | 216 | 0 | 478 | 0 |
| ready | 1235 | 1238 | 28 | 30 |
| post_ready | 0 | 0 | 1 | 3 |

The three seed calls already exist at v0.20.0 (`daemon.ts` lines 1969, 2123 and
3277) and v0.23.0 (lines 2375, 2565 and 4123). The measurements do not show that
these calls were introduced during the historical latency jump.

## I/O and semantic preservation

| I/O observation | Mac before | Mac after | Synthetic before | Synthetic after |
| --- | ---: | ---: | ---: | ---: |
| Aggregate event bytes read | 407685899 | 136341537 | 416073489 | 144283569 |
| Streaming seed passes | three legacy full reads | 1 | three legacy full reads | 1 |
| Streaming seed bytes | not separately recorded | 136341240 | not separately recorded | 135894960 |
| Event `readFileSync` calls after the change | not separately recorded | 0 | not separately recorded | 0 |
| Separate auxiliary event bytes | not separately recorded | 297 | not separately recorded | 8388609 |
| Abandoned snapshot body bytes | 0 | 0 | 0 | 0 |

Seed bytes include the child's new hub-start record. Aggregate I/O also includes
the existing bounded rollup poll and the appender's one-byte newline check. Cold
synthetic auxiliary I/O is 8 MiB plus that byte; the warm private copy reads a
small remaining tail. Those reads are shown explicitly rather than claimed to
be part of a single physical read of every consumer.

The later benchmark-only review correction independently attributes bytes around
the real synchronous `UsageRollup.poll` method and restores its original
descriptor. Acceptance caps that actual rollup I/O at its existing 8 MiB budget
and permits at most the appender's one extra byte outside the seed and rollup
scopes. A second streaming descriptor pass outside either scope, or a full-log
poll inside the rollup scope, is rejected. Private attempt 3 predates these scoped
counters: its 297 auxiliary bytes are retained as an aggregate observation, not
retroactively assigned to `usageRollupReadBytes` or `residualExtraReadBytes`.
There was no fourth private run. The underlying daemon change is unchanged.

The shared line predicate preserves measured-time handling, malformed-line
skipping and a complete final JSON record without a newline. Streaming UTF-8
decoding has no line-size or history ceiling. Native-stop IDs and Claude usage
IDs are folded during the pass, while the existing budget, Kimi and token-window
consumers reuse the same accepted event array. Their existing expressions and
historical keys remain intact.

## Readiness behavior and checks

The status promise and runtime schema are unchanged. A signed, bound own child
that remains pending gets one stderr notice after 12 seconds. The CLI continues
waiting, and authenticated late readiness uses the existing runtime admission
and confirmation path once. Death, authority cancellation or the 120-second
outer bound cannot turn unknown startup into success. An outer-bound failure
leaves the daemon running and its runtime unconfirmed. Each connect/status pair
gets at most half the remaining wait budget; ordinary `inspectProject` callers
retain their API and timeout semantics.

At `a87e3c5d`, typecheck, 41 tests and the representative synthetic acceptance run
passed. At `844fbbdc0461b884b7c69234c3c4c5c05510b6c3`, typecheck and 62 tests
passed, including actual retained-runtime lifecycle fixtures and a real owned
fake child's signed identity. Its subsequent inventory check listed the 39 new
keys, which are classified separately without changing the baseline or existing
labels. Tests compare legacy and streamed seed results, long/fragmented UTF-8
records, quota/Kimi/token semantics, actual reader I/O, repeated observer calls,
late confirmation, cancellation, competing claims and both readiness bounds.

The pinned Bun 1.4.2 bundle was regenerated after a worktree-local frozen install.
Final canonical gate, hosted CI and review-thread evidence are recorded in the
PR/task. No interactive agent start or real account/model behavior is claimed.
