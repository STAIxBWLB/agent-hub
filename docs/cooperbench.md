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

Prepare a new private run directory, then execute a fixed cohort. `--cases 0` runs every predeclared arm of the manifest for case zero (three in v1, four in v2). It never selects individual arms or retries only a scored subset.

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

Every run record, diff, PTY/provider trace and evaluation artifact stays in the mode-0700 private run directory. Setup errors, structured provider quota errors, hub budget pauses, unsettled deliveries and interruptions stay separate and unscored. A quota snapshot or numeric `429` alone is not a provider error. The runner restores exact input/read-lock modes and the scoped Claude trust flag (removing its own fresh project entry) and sibling artifact modes on exit. It stops only its recorded Claude terminal, hub project and hub terminal handles. Orca currently has no repo removal command, so inactive exact-path fixture repos remain registered after a run; one case leaves one record per arm.

## Manifest v2: the turn-free arm

`scripts/benchmarks/manifest-v2.json` keeps v1's cases, models and limits and adds a fourth arm, `hub-turnfree-codex-claude` (issue #110): the same two agents and assignment rotation as `hub-codex-claude`, with `coordination: "turn-free"` in the fixture's hub config and fixture instructions that tell the owners not to message each other. A v1 manifest still validates and prepares. Its cohorts are run, graded and reported with the release and runner sources they were prepared with: `native.ts` refuses a manifest whose hub version is not the checkout's (v1 pins 0.12.3), and `runner.py` refuses to grade a cohort whose runner sources differ from its own.

