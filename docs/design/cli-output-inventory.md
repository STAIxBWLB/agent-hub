# CLI output inventory

Snapshot recorded 2026-11-25 for #1654 T1.

Generated from the built-in dispatch table, adapter entries and HELP. Width is measured in terminal cells on color-off help at 80 columns.
Overview summaries are recorded verbatim for the T2 grammar pass. Help-only entries include global forms.

Overview width: 79 cells. Dispatch entries: 90. Help command words: 92.

| Command | Dispatch | Help width | Overview summary (cells) | Example | Flags | Observed help deviations |
| --- | --- | ---: | --- | --- | --- | --- |
| --live-test | Help only | 76 | Projects / user-authorized console delegation (person only) (48) | Yes | --project | Repeated forms |
| --project | Help only | 44 | Projects / run a command against another project (37) | Yes | - | Repeated forms |
| --version | main.ts | 40 | Projects / print the installed version (27) | Yes | --version | Repeated forms |
| agents | main.ts | 79 | Daemon and runtime / show each agent CLI's version and verdict (41) | Yes | --json --revoke | Repeated forms |
| agy | adapter | 80 | Agents / start optional Antigravity CLI in this terminal (47) | Yes | --print-command --dry-run | Repeated forms |
| answer | main.ts | 80 | Messages and approvals / list and answer open hub_ask questions (38) | Yes | --other --instructed --json --color | Repeated forms |
| ask | main.ts | 79 | Tasks and review / answer from the board, memory and the log (41) | Yes | --remember | Repeated forms |
| autonomy | main.ts | 80 | Messages and approvals / apply the autonomy preset (25) | Yes | --all-projects --yes --json | Repeated forms |
| backlog | main.ts | 80 | Daemon and runtime / return accepted untouched work to the backlog (45) | Yes | --reserved --unreserve --json --color --full | Repeated forms |
| bench | main.ts | 80 | History and reports / run a benchmark suite against attached peers (44) | Yes | --arm --repeat --tasks --addon --memory --json --suite --mixed --format | Repeated forms |
| board | main.ts | 80 | Tasks and review / show the task board, import open issues (39) | Yes | --label --milestone --repo --ready --columns --release --release-id --handoffs --json --full --color | Repeated forms |
| broker | main.ts | 80 | Tasks and review / run the ciphertext relay for rooms (34) | Yes | --hostname --port --public-url --owner --state-dir --yes | Repeated forms |
| budget | main.ts | 80 | Budget / quota windows per peer and why one is paused (44) | Yes | --json --full --color --resets-in --window --reason | Repeated forms |
| capabilities | main.ts | 80 | Tasks and review / list the skills each attached peer offers (41) | Yes | --json --color | Repeated forms |
| check-path | main.ts | 76 | History and reports / other owners' open tasks that claim a file (42) | Yes | --peer --hook | Repeated forms |
| claude | adapter | 73 | Agents / launch Claude Code with the hub channel (39) | Yes | --print-command --unattended --as | Repeated forms |
| codex | adapter | 73 | Agents / start the Codex adapter and attach the TUI (42) | Yes | --print-command --unattended --as | Repeated forms |
| completion | main.ts | 78 | Projects / print a shell completion script (31) | Yes | - | Repeated forms |
| console | main.ts | 79 | Daemon and runtime / open the human console (22) | Yes | --panels --color --no-pet | Repeated forms |
| daemon | main.ts | 74 | Daemon and runtime / internal: the detached hub process (34) | No | --unattended | Internal, Repeated forms |
| deliverables | main.ts | 80 | Tasks and review / what each task delivered and a reviewer approved (48) | Yes | --task --approved --check --json --color | Repeated forms |
| doctor | main.ts | 80 | Daemon and runtime / check tools, daemon, plugin, models and memory (46) | Yes | --json --full --ascii --color --stale-anchors --orphans --kill | Repeated forms |
| down | main.ts | 73 | Daemon and runtime / stop this project's hub (same as kill) (38) | Yes | - | Repeated forms |
| export | main.ts | 75 | History and reports / events as JSON lines (20) | Yes | --since | Repeated forms |
| facts | main.ts | 79 | Hooks / Claude hook for turn-free facts (31) | No | --hook | Internal, Repeated forms |
| goal | main.ts | 80 | History and reports / long-term tasks and who holds them (34) | Yes | --all --json --milestone --depends --shared --force | Repeated forms |
| guidance | main.ts | 80 | History and reports / guidance declarations and the probe lifecycle (45) | Yes | --file --json --id --revision --variant --task --task-created --cursor | Repeated forms |
| help | main.ts | 57 | Projects / this overview, or one command's usage (37) | Yes | --ascii | Repeated forms |
| init | main.ts | 80 | Projects / write .agenthub/config.json and the AGENTS.md block (51) | Yes | --profile --agents --sdlc --required-checks --coordination --memory --no-memory --research --no-research --snapshots --no-snapshots --pi --no-pi --specs --no-specs --spec-review --conductor --planner --reviewer --track-config --no-track-config --no-jcode-home --autonomy --shadow --release-guard --yes --dry-run --json | Repeated forms |
| instructed | main.ts | 78 | Projects / run a confirmed exact or intent instruction (43) | Yes | - | Repeated forms |
| instruction-hook | main.ts | 76 | Projects / internal Claude prompt and Stop hook (36) | No | - | Repeated forms |
| intake | main.ts | 80 | Tasks and review / turn a plain request into a draft backlog card (46) | Yes | --source --json --color | Repeated forms |
| jcode | adapter | 80 | Agents / start optional Jcode, in its TUI or headless (44) | Yes | --mode --model --provider-profile --session-id --print-command --as | Repeated forms |
| kill | main.ts | 25 | Daemon and runtime / stop this project's hub (23) | Yes | - | Repeated forms |
| kimi | adapter | 77 | Agents / start Kimi in its own TUI, or headless over ACP (47) | Yes | --print-command --mode --model --as | Repeated forms |
| learn | main.ts | 79 | Tasks and review / review recurring-criterion candidates (37) | Yes | --all --accepted --json --color | Repeated forms |
| lineage | main.ts | 78 | History and reports / execution metadata and evidence strengths (41) | Yes | --task --attempt --root --task-scope --task-created --cursor --nodes --edges --bytes --json --revision --ref --from | Repeated forms, Bracket wraps |
| local | adapter | 73 | Agents / start the hub-native worker on self-hosted models (49) | Yes | --route --model --as | Repeated forms |
| logs | main.ts | 77 | Daemon and runtime / show the hub log (16) | Yes | -f | Repeated forms |
| manager | main.ts | 67 | Dashboard / internal: the dashboard manager process (39) | No | - | Internal, Repeated forms |
| memory | main.ts | 80 | History and reports / the hub's own project memory (28) | Yes | --tier --kind --peer --machine --since --limit --json --ungrouped --hops --history --as-of --remote --label --db --restart --apply --days | Repeated forms |
| model | main.ts | 80 | Messages and approvals / select or inspect runtime models (32) | Yes | --json | Repeated forms |
| models | main.ts | 76 | Agents / inspect local model state (25) | Yes | --json --color | Repeated forms |
| pause | main.ts | 54 | Messages and approvals / hold or release a peer's deliveries (35) | Yes | - | Repeated forms |
| peer | main.ts | 77 | Agents / hand the attached session to a standby (38) | Yes | --json --color | Repeated forms |
| permission | main.ts | 75 | Messages and approvals / inspect or set a peer's permission mode (39) | Yes | --yes | Repeated forms |
| permit | main.ts | 60 | Messages and approvals / answer a permission request (27) | Yes | - | Repeated forms |
| pet | main.ts | 78 | Daemon and runtime / read attention without connecting (33) | Yes | --short --window --close --palette | Repeated forms |
| pi | adapter | 80 | Agents / start Pi in a terminal, or headless (35) | Yes | --print-command --mode --headless --backend --model --session-id --session-file --replace-session --as | Repeated forms |
| projects | main.ts | 74 | Projects / list registered projects and live status (40) | Yes | --json --full --color --state --confirm | Repeated forms |
| queue | main.ts | 80 | Messages and approvals / inspect and resolve durable deliveries (38) | Yes | --peer --all --json --full --color --action --reason --revision --state --yes | Repeated forms |
| qwen | adapter | 80 | Agents / start optional Qwen Code, headless or in its TUI (48) | Yes | --mode --model --session-id --print-command --as | Repeated forms |
| recovery | main.ts | 80 | Daemon and runtime / inspect, resume or abort a held operation (41) | Yes | --json --color --fresh-session --reason --stop-and-archive | Repeated forms |
| recovery-run | main.ts | 71 | Daemon and runtime / internal: a detached recovery runner (36) | No | - | Internal, Repeated forms |
| release | main.ts | 80 | Tasks and review / plan and ship releases (22) | Yes | --json --color | Repeated forms |
| remember | main.ts | 44 | Tasks and review / save a note to shared memory (28) | Yes | - | Repeated forms |
| report | main.ts | 79 | History and reports / turns, tokens, messages and task events (39) | Yes | --since --by --json --color --dogfood | Repeated forms |
| research | main.ts | 80 | History and reports / success and rework rates per approved task (42) | Yes | --since --all --json --format --dataset | Repeated forms |
| reset | main.ts | 78 | Daemon and runtime / discard queued deliveries and clear holds (41) | Yes | --all --yes | Repeated forms |
| restart | main.ts | 80 | Daemon and runtime / recover this project's runtime (30) | Yes | --dry-run --yes --json --verbose --color | Repeated forms |
| results | main.ts | 80 | Messages and approvals / list what your runs left behind (31) | Yes | --unread --read --read-all --unread-last --json --color | Repeated forms |
| resume | main.ts | 54 | Messages and approvals / hold or release a peer's deliveries (35) | Yes | - | Repeated forms |
| review | main.ts | 78 | Tasks and review / give a review verdict on a task (31) | Yes | --unmet --head --findings --security-pass | Repeated forms |
| roadmap | main.ts | 80 | Tasks and review / milestones and their computed progress (38) | Yes | --json --title --outcome --horizon --order --target --parent --revision --repo --list --accept --publish --apply --confirm --write --issue | Repeated forms |
| role | main.ts | 78 | Agents / read catalog guidance for a role (32) | Yes | --group | Repeated forms |
| roles | main.ts | 78 | Messages and approvals / each peer's flow roles, planner and reviewers (45) | Yes | --json --color | Repeated forms |
| room | main.ts | 80 | Tasks and review / encrypted rooms between hubs (person only) (42) | Yes | --broker --label --accept --name --roster --confirm --frame --action --json | Repeated forms |
| roster | main.ts | 80 | Messages and approvals / every known peer and its participation (38) | Yes | --json --color --yes --now | Repeated forms |
| route | main.ts | 74 | Tasks and review / why a task went where it did (28) | Yes | --class | Repeated forms |
| say | main.ts | 79 | Messages and approvals / send a message as the console user (34) | Yes | - | Repeated forms |
| schedule | main.ts | 80 | Tasks and review / list and run machine-local schedules (36) | Yes | --json --color | Repeated forms |
| sdlc | main.ts | 80 | Daemon and runtime / read lifecycle gates and the next action (40) | Yes | --json --color --focus --profile --since --pr --dry-run --mode --required-checks --issue --repo --review --reviewers --ci | Repeated forms |
| settings | main.ts | 80 | Messages and approvals / list, read and change settings (30) | Yes | --json --yes --preview --now --reason | Repeated forms |
| setup | main.ts | 80 | Projects / install the plugin and hooks, choose default agents (51) | Yes | --yes --agents --research --no-research --undo | Repeated forms |
| smoke | main.ts | 80 | Tasks and review / live smoke test in a temporary project (38) | Yes | --project-id --receipt --timeout-ms --json | Repeated forms |
| source | main.ts | 79 | Tasks and review / register inputs as content-hashed sources (41) | Yes | --json --color | Repeated forms |
| specs | main.ts | 80 | Projects / read design specs and check their freshness (43) | Yes | --json --require-fresh --base --yes | Repeated forms |
| status | main.ts | 80 | Daemon and runtime / is the hub OK, and what to do next (34) | Yes | --json --full --verbose --ascii --color --all | Repeated forms |
| stop | main.ts | 80 | Agents / stop a hub-owned headless peer (30) | Yes | - | Repeated forms |
| study | main.ts | 80 | Tasks and review / research campaign contracts (27) | Yes | --reason --json --color --revision --task --after --campaign --attempt --events-after --plan --baseline --variant | Repeated forms |
| tail | main.ts | 57 | Messages and approvals / live stream of messages and states (34) | Yes | - | Repeated forms |
| task | main.ts | 80 | Tasks and review / put tasks on the board and move them along (42) | Yes | --class --owner --path --after --urgent --needs-network --needs-worktree --backlog --detail --list --sync --project --issue --task --duplicate-ok --key --json --color --full --role --revision --model --model-said --manifest --disposition --reason --superseded-by --created | Repeated forms |
| title | main.ts | 77 | Messages and approvals / rename a Pi or local-worker session (35) | Yes | - | Repeated forms |
| turns | main.ts | 74 | History and reports / recent turns and the files each changed (39) | Yes | --limit --json --color | Repeated forms |
| ui | main.ts | 78 | Dashboard / open the local dashboard (24) | Yes | --no-open --settings --all --stop | Repeated forms |
| undo | main.ts | 79 | History and reports / put back the files a turn changed (33) | Yes | --yes --context | Repeated forms |
| up | main.ts | 79 | Daemon and runtime / start the daemon and this project's default agents (50) | Yes | --unattended --no-console --no-agents | Repeated forms |
| upgrade | main.ts | 79 | Daemon and runtime / review and upgrade this project (31) | Yes | --project --all-stopped --to --dry-run --yes --json --verbose --color | Repeated forms |
| usage | main.ts | 79 | History and reports / tokens per group from the roll-up (33) | Yes | --since --by --json --color --peer --limit | Repeated forms |
| version | main.ts | 40 | Projects / print the installed version (27) | Yes | --version | Repeated forms |
| watch | main.ts | 77 | Messages and approvals / watch a headless ACP peer's activity (36) | Yes | --no-thoughts --color | Repeated forms |
| worktrees | main.ts | 78 | Projects / list worktrees, preview and confirm cleanup (43) | Yes | --json --confirm | Repeated forms |

