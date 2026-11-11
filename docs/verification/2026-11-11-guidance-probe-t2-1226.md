# Guidance probe T2 qualification

Date: 2026-11-11. Refs #1226. This is a human verification record for the
confined adapter, not the T3 durable producer receipt or a live trial.

## Scope and authorization

T2 uses the existing LocalPeer loop on a fresh private peer, with host-only
lifecycle and purpose, a fixed requested model, role-specific admitted bytes,
read/write/edit tools and experiment-wide accounting. The factory is not wired
into the daemon. No real model, existing worker session, account, live home or
production configuration was used or changed.

Constructor-injected fake model/fixture ports are source evidence. They do not
prove OS confinement, provider behavior, sampling control or model quality.

## Source and fixture checks

| Committed head | Check | Observed result |
| --- | --- | --- |
| `b403a263204feaf47204ee45561cc4ce4ff3562f` | Remote typecheck and owner-ledger tests | 59 pass, 0 fail, 363 assertions; complete-frame admission, compound rollback, replay and async currentness |
| `bf2bba1deb7032be889d9a7550cb7c811099a11f` | Initial full-source preflight | Typecheck failed on nullable narrowing and one new async fixture literal; tests not run |
| `6faf1b0e1ce87a69071122dfd77f799fd607ee93` | Corrected remote typecheck and 13 focused files | 241 pass, 22 macOS skips, 0 fail, 11385 assertions; skipped legs are not native proof |

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

## Remaining evidence

- Local real-profile confinement is **unverified**. The exact denied resource is
  **unknown**; neither a loader stack nor a successful minimal control decides it.
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
