# Guidance probe T2 qualification

Date: 2026-11-11. Refs #1226. This is a human verification record for the
confined adapter, not the T3 durable producer receipt or a live trial.

## Scope and authorization

T2 uses the existing LocalPeer loop on a fresh private peer, with host-only
lifecycle and purpose, a fixed requested model, role-specific admitted bytes,
read/write/edit tools and experiment-wide accounting. The factory is not wired
into the daemon. No real model or existing worker session was launched, and no
account or production configuration was changed. Live-home/account contents were
not copied or supplied as probe inputs. The same-PID OS crash report was read
read-only for the separate diagnosis described below.

Constructor-injected fake model/fixture ports are source evidence. They do not
prove OS confinement, provider behavior, sampling control or model quality.

## Source and fixture checks

| Committed head | Check | Observed result |
| --- | --- | --- |
| `b403a263204feaf47204ee45561cc4ce4ff3562f` | Remote typecheck and owner-ledger tests | 59 pass, 0 fail, 363 assertions; complete-frame admission, compound rollback, replay and async currentness |
| `bf2bba1deb7032be889d9a7550cb7c811099a11f` | Initial full-source preflight | Typecheck failed on nullable narrowing and one new async fixture literal; tests not run |
| `6faf1b0e1ce87a69071122dfd77f799fd607ee93` | Corrected remote typecheck and 13 focused files | 241 pass, 22 macOS skips, 0 fail, 11385 assertions; skipped legs are not native proof |
| `c14387136f8e51e2af79f199b57ed405fe2d1823` | Async-preparation duplicate fix: typecheck, inventory and 3 focused files | 101 pass, 1 macOS skip, 0 fail, 700 assertions; deterministic barrier verifies no unframed reservation or double launch |

The first required changed gate at `e60557cccb2fbd585935f98c5d4bbca4dd51c7b7`
was deliberately stopped (exit 130) after static review found that a duplicate
could reserve an unframed slot while the original asynchronous frame was pending.
The owned container was observed absent after teardown. That run is not a green
gate. The fix returns current metadata only until the original reservation exists,
while checking the original actor/session/connection and preserving admitted replay.

After this source fix, normal pinned local bundle regeneration was deferred by
fresh resource admission (exit 75, memory pressure warning), including one
conductor-requested retry. The build did not start. Generated files were not
hand-edited and remote build outputs were not copied back. Subsequent
committed-head freshness verification at
`60606e56da5570ff2843211e89d8ed6ddb1cde5a` passed with the existing tracked
assets; build admission deferral alone did not establish stale bundles. The
required gate continued into the full suite. It then reported two registry-guard
failures for the kind-specific LocalPeer factory in generic `src/local/` and was
stopped (exit 130); its owned container was observed absent. The implementation
moves that factory to `src/adapters/local-probe.ts`, preserving the empty
registry baseline and every assertion. Final-head validation remains separately
reported in the PR.

The focused set covers T1 lifecycle/recovery/control, complete request parity,
role input separation, source/tree/binary binding, compound model/file budgets,
post-approval currentness, observer exclusion and existing LocalPeer/tool/path/
OmniRoute behavior. The final committed-head changed gate and hosted CI are
reported separately in the implementation PR; this record does not replace them.

## Local macOS confinement attempt

The three focused suites ran under fresh resource admission, pinned Bun 1.4.2
and an isolated HOME/environment at
`3752a4013feb9e2bb5e44ea990cf21fd399a20cf`.

Observed: **50 pass, 1 skip, 7 fail**. All five role canaries, the default real
profile plus fake-model integration and the real-proof cleanup case failed the
first NC positive control. The default integration observed zero fake model
calls before the refusal. No native confinement or successful model execution
is established by this attempt.

Subsequent bounded private diagnostics at
`e612679bc1c9d7f0e39e3e2c6c943b86912d5832` identify the owned NC child as
`SIGABRT`, with quiescent process cleanup. Its same-PID OS crash record places
failure in dyld `ignition_halt` / `CacheFinder` / `ProcessConfig`, before program
startup; the reported termination namespace is `0x23`, code `2`. These fields
identify the observed startup stage, not the denied resource or root cause.

A separate isolated host diagnostic, `sandbox-exec` with an allow-default
profile running only system `true`, exited 0. It is neither the lane profile,
a negative-boundary test nor a fallback, and grants no probe qualification.

