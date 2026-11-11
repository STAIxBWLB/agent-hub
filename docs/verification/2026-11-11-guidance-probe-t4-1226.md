# Guidance probe T4 qualification (fake-provider leg)

Date: 2026-11-11. Refs #1226. This is a human verification record for the producer receipt read, the Guidance panel's probe status and the focused fake-provider
check gate. It is not a live trial: no real model, worker, native session or account was used, and **AC7's authorized real local-worker trial was not run and
stays open**.

## Scope and authorization

T4 (the approved part) adds a read-only `Tasks.guidanceProbeReceipts`, the control op `guidance_probe_receipts` with its own feature flag and conductor label, the CLI
`ahub guidance probe receipts --id HASH [--json]`, a producer-only `guidanceProbe` read port on `projectConsole`, a `probe` read in the existing Guidance panel, the
shared text `guidanceProbeStatusLines`, and four test files plus a shared fixture helper. It adds no runner, config key, write, prune verb or model call, and nothing
selects the constructor-only local adapter (the gate test reads the daemon, CLI, plugin, manager, tasks and every other adapter and fails if one names it).

Fixtures and fakes are source evidence. They do not prove OS confinement, provider behavior, sampling control, effective guidance delivery or model quality.

## Contract points and the check that observes each

| Point | Check |
| --- | --- |
| A real fake-provider run exports its sealed receipts, the denominator and no path | `test/guidance-probe-status.test.ts`: two witnessed arms export two succeeded receipts bound to their slots; the JSON names no workspace or retention location |
| Every reserved slot is in the denominator (AC4) | the same file: failed, timed out and cancelled arms count and keep the pair incomparable; a run the host could not witness is `unknown`; a slot that never started is `planned`, not a success |
| A fallback model or a drifted runtime never rounds to comparable (AC4) | status and gate files: a fallback served model with a drifted runtime is not comparable and has no success |
| Unknown stays unknown | a usage gap exports `usage_unknown` and prints `Token usage: unknown`, never zero |
| The comparable flag is the stricter of two sources | the export's flag equals the public status AND the sealed verdict; the parser refuses a comparable flag beside a reason or above a refusing status |
| Tamper refuses the whole read (AC6) | an edited receipt body, a receipt moved to another slot (swapped through a temporary id), and an edited export (state, digest, counts, slot id, an extra field, an unknown top-level field) never parse |
| A model-written name is screened | an output path under a denied glob withholds that receipt to its digest, the slot and denominator still count it; a label with a bidi override is stripped in the text |
| A location is a state, never a path | retained and pruned slots export `retained` and `pruned` and nothing names the directory |
| Read-only and bounded | three repeated reads change no row, launch nothing, send no message and make no PII screen or lineage call; a read-only Store serves the inputs |
| Authority | only the person or the current configured conductor reads; a stale session, a private turn, a review-only context and a non-operational conductor refuse |
| The control op, label, feature and CLI form are closed | `test/guidance-probe-status.test.ts`: `guidance probe receipts` is in `CONDUCTOR_DAEMON_OPERATIONS`, classified `conductor`, labelled from the wire op; the parser refuses a missing id, a short id, `--revision` and a duplicate `--id` |
| The provider forwards one field and checks the instance and feature | `test/guidance-probe-console.test.ts`: the scripted hub receives exactly `{ t, id, rid }` after a pinned console hello; forged fields, a bad id, an unknown project, a replaced instance and an older hub send nothing |
| A reply for another probe, a tampered export or a missed deadline shows nothing of itself | same file: the provider and the generated panel both refuse and carry no text, no `probe` and no source error beyond the hub's own bounded sentence |
| The generated panel is literal, current and effect-free | same file: late replies after a changed id, a hidden or destroyed panel cannot replace the view; no `host.action`, network, timer or HTML sink exists in the generated source |
| The real CLI prints the shared text, verified JSON, and refuses before sending | `test/guidance-probe-cli.test.ts`: a real process against a scripted hub; default text equals the shared lines, `--json` equals the verified export, an older hub is refused with an upgrade message and no request, a tampered export prints nothing and exits 1 |
| The gate runs the whole fake lifecycle (AC7 fake leg) | `test/guidance-probe-gate.test.ts`: register, baseline and candidate share every non-guidance byte (AC1), one attempt and call per slot (AC3), complete denominator and the stated incomparable reason (AC4), host-sealed bound receipts (AC4, AC6), no ordinary observer reached and public task bytes unchanged (AC5), a mid-run restart is `unknown_held` and never relaunched (AC3, AC6) |
| No path to a live probe | the gate asserts a start refuses before any row is written when no runner is configured, and that no source file selects `createGuidanceProbeLocalAdapter` |

## Mutation checks

Each of these changes was made, shown to fail at least one test, and reverted (the final tree equals the tested tree).

Status file: the privacy screen removed; the export leaking a retained location; a comparable flag not combined with the public status (see the finding below);
receipts read without the Store's cross-check; the parser skipping the receipt digest; the text printing the label raw; token usage printed as a number instead of
`unknown`. Console file: the manager forwarding any field; the manager skipping the probe id match; skipping the feature check; skipping the export parse; the panel
ignoring the returned probe id; the panel without its stale-read guard; the panel showing the whole reply beside a refusal. Gate file: the daemon naming the local
adapter; reconcile recording nothing; reconcile recording the dead session as a known failure.

One mutation survived its first test and is stated here instead of hidden. Removing the "public AND sealed" combination did not fail the first version of the
stricter-only test, because on real rows both verdicts read the same session authoring and agree: a sealed-only pass beside a refusing public status cannot be
produced from real data. The test was rewritten to what is observable (the shared reason, the counts, and the parser refusing a comparable flag that outranks either
source), and the combination in `Tasks` stays as defence in depth that this change does not claim to have a failing test for.

## Gates

Typecheck, the docs check, the hardcoded-values inventory, the bundle check, the four new test files and the existing probe, console and CLI-guard files were run on
dgx02 at the committed head and are reported with the head SHA in the PR and `hub_task_done`. Hosted CI is the gate for the full suite. The unsharded full suite
on dgx02 can stop at its hang-watch bound on a loaded host; that is recorded as not verified, never as a pass.

## Known gaps, not blocking

- AC7's authorized real local-worker trial, and with it real isolation evidence and effective guidance delivery to a model, is not run and is open on #1226.
- A sealed-only pass beside a refusing public status is unreachable from real rows, so the public-and-sealed combination in the export has no failing test of its own.
- The CLI refusal line keeps printable Unicode such as a bidi override, because it goes through the existing `terminalText`; the text this change builds strips
  format characters. Tightening that shared helper is outside this change.
- Installed hub, native peer and account behaviour are unverified: the export is active only after release and a hub upgrade.