## Direct output call sites

Counts come from each handler body in src/cli/main.ts. The adapter entries share one handler. These counts include machine and diagnostic branches.
A delegated call needs its own renderer or a fixture before the human-view width can be measured.

| Command | Direct output calls |
| --- | --- |
| upgrade | Delegated / no direct output call |
| restart | Delegated / no direct output call |
| recovery | fail (12), console.error (4), console.log (15), renderOperation (1), renderBlocked (1), renderRecoveryStatus (1), renderSummary (1) |
| recovery-run | fail (1) |
| help | renderHelp (1), fail (1), console.log (1) |
| completion | fail (1), process.stdout.write (1) |
| --version | console.log (1) |
| version | console.log (1) |
| projects | fail (4), console.log (2) |
| ui | fail (6), console.log (4), console.error (1) |
| manager | Delegated / no direct output call |
| setup | fail (7), console.log (9) |
| init | fail (5), console.log (11), console.error (6) |
| daemon | console.error (2) |
| console | fail (2) |
| up | console.error (4), console.log (2) |
| claude | Delegated / no direct output call |
| codex | Delegated / no direct output call |
| kimi | Delegated / no direct output call |
| pi | Delegated / no direct output call |
| local | Delegated / no direct output call |
| qwen | Delegated / no direct output call |
| jcode | Delegated / no direct output call |
| agy | Delegated / no direct output call |
| guidance | fail (21), console.log (10), renderGuidanceReceipt (1), renderGuidance (1) |
| lineage | fail (6), console.log (4), renderExecutionLineage (1) |
| model | fail (6), console.log (1), printOutput (1), renderRuntimeModels (1) |
| models | console.log (3), printOutput (1), renderModelsStatus (1), fail (4) |
| say | fail (2), console.log (4) |
| queue | fail (12), console.log (6), printOutput (3), renderQueue (1), console.error (1), renderQueueShow (2) |
| watch | fail (3), console.log (1) |
| tail | console.log (4), renderTailEvent (1) |
| budget | fail (8), console.log (3), printOutput (3), renderBudgetResult (1), renderExecutionBudgetStatus (1), renderBudget (1) |
| backlog | showToolText (1), console.log (5), printOutput (1), renderBacklog (1), fail (7), renderBacklogResult (5) |
| roadmap | fail (2), console.log (3), renderRoadmap (1) |
| release | showToolText (1), fail (3) |
| smoke | fail (6), console.log (2) |
| room | fail (2) |
| broker | fail (1) |
| source | console.log (2), printOutput (2), renderSourceList (1), fail (4), console.error (1), renderSourceAdd (1) |
| schedule | showToolText (3), renderScheduleList (1), fail (1), renderScheduleRun (1), renderScheduleChange (1) |
| study | fail (2), showToolText (6), renderStudyEvidence (2), renderSynthesisReadiness (1), renderExperiments (1), renderStudyShow (1), renderStudyList (1), renderStudyReceipt (1) |
| capabilities | fail (1), showToolText (1), renderCapabilities (1) |
| learn | fail (2), showToolText (2), renderLearnList (1), renderLearnChange (1) |
| intake | fail (3), showToolText (2), renderIntakeChange (1), renderIntake (1) |
| deliverables | fail (2), console.log (5) |
| board | fail (8), console.log (3), showToolText (1), renderHandoffs (1), console.error (1), printOutput (2), renderBoardColumns (1), renderBoard (1) |
| sdlc | printOutput (2), fail (48), console.log (21), process.stdout.write (2), showToolText (2), renderSdlcMerge (1) |
| task | showToolText (3), fail (15), console.log (7), renderHandoffs (1), renderHandoffReceipt (1), console.error (1) |
| review | fail (5), console.log (2) |
| remember | console.log (1) |
| ask | fail (2), console.log (5) |
| route | fail (1), console.log (1) |
| pause | Delegated / no direct output call |
| resume | Delegated / no direct output call |
| stop | fail (2), console.log (1) |
| peer | fail (7), console.log (2) |
| title | fail (3), console.log (2) |
| permission | fail (3), console.error (1), console.log (3) |
| roster | fail (5), console.log (3), printOutput (4), renderRoster (1) |
| autonomy | console.log (4), fail (1) |
| settings | fail (18), console.log (23), console.error (1) |
| permit | fail (1) |
| answer | fail (3), console.log (8) |
| results | fail (4), console.log (8) |
| pet | fail (4), console.log (2), renderPet (1), process.stdout.write (1) |
| roles | fail (1), console.log (1), printOutput (1), renderRoles (1) |
| status | console.log (3), printOutput (1), renderStatus (1), renderStatusDefault (1), renderPet (1) |
| logs | console.log (3), fail (1) |
| export | fail (1), console.log (2) |
| bench | console.log (7), formatBenchReport (2), formatRuns (2), fail (6), formatCompare (1), process.stdout.write (1) |
| memory | fail (3), console.log (2), formatMemoryProfileCheck (1) |
| goal | fail (2), console.log (1) |
| research | console.log (4), fail (4), process.stdout.write (1), formatAddons (1), formatResearch (1) |
| report | fail (2), console.log (2), formatDogfood (1), printOutput (1), renderReport (1) |
| specs | Delegated / no direct output call |
| worktrees | fail (3), console.log (3), printOutput (3), renderWorktrees (1), renderTidyPreview (1), renderTidyResult (1) |
| usage | fail (6), process.stderr.write (1), console.log (1), printOutput (1), renderLimits (1), renderTotal (1), renderUsage (1) |
| instructed | fail (3), process.stdout.write (1) |
| instruction-hook | Delegated / no direct output call |
| facts | fail (1), console.log (1) |
| check-path | fail (1), console.log (2) |
| turns | console.log (1), printOutput (1), renderTurns (1) |
| undo | fail (12), console.log (8), console.error (1) |
| kill | console.log (2), fail (1) |
| down | Delegated / no direct output call |
| reset | fail (7), console.log (19) |
| role | fail (7), console.log (3) |
| agents | Delegated / no direct output call |
| doctor | fail (2), console.log (3), formatMemoryStaleAnchors (1), printOutput (2), renderOrphanCleanup (1), renderDoctor (1) |

