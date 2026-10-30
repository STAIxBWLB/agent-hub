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
bun add -g github:STAIxBWLB/agent-hub#v0.23.0
ahub setup
```

From a clone instead: `git clone`, `bun install`, `bun link`.

`ahub doctor` tells you what is installed, running and configured. Rows you do not need can stay red: the hub works with any subset of the peers.

For managed launchers, two-agent task/review work, approvals, graceful shutdown,
and upgrade or crash recovery, see the [operations guide](operations.md). To
move running projects to a newer release later, run `ahub upgrade` in a
terminal: it reviews the plan with you, applies it and follows it.

## Upgrading to 0.23.0

Nothing changes until you set something. Thirteen more operational numbers became settings in `config.local.json`, each keeping its old value when unset: three `adapter_timing.*` (at the next Kimi, ACP or Jcode launch, #982), four `model_relay.*` and `inference.backoff_min` (at the next daemon restart, #984) and five `console.*` (at the next console launch, #987). Capability sharing is new and opt-in. `ahub capabilities` (person only) lists the skills an attached Kimi 2.3.2, Qwen 0.26.1 or Codex 0.166.0 offers; nothing is offered to other agents until you pin an entry's digest under `invocation.share` in `.agenthub/config.local.json` (#985). Agents then call a shared `read` capability with `hub_invoke`. A `write` or `external` one needs an open task of the caller and your allow-once approval on every call, and one with no class is never invoked (#986, #991; see [invoking a shared capability](operations.md#invoking-a-shared-capability-445-c2c3)). Across a room, only a read capability both persons pinned crosses (#992). `ahub init --profile writing-pack|analysis|ops` applies the new shipped domain packs (#993). The `@staix/agent-mem` pin stays 0.13.0. Upgrade running hubs with `ahub upgrade` (an older hub refuses `hub_invoke`) and restart Claude sessions so they load the 0.23.0 plugin.

## Upgrading to 0.22.0

Nothing changes until you set something. Ten operational numbers became settings: five bus and delivery limits (`bus.*`, #975) and five upgrade-recovery waits (`recovery.*`, #979). Unset, each keeps the value it had. `ahub learn list|accept|reject` (#514b, person only) is your verdict on the recurring-unmet-criterion cards. The macOS PTY bridge no longer hangs under load or outlives its caller (#560). The `@staix/agent-mem` pin stays 0.13.0. Upgrade running hubs with `ahub upgrade` and restart Claude sessions so they load the 0.22.0 plugin.

## Upgrading to 0.21.0

The configured conductor may now run more operational commands from its own shell (#933): `board import`, `intake approve`, `schedule run|pause|resume`, `research backfill`, `bench run`, `source add`, `goal link`, `task unassign`, starting Jcode, and `settings set tasks.escalate_after`; the hub rechecks the role and records each run. Trust, money, attribution and interactive terminals stay the person's: `permission`, `agents trust`, `role assign`, budget changes, `--as-user`, `pet --window`, `watch`, `recovery reattach`, memory changes and every goal change except `link`. Any agent may `task cancel`, `task label` and `task role` a task it owns and list `ahub deliverables` for the tasks it can see. A conductor's `restart --yes`, `upgrade --yes --to <exact-version>` and `recovery resume|abort` need a source-issued continuation bound to that project, and a handoff to a newer release's coordinator stays the person's (#900; see [conductor operations](operations.md#conductor-operations-812-t2-933-900)). `ahub sdlc merge` and the conductor's `ahub doctor --orphans --kill` now print readable output: a script that parses them passes `--json`, which prints what they printed before (#899). `ahub down` stops the hub like `ahub kill`. New and opt-in: `ahub source add|list` (#508), machine-local `schedules` and `folder_triggers` with `ahub schedule` (#512), `ahub intake` draft backlog cards (#511), domain packs with `ahub init --profile <pack>` (#513a), `local.web_fetch` and `local.doc_read` for the on-prem worker (#515), queue backpressure and context headroom admission for new work (#800, #802), and person-only rooms between machines through `ahub broker` and `ahub room` (#446; see [outbound room membership](operations.md#outbound-room-membership-446-x3)). `ahub turns` and `ahub undo` name a dirty git submodule instead of hiding it (#798). A `hub_send` whose `to` is one peer id given as a string now reaches only that peer instead of every peer, and any other malformed `to` is refused before anything is sent (#963). The hub now exact-pins `@staix/agent-mem` 0.13.0, with no storage change for the hub. Upgrade running hubs with `ahub upgrade` and restart Claude sessions so they load the 0.21.0 plugin. Coming from 0.19.0 or older, the notes below apply too.

## Upgrading to 0.20.0

The hub now exact-pins `@staix/agent-mem` 0.11.0. Every `amem` that shares a memory home must run 0.11.0 or later to keep consolidation review receipts, so upgrade a global `amem` CLI too. When `hub_task_done` leaves a review whose exact-head CI is not yet green, the hub watches that PR head once a minute for up to 45 minutes and tells the owner and the reviewer once with a `ci_completed:` task notice; no peer turn waits for CI (#785). The new `tasks.auto_pull` setting is opt-in and off by default, and a committed config cannot turn it on: set it in `.agenthub/config.local.json` or a settings session, and when a peer's planner slot frees the hub pulls the top backlog card explicitly reserved for that peer (#785; see [the planner](operations.md#the-planner-455)). The local worker and Pi sandbox now lets a command add only new loose objects to the shared git object store (#864): `git gc`, `repack`, `fetch` and `maintenance` no longer run inside it, so run them yourself in a terminal. A task's host-observed branch binding no longer turns a running check result into "check finished late" (#880). Upgrade running hubs with `ahub upgrade` and restart Claude sessions so they load the 0.20.0 plugin. Coming from 0.18.0 or older, the notes below apply too.

## Upgrading to 0.19.0

Pi is now a gated CLI (#843): `ahub agents` lists it, 1.4.0 is the verified version, and any other version is refused at every launch path with the exact `ahub agents trust pi <version>` command. If your Pi is not 1.4.0, trust that version (person only) or install 1.4.0 before Pi work resumes. At hub start and once a day the hub reads each gated CLI's installed version without network, tells the planner once per id and version that is not verified, and `ahub status` shows an `agent CLI drift` line until it is (#843). Newly verified: agy 1.4.7, Jcode 0.99.1, headless Qwen 0.26.1, the Kimi fresh reviewer 2.3.2 and the headless Claude implementer 2.1.310. In `ask-when-needed`, a headless Claude implementer now runs proven read-only shell commands and a closed set of task commands (`scripts/check.sh --changed`, `bun run build`, `bun test <test files>`, `git add|commit`, `git push` and `gh pr view|checks|create` on the task's bound branch) through a host-owned wrapper with single-use tickets; check, test and build run in the local worker's sandbox, any other command and any call in an enabled always-ask class still ask, and an older plugin keeps asking (#845; see [additional headless peer instances](operations.md#additional-headless-peer-instances)). It may also name its model with `"model"` on its declaration in untracked `config.local.json`, applied at the next hub daemon restart (#844). The fresh Codex and Kimi reviewers now declare review scope `code`: they review code only, a `changes_requested` with no open structured finding is recorded as evidence-only and does not count toward escalation, `ahub status` shows `review scope` on each reviewer row, and `"review_scope"` on the instance in `config.local.json` overrides it (#852). Planners get one `Planner work ready:` notice when a write frees WIP capacity or makes backlog work ready; nothing is pulled for them (#785). The remote check runner installs dependencies once per lockfile key into a read-only volume and refuses a commit whose `package.json` declares an install lifecycle script (#793). A conductor operation whose hub connection or authorization handshake is unavailable now says so instead of reporting a role refusal (#812). The hub sandbox also protects a linked worktree's submodule git dirs and `config.worktree`, and refuses writes under a modules root outside a discovered git dir (task 518, #865). A Qwen TUI background-task notice no longer ends a hub turn as uncertain (task 517). `@staix/agent-mem` is pinned at 0.10.0. Upgrade running hubs with `ahub upgrade` and restart Claude sessions so they load the 0.19.0 plugin. Coming from 0.17.0 or older, the notes below apply too.

## Upgrading to 0.18.0

The `ahub sdlc` read commands (`status`, `explain`, `queue`, `release`, `metrics`, `costs`, `authorize-release`) now print readable output by default, no longer a JSON document (#814). A script that parses their output must pass `--json`: it prints exactly what the command printed before. `sdlc export` stays JSON. `restart` and `upgrade` off a terminal (a pipe or `--dry-run`), `recovery status` and its results, `models setup|start`, `queue resolve` and `budget execution configure|disable` follow (#814): pass `--json` for the old document. `task show|cancel`, `backlog groom|return|plan|pin|split|undo|pull-ready` and `release list|show|new|plan|activate|freeze|ship|drop` follow (#814): pass `--json` for the hub tool's text. More commands follow in later releases.

Agents can now run the read-only `ahub` forms themselves (`doctor`, `projects`, `models status`, `recovery status`, `queue list`, `roster`, `settings` reads, `sdlc status|explain|queue|release`, `release show` and the `--dry-run` previews of `upgrade` and `restart`), and the configured conductor can run `stop`, `queue show|resolve|discard`, `task cancel`, `roster add|remove`, `logs`, `export`, `doctor --orphans --kill` and `settings set` on twelve live keys (#812). Nothing changes for a person's terminal. `sdlc.toml` gains `auto_merge` (`off` by default): set `dry-run` to see what the guarded merge and the one-per-verdict GitHub COMMENT review would do before setting `on` (#786). `review.same_family = "never"` keeps a same-family reviewer from being assigned (#820). In `ask-when-needed`, Pi and the local worker run proven bounded read-only shell commands without asking (#816). The isolated remote Docker check runner is opt-in through `checks.runner = "remote"` in the person's untracked `config.local.json` (#793). `@staix/agent-mem` is pinned at 0.8.0.

## Upgrading to 0.17.0

`ahub qwen --mode tui` runs Qwen Code's own TUI in your terminal, driven by the hub through its dual-output files (#286). It is opt-in: the hub never opens it by itself, `roster.qwen` stays off by default, and headless Qwen works as before. It needs Qwen Code 0.26.1 (a new `qwen-dual` compat entry; the headless entry is not widened), refuses an extra instance (`--as`) and refuses while a headless Qwen runs (`ahub stop qwen` first). It has two limits: a hub deny ends the turn without an answer (the delivery completes, so later messages still reach Qwen), and a stalled turn is never cancelled; the hub reports it and you press Esc in the Qwen terminal. `ahub stop qwen` does not end the TUI, and `ahub upgrade` and recovery do not restore it: end it in its terminal before you upgrade, then run `ahub qwen --mode tui` again, which resumes its session. The `codex-review` reviewer now approves exactly `hub_review` and `hub_task_show`, per tool: on Codex 0.164.0 `exec` refused every MCP tool call, so its reviews ended without a verdict (#783). A reviewer turn that still ends without a verdict leaves one screened `hub.log` line (exit code and the hub tools it called) and is offered on, or to you when you named that reviewer (task 453). A stale review request that the hub refuses at admission no longer marks the reviewer unavailable: a request whose binding changed is skipped, and one whose policy changed is rerouted as no verdict (#781). An unavailable reviewer slot no longer stops the agy TUI from reading its own task (#794). An `ahub recovery dispose --stop-and-archive` audit entry now keeps the error that blocked the upgrade as `cause` (#776). A task counts toward a recurring finding only where that finding was recorded open or accepted, so a fix-only record no longer files a "Review policy amendment" card (task 328), and a missing generation sync remote no longer logs a failure every sync interval (task 401). Upgrade running hubs with `ahub upgrade` and restart Claude sessions so they load the 0.17.0 plugin. Coming from 0.15.0 or older, the notes below apply too.

## Upgrading to 0.16.0

Always-ask now covers the local worker, Pi and Codex too (#636 slice 3): a local or Pi model tool call is classed before its permission mode, a `never-ask` grant, Pi's `Always allow` or `--unattended`, and a classed command approval request that Codex sends offers only allow-once, deny and the class budget. Unattended local or Pi work that publishes, installs or deletes now waits for you: answer it in the console, or change `action_policy` as in the 0.15.0 notes below. `ahub status` still lists Codex as not enforceable, because its native policy can run a command without sending a request, and Jcode as having no hub approval path. An approval whose command is cut or withheld (an ACP peer's private turn, for one) can only be denied, and a local `action_policy` that weakens the defaults is flagged on every status policy row. The classifier now reads the literal words around a shell expansion (`git push origin $B` asks) and takes the strictest class where the expansion can change it, while a `gh api graphql` call with one literal query no longer asks (#762, #756; see [security notes](security.md)). The hub no longer calls a claude-mem worker (agent-mem#13 P4): recall, briefs, `ahub ask` and the local worker's capture run in process on the exact-pinned `@staix/agent-mem` 0.7.0, `memory.worker_url` is ignored, `ahub doctor` reports the library, and `ahub ask --remember` and context checkpoints save pending candidates that only a person accepts; `ahub memory import claude-mem` stays the explicit way to copy old notes. The planner setting takes up to eight peers (`ahub settings set planner claude,codex`): each new task records one of them, only that planner or you change its planning, an agent's own plan is reviewed by another holder whenever one is online, and `ahub task assign <id> <peer> --role planner` moves it (#525-2; see [the planner](operations.md#the-planner-455)). Once a planner list is set or any task records a planner, `ahub upgrade` and recovery refuse a target release without `task_planners`, so the project cannot be moved back to 0.15.0 that way. `ahub deliverables [--task <id>] [--approved] [--check]` lists what each task delivered and a reviewer approved, and a dashboard card shows a `Deliverables n` chip (#509b). `ahub budget` prints each window's kind and source and says why a peer has no number (#285). The dashboard Memory view gains a Code neighbours toggle for a selected symbol, and `ahub doctor --stale-anchors` is a read-only report of memory symbol anchors at the current head (#684). The `codex-review` reviewer on Codex 0.164.0 no longer needs `ahub agents trust` (#757). Upgrade running hubs with `ahub upgrade` and restart Claude sessions so they load the 0.16.0 plugin. Coming from 0.14.0 or older, the notes below apply too.

## Upgrading to 0.15.0

Publish, external-write, destroy and install calls now ask a person (#636 slice 2): the Claude PreToolUse hook returns `ask` for such a call in every permission mode, `never-ask` included, and a hub-owned ACP peer such as Kimi in native `ask` mode never auto-approves one, not under `--unattended` either; it waits in the console and the dashboard as `Action approval (<classes>): <command>` and is denied when `approvals.timeout_s` passes. When a class budget is above one, the approval of a classed ACP call also offers `Allow <class> xN for this session`. Unattended work that publishes, installs or deletes now stops for you: answer it, or set `ahub settings set action_policy.enabled false` or `action_policy.budgets.<class> <n>` (the policy and its budgets live only in untracked `.agenthub/config.local.json`). `ahub status` names each peer where the hub cannot see the call before it runs: a Kimi in `yolo` or `auto`, a Claude session that has not run the hub's permission hook, an `--unattended` Claude launch, and Codex, Pi and the local worker until task 313 (see [always-ask action policy](operations.md#always-ask-action-policy-foundation-636)). A terminal Claude instance declared with `implementer` or `verifier` and its own `worktree` now owns write-class tasks once the daemon verifies its launch record and channel cwd; start it again with `ahub claude --as <id>` after the upgrade, because a launch recorded without its execution root attaches without isolation and gets no write task (#525-5). A headless Claude implementer can be declared in `.agenthub/config.local.json` (`"start_mode": "headless"`, roles `["implementer"]`, its own registered `worktree`, `permission_mode` `ask` or `ask-when-needed`; `never-ask` is refused): create and register the worktree first, then `ahub claude --as <id>` asks the hub to start it and returns. It keeps one session per task, and its writes and shell calls reach you as allow-once or deny requests in the console; no answer is a deny (#525-4; see [additional headless peer instances](operations.md#additional-headless-peer-instances)). `hub_task_done` and `hub_sdlc_record` take `deliverables: [{path, format, version?}]`: the hub hashes the files itself, a reviewer's approval is refused when a file changed since delivery, and `ahub task show` reports each file as `unchanged`, `changed`, `missing` or `unknown` (#509; see [deliverable records](sdlc.md#deliverable-records-509a)). A review request lists the task's recorded acceptance criteria by id, and an unmet item that starts with one (`AC2: what is missing`) is recorded on the verdict (#507). A peer that accepted or finished a task no longer reviews it; when no other reviewer is left, you review it, and `ahub route explain <id>` also prints the planner walk (#525-3). Instances, `review`, `snapshots.keep`, `approvals.timeout_s`, `context.gate` and the `sdlc.toml` `mode` and `required_checks` can be edited with `ahub settings edit`, the console Settings key `c` or the Structure group of an `ahub ui --settings` session: the hub validates, shows a diff and keeps a backup; a changed instance or `sdlc.toml` waits for a hub restart (console `R`), and keys that run code or locate secrets stay console only with their name typed (#689; see [structural configuration](operations.md#structural-configuration-from-the-console-and-the-dashboard-issue-689)). Kimi's token use is now counted from its session wire log, so a `budget.kimi_tokens_5h` you set pauses Kimi when it is reached (#285). `ahub backlog list` prints a table by rank; a script that read its output uses `--json` (task 399). A launcher that meets a busy hub retries for up to 15 s and prints `hub busy, retrying` once (#719). Upgrade running hubs with `ahub upgrade` before relying on deliverables: an older daemon drops them from a newer plugin's `hub_task_done` without a word. Restart Claude sessions so they load the 0.15.0 plugin, and if `ahub status` shows a fresh reviewer instance such as `codex-review` stopped after the upgrade, start it again with `ahub codex --as codex-review`. Coming from 0.13.0 or older, the notes below apply too.

## Upgrading to 0.14.0

At a terminal width `ahub board` now prints one line per task: the title is cut with `...`, dependencies move to an AFTER column, STAGE is the meter with a short next-step code (`intent: issue?`, `review: CI?`, `ready`) and a legend line explains them; `ahub board --full`, piped output without `COLUMNS` and `--json` keep the whole title and SDLC advice (#724). The dashboard's Agents view gains a Usage view under Usage budgets: lifetime totals, the last 14 UTC days of tokens per peer, the open pauses and recent limit events, and a task table in which a private task shows only as `#id [pii]` (#683 U4). A task sheet gains a Code group: the changed symbols marked `matching` or `unplanned` against the plan, the plan names nothing changed under as `untouched`, and a symbol opens the Memory tab on its node; a private task has no group (#684). `ahub sdlc metrics [--since <date>]` and the planner tool `hub_sdlc_metrics` (planner or person, read-only) report lead times, first-pass approval, rework rounds, stale-head re-reviews and stalls from board history, with `unknown` where the board cannot tell. An optional `[bands.<metric>]` table in `.agenthub/sdlc.toml` turns a breach into a hub notice, a read-only `triage` backlog task or a `plan` backlog card, once per episode, only while `mode` is `advise` or `enforce`, and never a GitHub issue (#481 S7; see [SDLC metrics and control bands](sdlc.md#sdlc-metrics-and-control-bands-481-s7)). In advise and enforce a task's issue identity is now linked when it is proposed or accepted, with no GitHub read; a title that names another repository (`agent-mem#13`) links only when `refs.repo` names it, and the propose result suggests setting it (#723). A fresh reviewer whose start fails now names a cause class (`version`, `binary`, `mcp_inventory`, `plugins_hooks_apps`, `sandbox_proof`, `credential_root`, `timeout` or `unknown`) on the `reviewer` line of `ahub status` and in `hub.log` (#722). A Claude channel instance in `.agenthub/config.local.json` may declare `implementer` or `verifier` and then needs its own `worktree`, while a planner or reviewer instance refuses one; the hub routes no code tasks to such an instance until #525-5, and a headless Claude instance stays reviewer-only. `planner` is refused on a pi, local or agy instance declaration and dropped, with a notice, from a `roles` entry for those kinds (#525-1; see [Roles per SDLC stage](operations.md#roles-per-sdlc-stage-525)). A planner pull of a reserved backlog task now assigns it to the reserved peer and offers it at once; when that peer is offline, off roster, paused, full or excluded, the pull is refused with the reason and no other peer takes it (#718). `ahub codex --as <id>` for a headless fresh reviewer instance starts it and returns (#720). Restart Claude sessions so they load the 0.14.0 plugin. Coming from 0.12.45 or older, the notes below apply too.