No file, Mach, network or system-data permission was added based on the abort.
No failing native assertion was removed or skipped. The default adapter refuses
before model handoff when its actual proof is unavailable.

A later bounded historical unified-log read used the kernel Sandbox/deny
predicate around the owned NC lifetime. It returned no matching denial, so the
resource remains unknown. A requested fresh logger-plus-canary attempt was
deferred by resource admission (exit 75, memory pressure warning), before the
logger or canary started. No permission was inferred from that empty read.

## Review corrections

Review of `d81db5b7cc7437f60716e00d8d7d318381b74e2d` found three source issues
that its Linux gate did not establish away: non-canonical temporary-directory
parents could refuse admitted writes; the frozen token reservation did not
check each later call's own frame; and private tool errors hid their cause and
recovery step. The correction keeps ordinary paths unchanged and adds an alias
write case, a second-call frame-bound case and typed logical refusal cases.
Results for the corrected head are reported separately in the PR.

## Native confinement root cause (macOS 27.0.1, local)

The "exact denied resource is unknown" statements above were written before this
bisection and stay as the record of that attempt. The cause is now identified,
by plain `sandbox-exec` runs and by the unchanged canaries; no assertion was
removed, skipped or loosened.

1. **Root directory node.** `(deny file-read-data ...)` without `(literal "/")`
   in the allowlist aborts every program at dyld startup (`nc`, `sh` and `cat`
   all exit 134). Hosted macOS run 42967909894 shows the same abort. dyld reads
   the root directory node's data at every process start. A `literal` matches that
   one node, not its children.
2. **The `/bin/sh` stub.** With (1) fixed, the lane script still fails, now at
   its own `sh -c`: on this macOS `/bin/sh` re-execs `/bin/bash` as its variant
   (`Failed to exec /bin/bash as variant for /bin/sh`) and reads the variant
   selector `/private/var/select/sh`. The lane needed `/bin/bash` on the
   `process-exec` allowlist and the selector as one data and traversal literal.
   Allowing `/bin/bash` alone, or the selector's metadata alone, still fails.

With both, the unchanged canaries pass locally: all five role canaries, the
known-quiescent cleanup case and the default real-confinement plus fake-model
lifecycle (63 pass, 1 skip, 0 fail across the sandbox, local-worker and
input-matrix suites).

What the change widens, and what it does not. The selector `/private/var/select/sh`
is now **readable** under the lane profile (that is the grant); it is a system
symlink to `/bin/bash` and holds no operator data. Its siblings stay denied:
`developer_dir`, `X11` and the directory itself all refuse a read. An earlier
draft of this note said the selector's bytes were denied; that was a measurement
artifact (the read failed on writing to stdout) and is corrected here.

The exact generated profile, run through `sandbox-exec` as `/bin/sh`, still denies
reading a file outside the workspace, `/etc/hosts`, the person's home files and
`/Users`; denies executing `python3`, `curl` and `env`; denies a loopback
connection; and denies a write outside the workspace. `/bin/sh` on macOS is the
bash variant stub, so the `/bin/bash` exec grant lets the lane run nothing `sh`
could not. Probe tool dispatch refuses `bash` and `git` before any command
(existing negative test), so no probe tool runs a command at all.

## Remaining evidence

- Local real-profile confinement now passes the unchanged canaries after the root-node and `/bin/sh` stub corrections above; that is one macOS 27.0.1 machine, not the
  hosted gate. The earlier "unknown" statements describe the attempt before the bisection.
- Hosted macOS CI must run the unchanged positive/negative canaries and default
  real-profile/fake-model integration. Linux refusal and fake fixtures cannot
  substitute for that gate. A recurring hosted failure requires investigation.
- Real provider/model/worker behavior, measured gains and the separately
  authorized live leg remain unrun. T3 receipt collection, reconciliation and
  retained-output cleanup remain separate work.

Private evidence is retained at workspace-relative
`scratchpad/temp/task824/resume-20261111/`: `core-preflight.log`,
`source-preflight.log`, `source-preflight-typed.log`, `native-source.log`,
`native-control-owned.log`, `owned-crash.json`, `owned-native-log.txt` and
`native-runtime-control.json`. Raw profiles, physical workspace/home paths and
system report identity fields are not copied into this public record.
