# Quickstart

agent-hub lets the coding agents on one machine work as peers in one project directory: Claude Code, Codex, Kimi Code, and `local`, a worker the hub runs itself on a model you host. You talk to all of them from the hub console.

## Install

Needs [Bun](https://bun.sh) 1.4.2 or newer and macOS (Linux works without the `local` worker's `bash` and `git` tools, which need the macOS sandbox).

Node alone is not supported. Keep `bun` on PATH even if you install with npm.
The registry package uses the `staix` organization scope. Install from npm:

```bash
bun add -g @staix/agent-hub                 # installs `ahub` (also as `agent-hub`)
ahub setup                                # installs the Claude Code channel plugin from this package, then runs doctor
```

Or use the matching GitHub release:

```bash
bun add -g github:STAIxBWLB/agent-hub#v0.13.0
ahub setup
```

From a clone instead: `git clone`, `bun install`, `bun link`.

`ahub doctor` tells you what is installed, running and configured. Rows you do not need can stay red: the hub works with any subset of the peers.

For managed launchers, two-agent task/review work, approvals, graceful shutdown,
and upgrade or crash recovery, see the [operations guide](operations.md). To
move running projects to a newer release later, run `ahub upgrade` in a
terminal: it reviews the plan with you, applies it and follows it.

## Upgrading to 0.13.0

One version policy now gates the Codex and Kimi fresh reviewers, Jcode, agy and Qwen (#691): `ahub agents` lists each installed CLI with its version and verdict, a version outside the verified ones (or, for Jcode and agy, outside their compatible line) is refused with the trust command, and `ahub agents trust <id> <version>` accepts that exact version on this machine; only the person can run it, and the reviewers' isolation proofs still run. See [agent CLI versions](operations.md#agent-cli-versions). If you use Jcode, run `ahub jcode` once per project: the hub-owned `.jcode/mcp.json` entry no longer names a peer, `ahub status` and `ahub doctor` show the old entry as not ready until it is rewritten, and the hub admits Jcode's hub tools only from an owned launch (#368). Extra Jcode instances, each with its own `jcode_home`, can be declared in `.agenthub/config.local.json` and started with `ahub jcode --as <id>` (#685; see [Jcode operations](operations.md#optional-jcode-peer)). Run `ahub init` once per project to refresh the hub block in `AGENTS.md`: it tells pull-only agents never to poll `hub_inbox` or CI on a timer and to run one heavy job per repository at a time (#681). `ahub usage` (with `limits` and `total`) and the console's Usage panel (`7`) show tokens per peer, task, issue, PR, release, day or model and the quota pause and reset history (#683); `ahub report --dogfood` prints a read-only scorecard (#687). In the console, `r` on a task in review now asks `a` (approve) or `c` (request changes, which needs a note) (#711), and a task's detail shows an overlaps block and, when ripwire 0.6.7 is on the daemon's PATH, its changed symbols, which the review brief lists too (#684). A pull-only peer now drains its queue up to 64 KiB per `hub_inbox` read, a queued delivery can be discarded while its peer is busy, and the person clears one peer's queue with `ahub queue discard --peer <id> --reason <text> --yes` (#713). `ahub sdlc authorize-release <version>` records the person's release approval, and `ahub init --release-guard` installs an optional tag pre-push guard (#481 S6; see [release approval](operations.md#release-approval-and-optional-tag-guard)). Restart Claude sessions so they load the 0.13.0 plugin. Coming from 0.12.44 or older, the notes below apply too.

## Upgrading to 0.12.45

The dashboard is redesigned (#469): from 1024px a top bar and a left sidebar (a row of tabs below that), keys `1`-`7` switch views, `?` lists the keys and `Esc` closes a sheet; a task opens as a side sheet, and the plan, split, releases, delivery evidence and propose forms sit in a Plan sheet opened from the board toolbar. View names, ids and the view cookie are unchanged. A person can load a bundled ACP adapter module declared under `adapter_modules` (a `path` and its `sha256`) in untracked `.agenthub/config.local.json`: only the daemon imports it, at startup, so a changed declaration needs a restart; Settings and hub tools cannot write it, and a declaration in the shared `.agenthub/config.json` is ignored. A project that declares modules can be upgraded or recovered only between releases that advertise `external_adapter_modules`. See [Adding an AI tool](adding-an-ai-tool.md#5-external-adapter-modules-451-a4) (#451). `hub_review` and `ahub review ... --findings '<json>'` take structured findings, `max_nits` in `.agenthub/sdlc.toml` caps the nits per report (default 5), and in enforce an open Important finding refuses approval (#481 S3). Plans take optional `proof` and `risks`. In enforce, approval also needs every changed PR file covered by a literal `plan.paths` entry; otherwise amend the plan through `hub_task_accept` and call done again, or the person runs `ahub sdlc accept-departure <task> <head> <reason...>`, which lapses when the hub restarts (#481 S2). An unresolved review thread now settles only by resolution or a later reply from a GitHub user; any other author kind counts as a pending bot comment (#481). `ahub roster remove <peer>` also deletes the roster key of an instance no longer declared (#225). When `ahub kimi` refuses a `kimi_cmd` with no TUI form, it now says the value is the running hub's, retained until `ahub settings reload` (#654). A Claude session no longer gets `hub_inbox` advice while a delivery hold refuses its pulls (#221). A same-size rewrite of a large file within one filesystem timestamp tick is now told apart by its bytes (#428). Restart Claude sessions so they load the 0.12.45 plugin. Coming from 0.12.43 or older, the notes below apply too.

## Upgrading to 0.12.44

Run `ahub init` once per project to refresh the hub block in `AGENTS.md`: it tells agents in the agy TUI not to report the hub missing when no `hub_*` tool is listed on the first turn (#607). agy no longer shows Claude's context reading or Claude's transcript usage as its own (#624). When the hub itself starts Kimi or Qwen headless, it also opens `ahub watch <peer>` through its terminal provider; with no provider, or a failing one, the start still succeeds and reports the command to run (#286). When an `implement` or `bulk_edit` owner completes two turns in a row with no recorded writes or task-tool effects, the planner gets a notice, and a done report with no writes since acceptance says so in the review request; set `task_sweep.no_writes_turns` to change the count, or 0 to turn it off (#498). A declared agy extra instance is refused when the config loads, and Qwen's context occupancy shows unknown until a native source is verified (#625). A standard ACP agent can now be declared as a config-only adapter (`adapters.<kind>` in untracked `.agenthub/config.local.json`); restart the hub, then run `ahub roster add <kind>` and `ahub <kind>` (see the operations guide, #451). A project that declares adapters can be upgraded or restarted only to a release that advertises `configured_acp`. A `peers.<id>` block now accepts only `start_mode`: any other field stops the config from loading at hub start, where 0.12.43 ignored it at startup. Restart Claude sessions so they load the 0.12.44 plugin. Coming from 0.12.42 or older, the notes below apply too.

## Upgrading to 0.12.43

A busy hub no longer stalls when the checkout's HEAD moves under open turns: snapshot Git work in one burst shares a 250 ms budget, and incoming checkouts, merges and fast-forwards are told apart from a peer's own commits through the HEAD reflog, so they no longer raise false concurrent-edit warnings (#576). `ahub task assign` and `hub_task_assign` now refuse with the reason when the named peer cannot take the task (#601). `ahub completion zsh|bash|fish` prints a shell completion script (#603). The console's Peers tab shows each peer's planner WIP, and `w` edits its limit (#532). agy native file reads are recorded as peer facts on 1.4.2 and 1.4.3 (#555); 1.4.3 stays unverified, and in its TUI the hub tools appear from the second turn (#267, #607). Coming from 0.12.41 or older, the notes below apply too.

## Upgrading to 0.12.42

0.12.42 lets `ahub agy` start again after the Antigravity CLI updated itself to 1.4.3: the launcher accepts the 1.4.x line, launching 1.4.2 (the verified version) silently and another 1.4.x patch with a warning (#589). The rest of the release is contributor tooling (#591, #593, #595). Coming from 0.12.40 or older, the notes below apply too.

## Upgrading to 0.12.41

0.12.41 fixes one 0.12.40 regression: `ahub codex` in a recorded Orca terminal stopped at `invalid remote address`, because the launcher put the terminal launch id into the `--remote` URL, which Codex accepts only as `ws://host:port`. The id now travels as the upgrade's bearer token (#586). Coming from 0.12.39 or older, the 0.12.40 notes below apply too.

## Upgrading to 0.12.40

Restart Claude sessions after upgrading: each keeps the plugin server it started with until restarted, so a restart loads the current plugin. That plugin asks Claude Code to list the hub tools again when a hub reconnect changes them (#490), and one from an older `ahub claude` launch is refused and stops reconnecting instead of reclaiming the peer (#551).

`ahub jcode` opens its TUI again; on 0.12.39 it stopped after the first hub turn (#564). A busy Jcode now takes an `important` message into its running turn (#572), and `ahub doctor` lists the extra MCP servers the hub-owned Jcode loads from its config files. See [Jcode operations](operations.md#optional-jcode-peer).

The Switchyard sidecar is retired (#553). An existing `routing.toml` keeps working: its `[targets]` and `[routes]` tables are ignored and reported as retired settings, and a route without the `hub/` prefix (such as `sy/coding`) uses the fixed model with one warning. Migrate with the table in [in-process model routes](operations.md#in-process-model-routes); the hub never rewrites the file.

Run `ahub init` once per project to refresh the hub block in `AGENTS.md`: it adds the line that tells agents to report a pushed PR with `hub_task_done` and end the turn instead of waiting for CI (#572). Finishing a task now also says when the project root checkout is on a branch other than its default.

`hub_task_decline` takes `capacity: true` for "no room right now", which does not exclude the owner for good (#531). Task overlap compares only tasks in the same repository; set `refs.repo` on `hub_task_propose` or `hub_task_accept` for work in another repository (#476). Pi and the local worker report a reply stopped by the hop cap as not delivered (#550).

Live-test delegated CLI commands and terminal-recovery launch records need the upgraded daemon (`cli_audit_delegated`, `terminal_owner`): against an older running hub the first refuses with an upgrade remedy and the second leaves the launch unrecorded, so upgrade running hubs with `ahub upgrade` (#410, #482).

Upgrading from 0.12.38 or earlier, the 0.12.39 notes below also apply.

## Upgrading to 0.12.39

`ahub jcode` now opens Jcode's native TUI on the hub-owned ACP session by default (#464). The TUI opens after Jcode's first hub turn saves the session; until then the launcher prints one waiting line, and Ctrl-C ends only the wait. Hub-made starts (the dashboard's Start control, the conductor's `hub_peer_start`) follow the start mode too, so they open a terminal for Jcode through a terminal provider. To keep the old headless default, run `ahub settings set peers.jcode.start_mode headless`, or pass `--mode headless`. See [Jcode operations](operations.md#optional-jcode-peer).

Upgrading from 0.12.37 or earlier, the 0.12.38 notes below also apply.

The 0.12.38 plugin reports a reply stopped by the hop cap as not delivered instead of as sent (#546); the restart above loads it.

Antigravity (`agy`) can join as an optional pull-only implementer (#485). It is off roster by default: install the Antigravity CLI 1.4.x (1.4.2 verified; other 1.4.x patches launch with a warning; on 1.4.3 the hub tools appear from the second TUI turn), run `ahub roster add agy`, then run `ahub agy` in a terminal. Its native permissions are unmanaged and it has no hub sandbox. See [Antigravity operations](operations.md#optional-antigravity-agy-peer).

Reviews can rotate across fresh Claude, Codex and Kimi reviewer sessions (#519, #533). Declare headless reviewer-only instances in `.agenthub/config.local.json`; Codex and Kimi join only with `review_mode: "fresh"`. Codex also needs a compat-admitted Codex (receipt-verified 0.146.0 and 0.163.0; select it with `codex_bin` when needed), and Kimi needs a compat-admitted Kimi Code on PATH (receipt-verified 2.2.0 and 2.3.0), signed in with its own OAuth login. Run `ahub agents` for the current version policy; every fresh reviewer still needs a passing runtime preparation. The [2.3.0 receipt](verification/2026-10-22-kimi-qwen-compat.md) is model-free and does not establish real login or model readiness. A headless reviewer instance without `review_mode` keeps its native behavior and stays out of the pool. agy is not a reviewer: naming it in `review.pool` shows an unavailable skip in `ahub route explain`, never a review. Once a train is active or frozen, or `review.pool` is set or fresh reviewer instances are declared, `ahub upgrade` refuses a target release without that support, so an older release cannot take the project over. See [fresh reviewer pool](operations.md#fresh-reviewer-pool-519).

A guarded config edit that the hub keeps at its running value now shows as `config retained: <keys>; run ahub settings reload` in status, the console and the dashboard's Settings, and starting a peer whose launch keys are retained says it uses the running value (#542). See [settings](operations.md#settings-from-the-dashboard-and-the-terminal).

Upgrading from 0.12.36 or earlier, the 0.12.37 notes below also apply.

The restarted Claude planner gets the release-train tools (`hub_release_new`, `hub_release_assign`, `hub_release_configure`, `hub_release_cut`, `hub_release_report`); the person uses `ahub sdlc train report|configure|cut` (#481 S11). A due date asks for a cut review and never clears unfinished work; a cut freezes scope and publishes nothing. See [release scheduling](operations.md#planner-release-scheduling).

Jcode must be 0.98.0 or later, below 1.0.0; 0.94.0 is no longer accepted, so `ahub doctor` fails its Jcode row for an older install and the peer does not start (#529). Every owned jcode process runs with `JCODE_NO_TELEMETRY=1`.

Since 0.12.37 the hub pins `@staix/agent-mem` 0.4.0 and opens a split memory home through its shards (#534). Before anyone runs `amem migrate --shards` on a memory home, every hub using that home must run 0.12.37 or later: an older hub does not see the split and keeps writing the old layout. `ahub memory profile-check` is split-aware and compares each hub with its own project's shard (#536). See [memory profiles and rollout](memory.md#selected-memory-profile).

From 0.12.30 or earlier, existing Jcode project MCP entries need one refresh before conductor or dashboard starts. Once per project, the person runs:

```bash
ahub jcode --mode headless
ahub init
```

The first command starts Jcode and rewrites only the hub-owned `agent-hub-jcode` entry in `.jcode/mcp.json`, adding its delivery-only marker. Foreign or overriding entries refuse instead of being overwritten. `ahub init` keeps an untracked machine-path file out of git; review a tracked file deliberately. Daemon readiness checks never rewrite this entry. See [Jcode operations](operations.md#optional-jcode-peer).

Task owners running as Pi or `local` need the isolated test capability for non-PII `implement`, `test` and `bulk_edit` work. A person sets `checks.runner` to `"container"` in untracked `.agenthub/config.local.json`; the Apple container service and pinned image must also be available. Issue-backed owners additionally need spec access. Manual messages remain available, and PII work retains its local-only routing. See [bounded check requirements](security.md#bounded-task-specs-and-isolated-checks-418) before enabling the runner.

## First session

In your project directory, one terminal each:

```bash
ahub init          # .agenthub/config.json, .agenthub/routing.toml, the marker block in AGENTS.md
ahub up            # starts the daemon and opens the operator console in a terminal
ahub console       # use in another terminal if up used --no-console; Tab opens panels
ahub kimi          # Kimi in its own pull-only TUI; --mode headless for the hub-driven peer
ahub codex         # Codex TUI, attached through the hub
ahub claude        # Claude Code with the hub channel
```

Then talk:

```bash
ahub say "Each of you: reply with your name."      # broadcast
ahub say @kimi "run the tests and report"          # one peer
```

## The local worker

`local` needs an OpenAI-compatible gateway. Put yours in `.agenthub/config.local.json`
(machine-local, kept out of git by `ahub init`):

```json
{ "omniroute": { "urls": ["http://your-gateway:20128/v1"], "api_key_file": "/path/to/key" } }
```

or set `OMNIROUTE_API_KEY`. The `.agenthub/routing.toml` that `ahub init` writes asks the gateway for the model aliases `fast` and `coding` (the in-process `hub/stage` route, with `[local] fixed_model` as its fallback); serve those aliases or name yours there, and `ahub doctor` lists any alias the gateway does not serve. Then `ahub local`. It works only inside the project, asks before it writes or runs anything (`ahub permit <id> allow`) unless you chose a permission mode for it (`ahub permission`), and everything it executes is sandboxed. Keep `ahub console` open while it works: a request nobody answers expires, and after two in a row its turn ends.

## Commands of a working day

| Command | What for |
| --- | --- |
| `ahub say [@peer] <text>` | talk; start with `[STATUS]` to let it batch, `[FYI]` for the record only |
| `ahub task propose [--class <c>] <title>` | put work on the board; the hub picks an owner and a reviewer, and the class if you name none |
| `ahub board` | who has what; `ahub task show <id>` for one task |
| `ahub task cancel <id> --reason <text>` | close obsolete work without approving it or stopping a native turn |
| `ahub settings set planner <peer>` | pin the planner; status reports whether it came from settings, roles or the automatic choice |
| `ahub settings reload` | apply edited config files without a restart; guarded values wait for your `y` in this terminal, and restart-only keys stay pending |
| `ahub status` | peers, queues, pauses; `ahub budget` for quota windows |
| `ahub usage [--by peer\|task\|issue\|pr\|release\|day\|model]` | tokens per group, each number with its source; `ahub usage limits` for pauses and resets |
| `ahub agents` | which installed agent CLI versions the hub accepts; `ahub agents trust <id> <version>` accepts an untested one on this machine |
| `ahub memory profile-check` | a person's read-only check of running memory bindings in the current registry |
| `ahub ask <question>` | what the board, shared memory and the log say, with the ids the answer rests on |
| `ahub stop <peer>` | stop one headless peer (Kimi, headless Pi, `local`); the hub and the other peers keep running |
| `ahub kill` | stop the daemon and everything it started |

More: `ahub help`. How it is built and why: [`docs/specs/2026-09-19-agent-hub-design.md`](specs/2026-09-19-agent-hub-design.md). What it protects and what it does not: [`docs/security.md`](security.md).

## Shared memory

The hub exact-pins the first-party `@staix/agent-mem` 0.4.0 core. Existing shared-v1 memory remains the default; upgrading does not migrate it. Managed agents use screened `hub_memory_search`, `hub_memory_show` and `hub_memory_graph` tools, or propose a correction with `hub_memory_correct`; only a person accepts candidates through the supported `amem review` path. Generation candidate acceptance is still refused.

Before any real generation migration, upgrade every hub sharing that memory home to 0.12.30 or later and check its authenticated binding with `ahub memory profile-check` in each custom registry. Ready bindings prove compatibility, not an atomic live cutover: quiesce consumers and close their handles before migrating, then reopen through the supported session-preserving lifecycle. Invalid or changed profiles disable native memory without falling back to legacy writes; the bus and board continue. See [memory operations](operations.md#hub-memory) for the remaining rollout gates.

## Browser dashboard

After `ahub up`, run `ahub ui` to open the local dashboard. It refreshes the
conversation stream, peer queues, task board, budget windows, approvals and
benchmark runs every second. No build step, web server command or browser
extension is needed.

Use the page to pause/resume a peer, send a console message, propose/assign tasks,
and allow/deny agent permission requests. Local-worker and Pi requests show no tool
contents: inspect them with `ahub tail`, then use `ahub permit <id> <option>` to
allow. They can be denied on the page. PII task details remain available only via
`ahub task show <id>` in the terminal. The page also starts a peer in its start
mode (a TUI opens in a terminal when the hub has a terminal provider) and shows
the settings with a Reload configuration button; raising one needs `ahub ui --settings`
or `ahub settings` in a terminal, and guarded values from an edited file need
`ahub settings reload` there. See the operations guide, "Settings from the dashboard and the
terminal" and "Start modes".

`ahub ui --no-open` prints a one-time link instead of launching a browser. Open it
within 60 seconds. A session expires after one hour; run `ahub ui` again. Restarting
the daemon invalidates all links and sessions. The UI listener is started only on
request, binds loopback and stops with the daemon. Remote access is not supported.

The stream retains the latest 200 events since the daemon started; it does not
load historical logs. An unopened dashboard has no listener. A paused budget
window cannot be overridden on the page; the CLI's `ahub budget resume <peer>`
remains the explicit override.


## Concurrent project development (0.4.0)

Initialize and start each repository/worktree separately, or use the global
`--project <path|id>` prefix. `ahub projects` lists registered roots and live
status; `ahub status --all` includes peer/task summaries. Within a subdirectory,
commands use the nearest project inside that Git working-tree boundary.

Open `ahub ui --all` from any directory to manage all registered hubs. Use Start
to launch an initialized project, Use to view a running project, and Stop to stop
the selected hub. Stop confirmation names its root. Without a terminal provider,
agent launch is still `ahub --project <path> claude` or `ahub --project <path> codex`
in a terminal.

The manager is independent: `ahub ui --all --stop` closes its browser sessions
without stopping project hubs. One-time links and session expiry work the same
way as the project-local dashboard. For headless environments use `--no-open`.

Project data is retained after stopping and after `ahub projects remove <id>`.
To use a custom runtime directory initially, set both `AGENTHUB_PROJECT_DIR` to
the canonical project root and `AGENTHUB_STATE_DIR` to the desired directory;
subsequent explicit project selection reads the registered location.

For dashboard-started model workers, put gateway URLs and credential-file
references in that project's config. The manager never copies another project's
gateway override or unattended setting. Native memory and provider accounts keep
their existing sharing rules; the dashboard marks shared native memory aliases.