## Inline literal output

Widths for single literal strings emitted directly from CLI handlers. No wrapping is applied by these call sites.
Interpolated and daemon-supplied strings require runtime fixtures. They are counted above but have no width here.

| Command | Text source | Stream | Literal width |
| --- | --- | --- | ---: |
| recovery | src/cli/main.ts:1035 | stdout | 29 |
| recovery | src/cli/main.ts:1068 | stdout | 60 |
| projects | src/cli/main.ts:1160 | stdout | 45 |
| ui | src/cli/main.ts:1176 | stdout | 57 |
| ui | src/cli/main.ts:1191 | stderr | 112 |
| ui | src/cli/main.ts:1196 | stdout | 76 |
| init | src/cli/main.ts:1317 | stderr | 115 |
| models | src/cli/main.ts:1584 | stdout | 11 |
| say | src/cli/main.ts:1608 | stdout | 46 |
| roadmap | src/cli/main.ts:1812 | stdout | 46 |
| deliverables | src/cli/main.ts:2049 | stdout | 70 |
| sdlc | src/cli/main.ts:2154 | stdout | 29 |
| ask | src/cli/main.ts:2465 | stdout | 9 |
| ask | src/cli/main.ts:2468 | stdout | 54 |
| roster | src/cli/main.ts:2585 | stdout | 19 |
| roster | src/cli/main.ts:2592 | stdout | 19 |
| autonomy | src/cli/main.ts:2643 | stdout | 75 |
| settings | src/cli/main.ts:2736 | stdout | 39 |
| settings | src/cli/main.ts:2749 | stdout | 33 |
| settings | src/cli/main.ts:2780 | stdout | 33 |
| answer | src/cli/main.ts:2825 | stdout | 17 |
| bench | src/cli/main.ts:2966 | stdout | 107 |
| usage | src/cli/main.ts:3150 | stderr | 121 |
| undo | src/cli/main.ts:3286 | stdout | 103 |
| undo | src/cli/main.ts:3291 | stdout | 53 |
| kill | src/cli/main.ts:3308 | stdout | 18 |
| kill | src/cli/main.ts:3312 | stdout | 11 |
| reset | src/cli/main.ts:3326 | stdout | 36 |
| reset | src/cli/main.ts:3350 | stdout | 56 |
| reset | src/cli/main.ts:3356 | stdout | 39 |
| reset | src/cli/main.ts:3359 | stdout | 11 |
| reset | src/cli/main.ts:3394 | stdout | 96 |

