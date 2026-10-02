# Native CooperBench runs

The runner and report use Python's standard library. The versioned evaluator adapter also needs the optional Docker Python SDK in the supplied CooperBench evaluation environment. The checked-in `scripts/benchmarks/manifest-v1.json` fixes the upstream CooperBench commit, ten feature pairs, image digests, base commits, prompt digests, native model/version labels, topology and time limit. Prompt bodies, hidden tests, gold solutions, transcripts and vendor state are intentionally external and are not stored in this repository.

Fixture preparation is independent of the editor. Before native execution, `native.ts` reads `orca worktree current --json` and requires the reported canonical root to contain this repository. It extracts each pinned archive into a new fixture directory and initializes a git baseline after extraction, so pre-existing and untracked archive files are both represented. Symlinks, special tar entries and paths that escape the fixture are rejected.

## Prepare

Acquire the three pinned CooperBench task archives from the authorized evaluation source and place them in a private directory using these names:

- `pallets_click_task-2068.tar`
- `pallets_jinja_task-1465.tar`
- `samuelcolvin_dirty_equals_task-43.tar`

Then prepare a new output directory:

```sh
python3 scripts/benchmarks/runner.py prepare \
  --manifest scripts/benchmarks/manifest-v1.json \
  --archives /private/path/to/pinned-archives \
  --upstream-root /private/path/to/pinned-CooperBench-checkout \
  --output /private/path/to/new-run
```

The manifest's archive and prompt hashes are checked before a fixture is accepted. The `prepared.json` ledger binds the fixture roots, baseline commits, complete baseline path counts and manifest hash.

## Native execution

Stage `case-00.json` through `case-09.json` outside the repository. Each JSON file supplies the two exact feature prompts in feature order and the official evaluator's private case data. Pass each prior native Claude/Codex transcript as a separate `--protect <file>` argument. Do not expose those files, upstream evaluator/data tree, or prior run artifacts to the agents.

Prepare a new private run directory, then execute a fixed cohort. `--cases 0` runs all three predeclared arms for case zero. It never selects individual arms or retries only a scored subset.

```sh
python3 scripts/benchmarks/runner.py prepare \
  --manifest scripts/benchmarks/manifest-v1.json \
  --archives /tmp/ahub-cc-base-tars \
  --upstream-root /tmp/agent-hub-cooperbench-upstream \
  --output /private/tmp/ahub-0123-case0
chmod 700 /private/tmp/ahub-0123-case0
bun scripts/benchmarks/native.ts \
  --run /private/tmp/ahub-0123-case0 \
  --private-inputs /private/tmp/ahub-0123-private-inputs \
  --upstream-root /tmp/agent-hub-cooperbench-upstream \
  --probe-target /tmp/agent-hub-cooperbench-upstream/dataset/pallets_click_task/task2068/feature1/tests.patch \
  --codex-bin /absolute/path/to/the/pinned/codex \
  --protect /tmp/agent-hub-cooperbench-upstream \
  --protect /Users/yj.lee/workspace/work/dev/agent-hub/.agenthub/state/benchmarks \
  --protect /private/tmp/ahub-cc-bench-20261002-v3 \
  --cases 0
```

The runner registers each exact fixture root with Orca, uses the project CLI to start and stop each daemon, and requires exact worktree/cwd readback for native sessions. Claude starts through the canonical `ahub claude` guard and loads this checkout's candidate bundle through an exact session-only `--mcp-config` server (`server:agent-hub`); it does not promote or mutate the globally installed plugin. Codex uses the native app-server adapter and `workspace-write` sandbox. Each agent must execute a setup-only `head -c 1` probe against the exact protected file and produce only the denied marker before scored tasks begin. There is one native sandbox layer per agent.

Every run record, diff, PTY/provider trace and evaluation artifact stays in the mode-0700 private run directory. Setup errors, structured provider quota errors, hub budget pauses, unsettled deliveries and interruptions stay separate and unscored. A quota snapshot or numeric `429` alone is not a provider error. The runner restores exact input/read-lock modes and the scoped Claude trust flag (removing its own fresh project entry) and sibling artifact modes on exit. It stops only its recorded Claude terminal, hub project and hub terminal handles. Orca currently has no repo removal command, so inactive exact-path fixture repos remain registered after a run; one case with three arms leaves three records.

## Grade and report

The versioned adapter invokes CooperBench's official `test_solo`, confirms the empty-base control fails and the official combined gold patch passes, and substitutes the verified image digest for the evaluator's mutable image tag. It rejects a changed source/data tree, removes stale evaluation outputs, and binds each score to the exact diff/evaluation/evaluator/manifest hashes.

```sh
python3 scripts/benchmarks/runner.py grade --run /private/tmp/ahub-0123-case0 \
  --private-inputs /private/tmp/ahub-0123-private-inputs \
  --upstream-root /tmp/agent-hub-cooperbench-upstream \
  --python /tmp/agent-hub-bench-venv/bin/python
python3 scripts/benchmarks/runner.py report --run /private/tmp/ahub-0123-case0
```

Report rows use qualified identities (`repo:task:feature`) and unavailable attempts remain outside the score denominator. A grade whose manifest, patch, or evaluation hash no longer matches is rejected.

Native run integration must follow the pending settlement and telemetry contracts in #100-102: task approval is distinct from delivery settlement, missing usage remains unknown, and execution limits must name their unit. It must also snapshot and restore any temporary Claude trust/read locks on every exit path, verify native cwd/session/model readiness, use a single native sandbox layer, check the canonical Orca root, and stop only actors, hubs and containers it started. Retry is an explicit new attempt over the complete predeclared cohort, never a score-selected subset.

The fixed ten-pair sample is a convenience sample, not the full 652-pair suite. The shared checkout is not isolated CooperBench coop, and these artifacts do not establish leaderboard parity or causal coordination superiority.

The optional `--codex-bin` selects an absolute native executable when PATH contains several Codex installations. Its reported version must match the manifest. Codex automatic memories and external agent memory import are disabled for the benchmark thread. Native usage totals include the unscored sandbox probe and are labelled as whole-session counters.

`--setup-only` runs every selected arm through native readiness and read-denial probes without assigning feature work. Its cohort is marked as calibration and the grader refuses it. A zero-turn Claude session is bound through its verified Orca launch and then checked against native transcript session IDs after the probe. The instance-fenced metadata file enables the daemon's optional usage reader.