## Upgrading to 0.13.0

One version policy now gates the Codex and Kimi fresh reviewers, Jcode, agy and Qwen (#691): `ahub agents` lists each installed CLI with its version and verdict, a version outside the verified ones (or, for Jcode and agy, outside their compatible line) is refused with the trust command, and `ahub agents trust <id> <version>` accepts that exact version on this machine; only the person can run it, and the reviewers' isolation proofs still run. See [agent CLI versions](operations.md#agent-cli-versions). If you use Jcode, run `ahub jcode` once per project: the hub-owned `.jcode/mcp.json` entry no longer names a peer, `ahub status` and `ahub doctor` show the old entry as not ready until it is rewritten, and the hub admits Jcode's hub tools only from an owned launch (task 368). Extra Jcode instances, each with its own `jcode_home`, can be declared in `.agenthub/config.local.json` and started with `ahub jcode --as <id>` (#685; see [Jcode operations](operations.md#optional-jcode-peer)). Run `ahub init` once per project to refresh the hub block in `AGENTS.md`: it tells pull-only agents never to poll `hub_inbox` or CI on a timer and to run one heavy job per repository at a time (#681). `ahub usage` (with `limits` and `total`) and the console's Usage panel (`7`) show tokens per peer, task, issue, PR, release, day or model and the quota pause and reset history (#683); `ahub report --dogfood` prints a read-only scorecard (#687). In the console, `r` on a task in review now asks `a` (approve) or `c` (request changes, which needs a note) (#711), and a task's detail shows an overlaps block and, when ripwire 0.6.7 is on the daemon's PATH, its changed symbols, which the review brief lists too (#684). A pull-only peer now drains its queue up to 64 KiB per `hub_inbox` read, a queued delivery can be discarded while its peer is busy, and the person clears one peer's queue with `ahub queue discard --peer <id> --reason <text> --yes` (#713). `ahub sdlc authorize-release <version>` records the person's release approval, and `ahub init --release-guard` installs an optional tag pre-push guard (#481 S6; see [release approval](operations.md#release-approval-and-optional-tag-guard)). As announced since 0.12.x, `sdlc.workflow = "gsd-lite"` no longer loads and the `phase` receipt name is refused (#481): remove the setting and record a `criteria` checklist with `hub_sdlc_record`. Restart Claude sessions so they load the 0.13.0 plugin. Coming from 0.12.44 or older, the notes below apply too.

## Upgrading to 0.12.45

The dashboard is redesigned (#469): from 1024px a top bar and a left sidebar (a row of tabs below that), keys `1`-`7` switch views, `?` lists the keys and `Esc` closes a sheet; a task opens as a side sheet, and the plan, split, releases, delivery evidence and propose forms sit in a Plan sheet opened from the board toolbar. View names, ids and the view cookie are unchanged. A person can load a bundled ACP adapter module declared under `adapter_modules` (a `path` and its `sha256`) in untracked `.agenthub/config.local.json`: only the daemon imports it, at startup, so a changed declaration needs a restart; Settings and hub tools cannot write it, and a declaration in the shared `.agenthub/config.json` is ignored. A project that declares modules can be upgraded or recovered only between releases that advertise `external_adapter_modules`. See [Adding an AI tool](adding-an-ai-tool.md#5-external-adapter-modules-451-a4) (#451). `hub_review` and `ahub review ... --findings '<json>'` take structured findings, `max_nits` in `.agenthub/sdlc.toml` caps the nits per report (default 5), and in enforce an open Important finding refuses approval (#481 S3). Plans take optional `proof` and `risks`. In enforce, approval also needs every changed PR file covered by a literal `plan.paths` entry; otherwise amend the plan through `hub_task_accept` and call done again, or the person runs `ahub sdlc accept-departure <task> <head> <reason...>`, which lapses when the hub restarts (#481 S2). An unresolved review thread now settles only by resolution or a later reply from a GitHub user; any other author kind counts as a pending bot comment (#481). `ahub roster remove <peer>` also deletes the roster key of an instance no longer declared (task 225). When `ahub kimi` refuses a `kimi_cmd` with no TUI form, it now says the value is the running hub's, retained until `ahub settings reload` (#654). A Claude session no longer gets `hub_inbox` advice while a delivery hold refuses its pulls (task 221). A same-size rewrite of a large file within one filesystem timestamp tick is now told apart by its bytes (#428). Restart Claude sessions so they load the 0.12.45 plugin. Coming from 0.12.43 or older, the notes below apply too.

## Upgrading to 0.12.44

Run `ahub init` once per project to refresh the hub block in `AGENTS.md`: it tells agents in the agy TUI not to report the hub missing when no `hub_*` tool is listed on the first turn (#607). agy no longer shows Claude's context reading or Claude's transcript usage as its own (#624). When the hub itself starts Kimi or Qwen headless, it also opens `ahub watch <peer>` through its terminal provider; with no provider, or a failing one, the start still succeeds and reports the command to run (#286). When an `implement` or `bulk_edit` owner completes two turns in a row with no recorded writes or task-tool effects, the planner gets a notice, and a done report with no writes since acceptance says so in the review request; set `task_sweep.no_writes_turns` to change the count, or 0 to turn it off (#498). A declared agy extra instance is refused when the config loads, and Qwen's context occupancy shows unknown until a native source is verified (#625). A standard ACP agent can now be declared as a config-only adapter (`adapters.<kind>` in untracked `.agenthub/config.local.json`); restart the hub, then run `ahub roster add <kind>` and `ahub <kind>` (see the operations guide, #451). A project that declares adapters can be upgraded or restarted only to a release that advertises `configured_acp`. A `peers.<id>` block now accepts only `start_mode`: any other field stops the config from loading at hub start, where 0.12.43 ignored it at startup. Restart Claude sessions so they load the 0.12.44 plugin. Coming from 0.12.42 or older, the notes below apply too.

## Upgrading to 0.12.43

A busy hub no longer stalls when the checkout's HEAD moves under open turns: snapshot Git work in one burst shares a 250 ms budget, and incoming checkouts, merges and fast-forwards are told apart from a peer's own commits through the HEAD reflog, so they no longer raise false concurrent-edit warnings (#576). `ahub task assign` and `hub_task_assign` now refuse with the reason when the named peer cannot take the task (#601). `ahub completion zsh|bash|fish` prints a shell completion script (#603). The console's Peers tab shows each peer's planner WIP, and `w` edits its limit (#532). agy native file reads are recorded as peer facts on 1.4.2 and 1.4.3 (#555); 1.4.3 stays unverified, and in its TUI the hub tools appear from the second turn (task 267, #607). Coming from 0.12.41 or older, the notes below apply too.

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

Antigravity (`agy`) can join as an optional pull-only implementer (#485). It is off roster by default: install the Antigravity CLI 1.4.x (1.4.2 and 1.4.7 verified; other 1.4.x patches launch with a warning; the hub tools appear from the second TUI turn), run `ahub roster add agy`, then run `ahub agy` in a terminal. Its native permissions are unmanaged and it has no hub sandbox. See [Antigravity operations](operations.md#optional-antigravity-agy-peer).

Reviews can rotate across fresh Claude, Codex and Kimi reviewer sessions (#519, #533). Declare headless reviewer-only instances in `.agenthub/config.local.json`; Codex and Kimi join only with `review_mode: "fresh"`. Codex also needs a compat-admitted Codex (receipt-verified 0.146.0 and 0.163.0; select it with `codex_bin` when needed), and Kimi needs a compat-admitted Kimi Code on PATH (receipt-verified 2.2.0, 2.3.0, 2.3.1 and 2.3.2), signed in with its own OAuth login. Run `ahub agents` for the current version policy; every fresh reviewer still needs a passing runtime preparation. The [2.3.0](verification/2026-10-22-kimi-qwen-compat.md), [2.3.1](verification/2026-10-25-kimi-231-reviewer-compat.md) and [2.3.2](verification/2026-10-26-kimi-232-reviewer-compat.md) receipts are model-free and do not establish real login or model readiness. A headless reviewer instance without `review_mode` keeps its native behavior and stays out of the pool. agy is not a reviewer: naming it in `review.pool` shows an unavailable skip in `ahub route explain`, never a review. Once a train is active or frozen, or `review.pool` is set or fresh reviewer instances are declared, `ahub upgrade` refuses a target release without that support, so an older release cannot take the project over. See [fresh reviewer pool](operations.md#fresh-reviewer-pool-519).

A guarded config edit that the hub keeps at its running value now shows as `config retained: <keys>; run ahub settings reload` in status, the console and the dashboard's Settings, and starting a peer whose launch keys are retained says it uses the running value (#542). See [settings](operations.md#settings-from-the-dashboard-and-the-terminal).

Upgrading from 0.12.36 or earlier, the 0.12.37 notes below also apply.

The restarted Claude planner gets the release-train tools (`hub_release_new`, `hub_release_assign`, `hub_release_configure`, `hub_release_cut`, `hub_release_report`); the person uses `ahub sdlc train report|configure|cut` (#481 S11). A due date asks for a cut review and never clears unfinished work; a cut freezes scope and publishes nothing. See [release scheduling](operations.md#planner-release-scheduling).

Jcode must be 0.98.0 or later, below 1.0.0; 0.94.0 is no longer accepted, so `ahub doctor` fails its Jcode row for an older install and the peer does not start (#529). Every owned jcode process runs with `JCODE_NO_TELEMETRY=1`.

Since 0.12.37 the hub opens a split memory home through its shards (#534); the current exact `@staix/agent-mem` pin is 0.13.0. Before anyone runs `amem migrate --shards` on a memory home, every hub using that home must run 0.12.37 or later: an older hub does not see the split and keeps writing the old layout. `ahub memory profile-check` is split-aware and compares each hub with its own project's shard (#536). See [memory profiles and rollout](memory.md#selected-memory-profile).

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
| `ahub board` | who has what, one line per task at a terminal width; `--full` for whole titles and SDLC advice, `ahub task show <id>` for one task |
| `ahub task cancel <id> --reason <text>` | close obsolete work without approving it or stopping a native turn |
| `ahub settings set planner <peer>[,<peer>...]` | pin up to eight planners; status reports whether they came from settings, roles or the automatic choice |
| `ahub settings reload` | apply edited config files without a restart; guarded values wait for your `y` in this terminal, and restart-only keys stay pending |
| `ahub settings edit <file> set <path> <json>` | change an instance, the review block or the `sdlc.toml` lifecycle with a validated diff and a backup; `ahub settings backups` lists the backups |
| `ahub status` | peers, queues, pauses; `ahub budget` for quota windows |
| `ahub usage [--by peer\|task\|issue\|pr\|release\|day\|model]` | tokens per group, each number with its source; `ahub usage limits` for pauses and resets |
| `ahub agents` | which installed agent CLI versions the hub accepts; `ahub agents trust <id> <version>` accepts an untested one on this machine |
| `ahub memory profile-check` | a person's read-only check of running memory bindings in the current registry |
| `ahub ask <question>` | what the board, shared memory and the log say, with the ids the answer rests on |
| `ahub stop <peer>` | stop one headless peer (Kimi, headless Pi, `local`); the hub and the other peers keep running |
| `ahub kill` | stop the daemon and everything it started |
| `ahub down` | the same as `ahub kill`, named as the counterpart of `ahub up` |

More: `ahub help`. How it is built and why: [`docs/specs/2026-09-19-agent-hub-design.md`](specs/2026-09-19-agent-hub-design.md). What it protects and what it does not: [`docs/security.md`](security.md).

## Shared memory

The hub exact-pins the first-party `@staix/agent-mem` 0.13.0 core, including deterministic capture; no claude-mem worker is needed. Existing shared-v1 memory remains the default; upgrading does not migrate it. Managed agents use screened `hub_memory_search`, `hub_memory_show` and `hub_memory_graph` tools, or propose a correction with `hub_memory_correct`; only a person accepts candidates through the supported `amem review` path. Since agent-mem 0.7.0, `amem review` also accepts candidates on a selected generation.

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
or `ahub settings` in a terminal (the Structure group edits instances and the
lifecycle only in such a session), and guarded values from an edited file need
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
