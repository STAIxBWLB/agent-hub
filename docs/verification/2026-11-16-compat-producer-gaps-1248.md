# Compat receipt producer gaps (#1248)

Date: 2026-11-16. Hub task 978, Refs #1248 and #888. The issue's "Not met yet" list named three gaps the daily `agent-compat` run showed on 2026-11-12: pi `producer-not-importable`, kimi-review `producer-not-committed` (with `autoAdmit: true`) and qwen `proof-failed` on the cleanup legs. This records what each one was, what changed, and what still keeps a version from being admitted by CI. No account, API key or model was used: every check below ran the harness (`scripts/compat-receipt.ts` and its worker) against the published npm or GitHub release artifact, with a private HOME, on this Mac (arm64) and on the hosted runs' stored artifacts.

## Result in one table

| Id | Gap on 2026-11-12 | Cause found | Change | Can CI open a PR now? |
| --- | --- | --- | --- | --- |
| pi | every leg `producer-not-importable` | The historical producers (`docs/verification/pi-152-model-free.ts`, `pi-152-native.mjs`) were top-level scripts and the worker had no `pi` branch, so the harness only installed the package | `proofs/pi.ts` plus the byte-identical driver `proofs/pi-native.mjs`, wired into `proof-worker.ts` | Yes. All nine legs pass on 1.5.2 and no required leg is human-only |
| kimi-review | `native-tool-loop`, `write-absent`, `write-positive-control` fail | Two producer bugs, below. Not a Kimi 2.6 regression | Update check switched off in the native child; the 2.6.x refusal wording accepted exactly | No. Its required `source-review` leg is human-only, so the outcome is `not-run` by design |
| qwen | cleanup legs `fail`, `ownedStopConfirmed: false` (0.27.2, 2026-11-12) | Not reproduced. One failed receipt of six read, none in six local runs | Nothing changed in the producer | No. `reviewed-optional-lifecycle-replay` is human-only, so the outcome is `not-run` by design |

## pi

The nine legs are the ones the 1.5.0 and 1.5.2 receipts record: native identity, extension load and RPC session identity, installed SDK registration, managed tool callback with receipt replay, failed tool result, zero provider requests, host permission modes, version admission and isolated-home cleanup. `proofs/pi.ts` keeps every assertion of the 1.5.2 producer and changes only what a harness needs: the launcher, package root and version are the installed candidate's (bound by the installer's npm integrity), each native child runs under the bounded command port, and the SDK driver is copied unchanged.

Two legs needed a decision, not a copy:

- `host-permission-modes` and `version-admission` test this checkout, not the candidate. They run the same test files the receipts ran (`test/permission-modes.test.ts` "Pi mode grants", and `test/pi-compat.test.ts` with `test/compat.test.ts`), with every hub variable removed from the environment.
- `isolated-home-cleanup` was a hash of the account's `~/.pi/agent` before and after in the receipts. It still is: SHA-256 over path and content of every file there, skipping `sessions`, `logs`, `cache`, `caches`, `install`, `installs` and `bin` (the entries the earlier receipts excluded), bounded to 20,000 entries. A home that is absent before must still be absent after, so a run that wrote outside its private home fails the leg.

