# Friction journeys

The friction corpus counts the states where a person or agent is stopped and says whether the output helped. It drives a built `ahub` as a subprocess in a throwaway HOME, state directory and git repository, offline, with no model call and no account. It never instruments the product, so an old release and the current build run the same corpus. Spec: agent-hub#1644.

## What is measured

A block is a step that exits non-zero. The classifier (`scripts/benchmarks/friction/classify.ts`) is one function used by every mode:

| Class | Meaning |
|---|---|
| `in_band` | the output names a continuation that parses, the runner ran it, and the blocked step then passed |
| `dead_end` | the output names a continuation, the runner ran it, and the step is still blocked |
| `out_of_band` | the output names nothing to run |
| `by_design` | the refusal says it is closed on purpose (`by design`, `refusal-ok`, `person only`) |

A continuation is a command that starts with `ahub`, after a run-in word or inside backticks. A placeholder, a shell metacharacter or an unbalanced quote never parses. The first output was a surprise worth keeping in mind: the human prose that follows a command ("run ahub init there first") is cut at the first stop word, and that cut is a deliberate shortcut (`ponytail:` in the source) until refusals carry a structured continuation (#1643).

## Run it

```
bun scripts/benchmarks/friction/run.ts --binary src/cli/main.js --out results.json
```

`results.json` carries the corpus version, the measured binary's path, version and sha256, class counts in total and per journey, and every step with its class. A binary that does not start fails the run: it never falls back to an older one. A step that was expected to be blocked and was not, or the reverse, is a corpus error and exits 1.

## Compare two runs

```
bun scripts/benchmarks/friction/compare.ts a.json b.json
```

It prints both binaries' version and digest, the total class deltas and each journey's deltas. It refuses two reports of different corpus versions: the counts of two measuring sticks say nothing about each other.

## Nightly report

`.github/workflows/friction.yml` runs the corpus on main every night and uploads `results.json` as an artifact. It has read-only permissions and no secret; it writes only the job summary and the artifact.

## Add a journey

Add an entry to `JOURNEYS` in `scripts/benchmarks/friction/journeys.ts`: an `id`, what it `guards` (the issue or contract of the defect it keeps from returning), optional `setup` commands, and `steps`. Mark a step `expectBlock: true` when the journey is about the block. Run the corpus twice: the class counts must match (`test/benchmarks/friction.test.ts`).

## Status

Report only. It is not part of `scripts/check.sh`; a gate comes after two stable weeks with no dead end on main. The corpus holds twelve journeys, nine of which run; three are listed as skipped with a reason and never counted (queue full: the cap is a startup setting; unresolved review threads at merge: needs a full fake GitHub pull-request read; spec changed after acceptance: the edit cannot be re-read through the assign path). A second peer comes from a config patch that adds `roles.worker1`, since the hub admits only `claude` as a plain channel peer. Hub-tool steps (`{tool, peer, args}`) run through the measured binary's own control client.

First run on main (binary 0.46.1, corpus v2, 2026-11-24): in_band 2, out_of_band 6, dead_end 1, by_design 0. The one dead end is `handoff-to-unregistered-project`: the refusal points at `ahub projects`, which lists projects but cannot register the missing one, so the retry is refused again. #1688 (Refs #1686) made that refusal lead with `ahub --project <path> init` when the target is a typed path, and the journey now hands off to a sibling repository by path. On the 0.47.0 build (corpus v2, 2026-11-26) the counts are in_band 3, out_of_band 6, dead_end 0, by_design 0. Later numbers are in the latest `results.json` of the nightly job.