Hooks are equal across arms: no arm runs the user's or a plugin's hooks, and no arm runs a status line (`disableAllHooks` turns it off in the other arms, so the turn-free arm leaves it out; Claude's quota reaches the hub in no arm). Claude starts with `--setting-sources project` and `--strict-mcp-config`; the solo and advisory arms set `disableAllHooks`, and the turn-free arm's session settings carry the hub's own hooks (before and after every tool call, and at Stop) and nothing else, because they are the treatment. Every Codex thread starts with `features.hooks` off: the turn-free arm's Codex boundary is the adapter's steer into the running turn, whose readback is the steered input coming back as a user message item. MCP servers are isolated too: Claude has only the hub's (`--strict-mcp-config`), and every Codex runs through a wrapper in the run's private directory that turns off the user's plugins, apps, sub-agents and turn-end notifier and disables each MCP server the user's config defines, by name, so it starts only the hub's; the user's config is not changed. Instructions: Claude reads the fixture's `AGENTS.md` through `--append-system-prompt-file` (Claude Code reads `CLAUDE.md`, not `AGENTS.md`), Codex as the project's `AGENTS.md`; Codex also reads the user's global `AGENTS.md`, which no option leaves out, and the run records say so. Each run record carries these `conditions`; its `events` carry the hub's `capability` readbacks.

Validity, decided by the grader and applied by the ledger alike: an attempt whose records show a hook or an MCP server that is not the hub's, or whose Claude transcript cannot be read, is unavailable. A turn-free attempt is valid only with its context paths working: both verified before its tasks, and none lost, no cohort lifted and none formed open while the agents worked; teardown comes after that and does not count. Whether the agents' plans overlapped, so that a cohort formed at all, is their doing after assignment and is not a condition: every valid turn-free attempt counts for the arm (intention to treat), and the ledger reports the treatment received and a median over treated attempts beside it.

`scripts/benchmarks/manifest-v2-ablation-106.json` is the #106 ablation: the advisory arm against the same arm with `experiments.stale_notices: "deliver"`, which turns stale-notice dropping off and changes nothing else, on the same release and conditions. Its attempts are counted apart from the four-arm plan.

Pass `--repeat <n>` for the n-th repeat of a case (0 for the first): the arm order is row (case index + repeat) of a Williams design (0, 1, n-1, 2, n-2, ... shifted by the row), so over consecutive rows every arm runs right before every other one once and repeats of one pair change which arm runs last. The manifest's `plan` names the release pilot (case 0, three repeats, 12 attempts, an active-time ceiling of one hour) and the study (ten cases, two repeats, 80 attempts, 6 hours 40 minutes at 300 s each, setup, grading and teardown excluded); `runner.py` refuses a plan whose attempts or ceiling do not follow from its arms, cases and repeats.

## Coordination ledger

```sh
python3 scripts/benchmarks/ledger.py --run /private/tmp/ahub-0124-r1 [--run /private/tmp/ahub-0124-r2 ...]
```

It reads each run record, the Claude transcript it names and the fixture's git history, and writes `ledger.json` into the first run directory with a `units` table that names the unit and coverage of every measure. Give `--run` once per directory to pool the repeats of one plan; an attempt a directory's `cohort.json` planned that wrote no record is listed as missing. Per attempt: completion (the runner's end reason and its detail, such as `wall-timeout`, and whether every task has a done); setup and active time; first candidate, completion intents, integration and check times, and each agent's settlement read from its own record (the end of its last native turn after the last done, turns started by late messages included; the last done itself when it did not work after it), and how long the agents could still write after the active time ended (`stopped_s`); usage per agent in task (to its last done on the board) and over the whole attempt: Codex turns, assistant messages, token-usage updates whose running total grew past the total before the window, and the token growth; Claude assistant messages (unique message ids), turns and the tokens their usage records; Claude's main-loop requests by request id (side requests and retries are not in its transcript), and Codex's provider requests unknown (app-server 0.159 does not send its response ids); Codex turns after its done and what started them; late replies, steered or at the next turn; the hub's fact offers, acknowledgements, bytes offered and acknowledged, build times, hook start-up times and steer round trips by path, in the task window; capability readbacks; validity by the grader's gates, and for turn-free the treatment received; held-back messages (`quiet` events) apart from [FYI] messages (which include the final [FYI] the instructions ask for); stale notices; shadow split predictions with their traces; the hooks each agent's records show, by a label that keeps paths and arguments out, with Claude's hook durations and the hub's own timing of every facts hook call; and contributions. Summaries give medians over valid completed attempts and over the (case, repeat) pairs every arm completed validly, totals over all attempts with the number of attempts each was unknown for, and the reasons for the rest. A repeat given twice is refused, and `--plan pilot` (or `study`) lists every planned attempt that wrote no record, whole repeats included. `ledger.json` holds code fragments from the agents' writes and local paths: keep it with the private run data and never commit it; the summary is what a verification record quotes. In-task windows end at different points by arm (a turn-free integration step comes before the done, an advisory completed-change notice turn after it), so arms are compared on whole-attempt usage.

Contributions are a heuristic for possible loss, never a certificate: per agent and file, the identifiers and changed fragments its applied writes introduced (only a Claude tool call with a successful result, or a completed Codex patch, counts; a Write replaces the agent's earlier contribution and is not credited with what other agents wrote; a delete removes it; when a file is moved, every agent's contributions to it are checked at its new path) that the final tree lacks, a fragment counting as present anywhere in the file. A same-name overwrite shows as a lost fragment. Shell commands run during the task are not attributed and are counted under `coverage`, with a missing transcript or an unreadable file. Correctness comes from the official grader, for every arm.

## Preregistration (v2)

Fixed before outcomes are collected (issue #110):

- Order of ablations: the stale-notice change first (#106: `manifest-v2-ablation-106.json`, the advisory arm with and without stale-notice dropping on the same release; comparing with 0.12.3's runs would confound it with that release's Codex hooks), then cohort silence with acknowledged facts and the revision-fenced integration (#107 and #108, the turn-free arm). The split rule (#109) is recorded as shadow predictions only; task allocation stays fixed by case index in both joint arms.
- Primary outcome: the final submitted artifact of each attempt, graded by the official tests with the same controls for every arm. Completed and timed-out attempts are graded (a timeout's final tree is its submission, collected once the agents were stopped, `stopped_s` after the limit); interrupted, infrastructure-failed and invalid attempts are reported unavailable with their reasons. Time to both done is reported only with completion, failures, timeouts and unavailable attempts beside it, and timing comparisons use attempts that completed in every compared arm.
- Resource outcomes per provider over the whole attempt, in the units the ledger names: Codex turns, usage growth and tokens; Claude assistant messages, main-loop requests and tokens (amended on 2026-10-02, before the study: side requests are not in Claude's transcript); hook and fact bytes and latencies.
- The turn-free arm is analysed by intention to treat (every valid attempt), with the treated attempts' median as a secondary result. A 35% time and 30% usage reduction are hypotheses, not targets met; counters of different providers are not added together.
- Every preregistered attempt is retained, including failed and infrastructure-unavailable ones; no repeat is selected after inspecting results.
- The release pilot (case 0, three repeats of four arms) is feasibility evidence only. Changing the default from advisory needs paired quality and resource criteria fixed in advance, held-out repository and task instances, and comparison with both solo controls and the current advisory arm; any fact loss, missed integration, stale-generation injection or held-back workflow event is a safety result that blocks it.

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