## Renderer candidates

Source scan for top-level render and format functions. The file shows where the text originates. Layout references are direct, and indirect composition needs manual review.
Fixture widths are color-off at 80 columns. Unmeasured entries need fixtures before T3 or T4 makes a conformance claim.
The separate report-by-task fixture measures 79 cells.

| File and renderer | Text source | Report | Direct layout references | Fixture width or scope |
| --- | --- | --- | --- | --- |
| src/cli/autonomy.ts:renderAutonomyStatus | CLI | - | Inline / indirect | 77 |
| src/cli/capabilities-output.ts:renderCapabilities | CLI | - | blank, grid, heading, pair | 116 |
| src/cli/console-state.ts:renderConsole | CLI | - | paint | Full-screen console |
| src/cli/console-state.ts:renderConsoleLines | CLI | - | table, wrap | Full-screen console |
| src/cli/handoff-output.ts:renderHandoffReceipt | CLI | - | blank, heading, pair | 139 |
| src/cli/handoff-output.ts:renderHandoffs | CLI | - | grid, heading | 110 |
| src/cli/help.ts:renderCommandHelp | CLI | Direct | LayoutReport, wrap | 80 |
| src/cli/help.ts:renderHelp | CLI | - | paint | 79 |
| src/cli/help.ts:renderOverview | CLI | Direct | LayoutReport, blank, paint, wrap | 79 |
| src/cli/intake-output.ts:renderIntake | CLI | - | blank, grid, heading, pair | 79 |
| src/cli/intake-output.ts:renderIntakeChange | CLI | - | grid, heading | 48 |
| src/cli/learn-output.ts:renderLearnList | CLI | - | blank, grid, heading | 53 |
| src/cli/learn-output.ts:renderLearnAccepted | CLI | - | blank, grid, heading | Unmeasured |
| src/cli/learn-output.ts:renderLearnChange | CLI | - | blank, heading, pair | 66 |
| src/cli/output.ts:renderRuntimeModels | CLI | - | Inline / indirect | 0 |
| src/cli/output.ts:renderRoster | CLI | - | Inline / indirect | 0 |
| src/cli/output.ts:renderRoles | CLI | - | Inline / indirect | 75 |
| src/cli/output.ts:renderStatus | CLI | - | Inline / indirect | 60 |
| src/cli/output.ts:renderStatusDefault | CLI | Direct | LayoutReport, heading | 65 |
| src/cli/output.ts:renderBacklog | CLI | - | table | 52 |
| src/cli/output.ts:renderBoard | CLI | - | Inline / indirect | 80 |
| src/cli/output.ts:renderBudget | CLI | - | Inline / indirect | 74 |
| src/cli/output.ts:renderBoardColumns | CLI | - | Inline / indirect | 80 |
| src/cli/output.ts:renderDoctor | CLI | Direct | LayoutReport | 15 |
| src/cli/output.ts:renderProjects | CLI | - | Inline / indirect | 37 |
| src/cli/output.ts:renderQueue | CLI | - | table | 22 |
| src/cli/output.ts:renderTurns | CLI | - | moment | 67 |
| src/cli/output.ts:renderOrphans | CLI | - | Inline / indirect | 68 |
| src/cli/output.ts:renderOrphanCleanup | CLI | - | Inline / indirect | 30 |
| src/cli/output.ts:renderQueueShow | CLI | - | Inline / indirect | 17 |
| src/cli/output.ts:renderModelsStatus | CLI | - | Inline / indirect | 12 |
| src/cli/output.ts:renderExecutionBudgetStatus | CLI | - | Inline / indirect | 16 |
| src/cli/output.ts:renderReport | CLI | Direct | Report, moment | 79 |
| src/cli/output.ts:renderUsage | CLI | - | Inline / indirect | 61 |
| src/cli/output.ts:renderLimits | CLI | - | Inline / indirect | 38 |
| src/cli/output.ts:renderTotal | CLI | - | table | 78 |
| src/cli/pet.ts:renderPet | CLI | - | Inline / indirect | 21 |
| src/cli/roadmap.ts:renderRoadmap | CLI | - | wrap | 23 |
| src/cli/schedule-output.ts:renderScheduleList | CLI | - | blank, grid, heading, moment, pair | 82 |
| src/cli/schedule-output.ts:renderScheduleRun | CLI | - | heading, pair | 27 |
| src/cli/schedule-output.ts:renderScheduleChange | CLI | - | heading, pair | 17 |
| src/cli/sdlc-output.ts:renderSdlcConfiguration | CLI | - | heading, pair | 68 |
| src/cli/sdlc-output.ts:renderSdlcSurvey | CLI | - | heading, pair | 23 |
| src/cli/sdlc-output.ts:renderSdlcQueue | CLI | - | blank, grid, heading, pair | 30 |
| src/cli/sdlc-output.ts:renderSdlcAudit | CLI | - | heading, pair | 51 |
| src/cli/sdlc-output.ts:renderSdlcRelease | CLI | - | blank, grid, heading, moment, pair | 71 |
| src/cli/sdlc-output.ts:renderSdlcMetrics | CLI | - | blank, grid, heading, moment, pair | 80 |
| src/cli/sdlc-output.ts:renderSdlcCosts | CLI | - | blank, grid, heading, wrap | 37 |
| src/cli/sdlc-output.ts:renderAuthorization | CLI | - | blank, heading, moment, pair | 44 |
| src/cli/sdlc-output.ts:renderSdlcMerge | CLI | - | blank, heading, pair | 30 |
| src/cli/settings-edit.ts:renderEditPreview | CLI | - | Inline / indirect | 29 |
| src/cli/source-output.ts:renderSourceAdd | CLI | - | heading, pair | 49 |
| src/cli/source-output.ts:renderSourceList | CLI | - | blank, grid, heading, moment, pair | 62 |
| src/cli/study-output.ts:renderStudyList | CLI | - | blank, grid, heading | 114 |
| src/cli/study-output.ts:renderStudyShow | CLI | - | blank, grid, heading, pair | 31 |
| src/cli/study-output.ts:renderStudyReceipt | CLI | - | blank, grid, heading, pair | 71 |
| src/cli/study-output.ts:renderExperiments | CLI | - | blank, grid, heading, pair | 78 |
| src/cli/study-output.ts:renderStudyEvidence | CLI | - | heading, pair | 77 |
| src/cli/study-output.ts:renderSynthesisReadiness | CLI | - | heading, pair | 101 |
| src/cli/tail-render.ts:renderTailEvent | CLI | - | Inline / indirect | 17 |
| src/cli/task-output.ts:renderTaskShow | CLI | - | Inline / indirect | 52 |
| src/cli/task-output.ts:renderTaskCancel | CLI | - | heading, pair | 52 |
| src/cli/task-output.ts:renderBacklogResult | CLI | - | blank, grid, heading, pair | 52 |
| src/cli/task-output.ts:renderGroom | CLI | - | blank, grid, heading, pair | 50 |
| src/cli/task-output.ts:renderReleaseList | CLI | - | blank | 41 |
| src/cli/task-output.ts:renderReleaseShow | CLI | - | Inline / indirect | 41 |
| src/cli/upgrade-output.ts:renderUpgradePlan | CLI | - | Inline / indirect | 55 |
| src/cli/upgrade-output.ts:renderStoppedPlan | CLI | - | Inline / indirect | 56 |
| src/cli/upgrade-output.ts:renderStoppedResults | CLI | - | Inline / indirect | 60 |
| src/cli/upgrade-output.ts:renderRecoveryStatus | CLI | - | Inline / indirect | 46 |
| src/cli/upgrade-output.ts:renderBudgetResult | CLI | - | Inline / indirect | 27 |
| src/cli/upgrade-presentation.ts:renderStep | CLI | - | Inline / indirect | 50 |
| src/cli/upgrade-presentation.ts:renderPlan | CLI | - | Inline / indirect | 26 |
| src/cli/upgrade-presentation.ts:renderOperation | CLI | - | Inline / indirect | 46 |
| src/cli/upgrade-presentation.ts:renderBlocked | CLI | - | Inline / indirect | 76 |
| src/cli/upgrade-presentation.ts:renderMenu | CLI | - | Inline / indirect | 17 |
| src/cli/upgrade-presentation.ts:renderWait | CLI | - | Inline / indirect | 80 |
| src/cli/upgrade-presentation.ts:renderSummary | CLI | - | Inline / indirect | 75 |
| src/cli/upgrade-restore-state.ts:renderRestoreTransitionTable | CLI | - | table | 320 |
| src/cli/watch.ts:renderActivity | CLI | - | paint, wrap | 31 |
| src/cli/worktrees-output.ts:renderWorktrees | CLI | - | blank, grid, heading, moment | 32 |
| src/cli/worktrees-output.ts:renderTidyPreview | CLI | - | blank, grid, heading, pair | 41 |
| src/cli/worktrees-output.ts:renderTidyResult | CLI | - | grid, heading | 30 |
| src/hub/bench.ts:formatRuns | Hub | - | Inline / indirect | 77 |
| src/hub/bench.ts:formatReport | Hub | - | Inline / indirect | 99 |
| src/hub/bench.ts:formatCompare | Hub | - | Inline / indirect | 99 |
| src/hub/checkpoint-fields.ts:renderCheckpoint | Hub | - | Inline / indirect | 19 |
| src/hub/claude-failure-stage.ts:formatClaudeFailure | Hub | - | Inline / indirect | 51 |
| src/hub/delivery-hints.ts:renderHeldHint | Hub | - | Inline / indirect | 43 |
| src/hub/delivery-public.ts:renderHeldInbox | Hub | - | Inline / indirect | 0 |
| src/hub/dogfood.ts:formatDogfood | Hub | - | Inline / indirect | 43 |
| src/hub/envelope.ts:renderDigest | Hub | - | Inline / indirect | 1483 |
| src/hub/guidance-variants.ts:renderGuidanceVariantV1 | Hub | - | Inline / indirect | Guidance payload for agents |
| src/hub/invocations.ts:renderInvocationResult | Hub | - | Inline / indirect | 109 |
| src/hub/memory-profile-check.ts:formatMemoryProfileCheck | Hub | - | Inline / indirect | 27 |
| src/hub/memory-stale-anchors.ts:formatMemoryStaleAnchors | Hub | - | Inline / indirect | 59 |
| src/hub/report.ts:formatUsage | Hub | - | Inline / indirect | Internal report section, no separate view |
| src/hub/report.ts:formatReport | Hub | - | Inline / indirect | 81 |
| src/hub/report.ts:formatPerson | Hub | - | Inline / indirect | 14 |
| src/hub/report.ts:formatTaskReport | Hub | - | Inline / indirect | 116 |
| src/hub/research.ts:formatResearch | Hub | - | Inline / indirect | 106 |
| src/hub/research.ts:formatAddons | Hub | - | Inline / indirect | 108 |
| src/hub/review-brief.ts:renderFindingAnchor | Hub | - | Inline / indirect | 32 |
| src/hub/review-brief.ts:renderSpecTaskReport | Hub | - | Inline / indirect | 57 |
| src/hub/review-brief.ts:renderCodeSymbols | Hub | - | Inline / indirect | Measured within review brief |
| src/hub/review-brief.ts:renderReviewBrief | Hub | - | Inline / indirect | 160 |
| src/hub/review-comments.ts:renderReviewComment | Hub | - | Inline / indirect | Owner-facing hub delivery |
| src/hub/schedules.ts:formatInZone | Hub | - | Inline / indirect | 16 |
| src/hub/ui.ts:renderDashboard | Hub | - | Inline / indirect | Web dashboard |