Measured: `bun scripts/compat-receipt.ts pi 1.5.2` (through `runCompatReceipt`) installed the exact npm artifact (integrity `sha512-mUWI04rqF1Vd/m1q+Ps1XeWsTXEVvRUnsmRa83I3Dzua0Tx5bYS93imeqtIfrXf7PkkaR6ERz+AuQhIJlom5yA==`, equal to the 1.5.2 receipt's), ran in 11.4 s, and returned `outcome: pass`, `eligible: true`, all nine legs `pass`, owned stop confirmed. `test/compat-receipt-pi.test.ts` shows each leg failing for the fault it exists to catch (a wrong version, stderr noise, a missing extension, a second effect, an allowed denial, a nonzero message count, a missing shutdown event, a provider request, a failing host fixture, a changed account home, an unconfirmed stop, an aborted run).

Hosted evidence is the next daily run after this merges; this PR does not claim it.

## kimi-review

Both causes were found by running the harness on the verified 2.5.1 and on 2.6.2 and tracing the failing assertion. They fail identically, so neither is a 2.6 behavior change.

1. **The CLI's startup update check.** Kimi fetches the release manifest from `code.kimi.com` when it starts. The loopback-only preload refuses that attempt (as designed) and logs it, so the log that the producer requires to be empty was never empty, and every native leg failed. The documented switches `KIMI_CODE_NO_AUTO_UPDATE` and its legacy alias `KIMI_CLI_NO_AUTO_UPDATE` turn the check off. The producer now sets both in the native child's environment. The empty-log assertion is unchanged: any other network attempt still fails, which `test/compat-receipt-kimi.test.ts` checks with a fault that logs one.
2. **The injected-Write refusal wording.** For a tool the private agent does not list, Kimi 2.5.x returned `Tool Write not found`; 2.6.2 returns `<system>ERROR: Tool execution failed.</system>` then `Tool "Write" is disabled by the active tool policy`. The load-bearing facts are unchanged on both (the two-tool inventory on all four requests, the marker file unchanged, and the exact `hub_task_show`, `hub_review` broker sequence), so the leg now accepts either wording by its exact failure marker plus its exact Write sentence. A vague failure text still fails the leg (tested).

After both changes, on this Mac, `prepare`, `inventory`, `broker-refusals`, `native-tool-loop`, `write-absent`, `write-positive-control`, `environment-decoy`, `network-guard-control` and `cleanup` all pass for 2.5.1 and 2.6.2 (2.6.2's asset SHA-256 `0e198ee3ac1d40964a8dc1da08cdf55f80e5a26d28dfa7a0967cd5a645ec32be` matched the release's digest and its `.sha256` file). The preload (`kimi-loopback-only.cjs`) stays byte-identical to its receipt-bound source, which an existing test pins.

`source-review` stays `not-run (source-review-required)`: a diff of the scoped trust, MCP and allowlist source needs a person (the 2.5.1 receipt's "Source review" section). So the daily run for kimi-review ends in a drift-issue row, never a PR. This is the policy as written, not a gap I can close here.

## qwen

The 0.27.2 run on 2026-11-12 reported `ownedStopConfirmed: false` and failed four legs with `cleanup` or `proof-failed`. Everything else I could read says it was a one-off:

- I downloaded six hosted qwen receipts (0.27.1, 0.27.2 twice, 0.27.3 twice, 0.27.4, from 2026-11-10 to 2026-11-15). Five show every runnable leg `pass` with the owned stop confirmed; the 0.27.2 receipt of 2026-11-12 is the one failure. Its package integrity equals the passing 0.27.2 receipt of 2026-11-11, so the artifact did not differ. (A hosted job's own conclusion is not a verdict here: the workflow step exits 0 for a failed receipt so the artifact is kept, so I read the receipts, not the job colors. I did not read the 0.26.9 and 0.27.0 receipts.)
- On this Mac, six runs of 0.27.4 through the harness (three idle, three under twelve busy loops) passed every runnable leg with the owned stop confirmed.
- The cleanup confirmation reads the process table with `ps` under a 2 s bound inside a 10 s allowance (`scripts/compat-receipts/runner.ts`). A slow `ps` on a loaded hosted runner can end that confirmation as `false`; that is a hypothesis I could not reproduce, so I did not change the bounds.

No qwen code changed. A second hosted failure with the same cause would justify widening those bounds on evidence. As with kimi-review, `reviewed-optional-lifecycle-replay` is a human-only required leg, so qwen cannot be admitted by CI regardless.

## Decision recorded for the person

`autoAdmit` stays `true` for kimi-review and qwen (and for claude-implementer and jcode, which have the same shape: `upstream-impact-review` and `source-comparison`). The T0 audit defines it as policy eligibility after every required leg passes, and the existing tests pin that. The consequence is that only pi can reach a CI-opened admission PR today. Whether a human-only source leg should keep `autoAdmit: true` (the person supplies that leg some other way), or those ids should be marked `false` so the drift issue says so up front, is a policy choice for the person; this receipt does not make it.

A new manifest test now fails any `autoAdmit: true` id that has no producer branch in `proof-worker.ts`, which is how pi sat unnoticed.

## Not verified

- A hosted run of any of this. The next scheduled `agent-compat` run, or a `workflow_dispatch` with `dry: true` on main after merge, is the evidence that the workflow opens (or plans) its first admission PR for pi.
- Linux. Every leg ran on macOS arm64, as the manifest requires.
- Account-backed inference, OAuth refresh, quota and interactive TUI coexistence for pi and kimi-review. They remain explicit unverified follow-ups, not legs.
