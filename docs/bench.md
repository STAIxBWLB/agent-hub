# Benchmarks

`ahub bench` runs a fixed set of tasks against the agents attached to a hub and compares configurations (#251). A run
records each attempt's outcome and the #247 measures of the task (tokens, time, review rounds, rework), never the
suite's text, the verify command's output or the agents' words. CooperBench (`docs/cooperbench.md`) stays the
rigorous native study of this repository; `ahub bench` is for any project.

## A bench project

Each attempt resets the work tree, so a run refuses every project but one kept for benchmarks: a git repository whose
`.agenthub/config.json` has

```json
{ "bench": { "enabled": true } }
```

and whose tree is clean (`.agenthub/` aside). Between attempts the runner runs `git checkout --force --detach <ref>`
and `git clean -fdx -e .agenthub`; a run that finishes returns to the branch it started on, and a run that stops leaves
the tree as its last attempt left it.

## Suite file

JSON, kept with the bench project. Unknown fields, a missing `verify` and duplicate ids are refused with the task and
the field named.

```json
{
  "name": "parser-fixes",
  "tasks": [
    { "id": "csv-quote", "title": "Fix quoted commas in src/csv.ts", "detail": "parse('\"a,b\",c') must give two fields",
      "class": "implement", "owner": "codex", "ref": "3f2c1aa", "setup": "bun install --frozen-lockfile",
      "verify": "bun test test/csv.test.ts", "timeout_s": 1800 }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `name` | the suite's label, kept in the records |
| `id` | the task's label, kept in the records |
| `title`, `detail` | what the hub proposes (never recorded) |
| `class` | the task class; `implement` when absent, since a hub without a model cannot triage |
| `owner` | the peer to propose it to; absent lets routing choose |
| `ref` | the commit the attempt starts from |
| `setup` | a shell command before the task is proposed (bounded, 5 min) |
| `verify` | a shell command run in the tree the agents left; exit 0 is a pass (bounded, 10 min) |
| `timeout_s` | 10 to 86400 seconds from the start of the attempt to approval |

`name`, `id` and the arm label are stored; keep them free of anything private.

## Running

Start the peers of the configuration under test (`ahub claude`, `ahub codex`, `ahub pi`, their models, permission
modes and `routing.toml`), then:

```bash
ahub bench run suite.json --arm baseline --repeat 5
ahub bench run suite.json --arm ripwire-on --repeat 5 --tasks b,a,c   # --tasks also sets the order
```

Only a person can run a suite (agent shells are refused). Each attempt resets the tree to `ref`, runs `setup`, proposes
the task as the console does, waits until it is approved or `timeout_s` passes, then runs `verify`. Outcomes:

- `pass`: approved and `verify` exited 0;
- `fail`: approved and `verify` exited non-zero or ran out of time (`verify timeout`);
- `timeout`: not approved in time. The run stops there, because an agent may still be working in the tree the next
  attempt would reset; settle the open task on the board before the next run;
- `error`: the reset, `setup` or the proposal failed, the hub stopped, or a person interrupted the run (the reason is
  one of a closed list).

Ctrl-C stops the run at its next check: the attempt in progress is recorded as `error` (`interrupted`), its task stays
open on the board, and the run reads `stopped`. A run whose runner died without its end record reads `interrupted`.

## Store

`~/.agenthub/bench/<run id>.jsonl` (directory 0700, files 0600), one file per run, shared by every bench project on the
machine. Schema `agent-hub.bench/v1`:

- `run` header: suite name and SHA-256 of the suite file, arm, fingerprint (attached peers with state, requested model
  and permission mode; the SHA-256 of `routing.toml`; the hub version), task order, repeats, the runner's process.
- `attempt`: task id, repeat, outcome, error reason, verify exit code, hub task id, start, end, duration, and the
  #247 measures of that task (tokens, wall and active time, review rounds, changes requested, failed checks, first
  pass, turns, files changed, models).
- `end`: end time, and `stopped` (`timeout`, `interrupted`, `error`) when the run did not finish.

## Reading results

```bash
ahub bench list                               # runs on this machine
ahub bench status                             # the run in progress
ahub bench report <run> [--json]              # per task and overall
ahub bench compare baseline ripwire-on [--suite parser-fixes] [--json]
ahub bench export --format csv
```

Measures: pass rate (over attempts that did not end in `error`), first-pass rate, median tokens and wall time per
attempt, mean rework. `compare` takes run ids or arm labels (an arm means all its finished runs), sets the first as
the baseline and gives each other arm's difference with a 95% bootstrap interval (1000 resamples, fixed seed, so the
same records give the same interval). Below 5 attempts in either arm a difference is marked inconclusive. Agents may
read all of this. CSV columns: run, suite, arm, task, repeat, outcome, error, verifyExit, hubTask, startedAt, endedAt,
ms, tokens, wallMs, activeMs, reviewRounds, changesRequested, checkFailed, firstPass, turns, filesChanged, models.

The dashboard's Benchmarks section shows the latest runs with their progress (the attempt in progress, elapsed time and
attempts left while one runs) and, per suite with two or more arms, a bar per arm and measure with its number as text.

## A fair comparison

- Change one thing per arm (a model, a permission mode, an add-on, a routing rule) and keep the suite, the refs and the
  peers otherwise the same; the fingerprint shows what differed.
- Repeat: agents are not deterministic. Five attempts per task and arm is the floor for a comparison; more narrows the
  interval.
- Randomize the order per run with `--tasks` (for example `--tasks "$(jq -r '.tasks[].id' suite.json | shuf | paste -sd, -)"`)
  and interleave the arms' runs, so quota, time of day and provider load do not line up with one arm.
- Keep `verify` independent of the agents' own tests where you can: a hidden test the agents never see measures the
  outcome, not their opinion of it.
