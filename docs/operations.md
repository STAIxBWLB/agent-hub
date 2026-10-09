# Operations guide

This guide describes ahub 0.12.19 and control protocol 15. Live verification
results and remaining prerequisites are recorded separately in [the smoke ledger](smoke.md).

## Command help

`ahub help`, `ahub --help` and `ahub -h` print the commands grouped by section;
`ahub help <command>` prints only that command's entries, and so does
`ahub <command> -h` (or `--help`) when the flag is the only argument; anywhere else
it is an ordinary argument, and `ahub claude` and `ahub codex` pass it on to the
agent. An unknown command
prints `unknown command "<name>"; run ahub help` and exits non-zero. Usages start
at two spaces and descriptions at one fixed column, wrapped at word boundaries to
the terminal width, read as at least 80 and at most 100 columns.

Help uses the console palette: section headings bold cyan, `ahub <command>` words
cyan, arguments and descriptions the terminal's default foreground. It has no
`--color` flag: color is on only when standard output is a terminal, `TERM` is
not `dumb` and `NO_COLOR` is empty or absent. Pipes and redirects get plain text
without escape sequences, laid out for 80 columns.

## Operator console and panels

`ahub console` combines the existing tail stream with peer, quota, approval-age
and input rows. `ahub up` opens it when both input and output are terminals;
`--no-console` and redirected input/output retain the start-only behavior.
`ahub tail` remains available with its existing rendering.

Allowing an approval requires selection and a separate confirmation. Denying
does not. Only options the daemon supplied are selectable. Typing a command
prevents approval shortcuts from interpreting that input as an answer. Full
approval titles are terminal-only; expiry and answers from another console remove
the pending item. Approval audit records contain id, peer, option kind, response
time and answering surface, without the title.

Pi's write, edit, bash and git write requests also offer `Always allow <tool>
until Pi restarts`. It allows later calls of that tool by the running Pi without
asking, under the same path guard and sandbox; a Pi restart or replacement, or a
hub restart, drops it. The hub log records each granted call by tool name only.
The dashboard can only deny Pi's requests.

Tab toggles stream and panels; `ahub console --panels` starts in panels. Peers,
Approvals, Tasks, Queue and Events support arrow keys or j/k, Enter for detail,
Escape to return and `?` for help. `:` enters a command. Assignment, delivery
resolution and allow decisions require confirmation; delivery resolution requires
a reason. Tasks use the same public redaction as the board. Panels need at least
80 columns by 24 rows; smaller terminals stay in stream mode. Task and queue
polling runs only while the corresponding panel is visible. Leaving restores
the terminal and returning from panels replays the bounded stream buffer.

Console color policy is `--color=auto|always|never`, with `auto` as the default.
Auto enables color only when both input and output are TTYs, `TERM` is not
`dumb`, and `NO_COLOR` is empty or absent. Explicit `always` overrides these
conditions, including redirected stream output; `never` disables styling.
Neither option changes terminal size requirements, panel decisions, cursor
management or the final reset. Invalid values fail before connecting.

| Meaning | Palette | Examples |
|---|---|---|
| Information and navigation | Cyan, bold cyan for active/selected labels | Tabs, section/peer labels and `>` selection marker |
| Success and availability | Green | Idle peer, approved task |
| Waiting and attention | Yellow | Busy/paused peer, pending approval, confirmation, review/ready task, important priority |
| Failure and intervention | Red | Failed/check-failed task, undeliverable/overflow, `needs_review` queue, denial request or expired/cancelled approval |
| Metadata | Bright black | Ages and remaining approval time |

Offline peers, primary titles, action details and message body lines keep the
terminal's default foreground. Labels and prompts remain readable without
color. Stream styling applies only to the header, using structured event data;
message text cannot choose a color. A local denial is shown as requested, not
as a confirmed receipt; a remote answered closure has no option-kind metadata
and is not guessed to be a denial. A fixed palette is applied after terminal
control sanitization. Width, clipping, wrapping and cursor placement use plain
Unicode text. Each styled span and every interactive exit restores attributes.
Color adds no polling, timers or extra redraws. `ahub tail`, logs and JSON stay
unchanged.

```sh
ahub console --panels --color=auto
NO_COLOR=1 ahub console
ahub console --color=never
ahub console --color=always > console-stream.txt
```

Actual light/dark terminal readability and bounded idle-CPU observations are
recorded separately in the smoke ledger; fake-terminal tests establish policy,
geometry, sanitization and restoration only.

The command input accepts existing status, board, task, review, say, pause,
resume, budget, queue, permit, ask, remember, route, turns, undo, check-path and
report operations. It executes an argument vector with closed stdin. Lifecycle,
launch, nested console, setup, UI, logs and tail commands are refused.

## Conducting a team from Claude Code or Codex

Start the daemon with `ahub up --no-console`, set exactly one conductor in the
project configuration, then open `ahub console` in a split terminal for approvals:

```json
{
  "roles": { "claude": ["planner", "reviewer", "conductor"] },
  "conductor": { "feed": "own" }
}
```

Launch that peer with `ahub claude` for channel pushes, or select `codex` in
`roles` and launch `ahub codex`. The conductor splits work into owned tasks,
observes `hub_status`, moves stalled work and obtains review before reporting
results and open decisions. It does not implement the tasks it handed out.
`hub_peer_start` starts local, Kimi or headless Pi; requests for native TUIs
return the `ahub` command for the person to run, after validating it through
the shared launcher planner. The wrapper plans again at launch when native
endpoints are available. `hub_peer_hold` and `hub_peer_release`
manage only holds placed by that conductor. Assignment also requires `assign`
when the conductor has an explicit capabilities list.

Check the returned owner and task state after assignment. Routing skips paused
peers, so assign work before placing a delivery hold. Hand work out through the
board and report to the person with `hub_send` addressed to `user`, or a `[FYI]`
final response in the native TUI. Broadcasting implementation instructions can
cause an otherwise unassigned owner to claim duplicate work.

The person answers approvals in the console, resolves `needs_review` deliveries
with `ahub queue resolve`, and handles budget overrides and hub lifecycle.
Running these commands from an agent shell is refused; the CLI retains the
agent's identity even when invoked through a shell tool.

`conductor.feed` is `own` by default, `all` for all tasks, or `off`. Ordinary
milestones share the existing digest window and collapse repeated queued
task/kind notices. They wait behind a busy conductor. An aged approval or
`needs_review` hold is important, contains only peer/tool-age or delivery id,
and directs the conductor to ask the person. A completed task set emits one
round notice until a new task joins. Removing the role or switching the feed
off withdraws pending feed notices.

For a Claude conductor, `ahub claude` also observes native session and turn
boundaries when facts injection and task-idle sweeps are off. Keep the managed
hooks enabled to measure completion and supervision usage. Passing your own
`--settings` takes precedence and produces a warning when it replaces that
observation. The launcher records its private session identity in ordinary
terminals too; this does not grant terminal-recovery authority.
Ordinary Claude sessions with turn-free facts or task-idle sweeps enabled get the
same session/start observation. Other ordinary launches remain non-opt-in.

`ahub report` records conductor actions and completed native turns containing
supervision. Tokens describe the whole measured turn, which may also contain
other work; they are not a per-notice cost estimate. Missing measurements stay
unknown. Use the live smoke ledger to assess observed turns and tokens per
approved task before choosing `all`; an unmeasured run is not a cost benchmark.
Claude turn counts use authenticated native completion events. Older logical
state counts are labelled; an idle channel or approved task alone does not prove
that the native answer finished.
The Stop hook acknowledgement is not a counted completion. The daemon checks the
native transcript after the hook can return; missing or changed-session evidence
stays unknown.

## Install and start

Use Bun 1.3 or newer. Install the released package and install its Claude
channel plugin:

```bash
bun add -g @staix/agent-hub
ahub setup
cd <project>
ahub init
ahub up
```

`ahub init` writes the project configuration and managed instruction blocks.
Run it after an upgrade when those blocks need refreshing. `ahub setup`
updates the shared Claude plugin. Keep `ahub console` open when a local worker
may request an approval.

`.agenthub/config.json` can be committed and shared. The fields that choose
what the hub runs, which files it sends as credentials, where task text goes,
or how far the local worker's sandbox reaches (`kimi_cmd`, `codex_bin`,
`pi.cmd`, `checks`, `mlx.bin`, `mlx.runtimeDir`, `mlx.modelPath`, `omniroute.urls`,
`omniroute.access_hosts`, the `omniroute` key files, `memory.worker_url`,
`local.read_allow`, `local.bash_network`, `local.network_allow`) are machine-local:
they apply only from a file git confirms nobody committed. Put them in
`.agenthub/config.local.json` (`ahub init` adds it to `.gitignore`), which is
read after `config.json`; outside a git repository they keep their defaults, and
an empty value always means the default.

The local worker's commands run under a sandbox that starts from deny default
(0.10): they may run and read the system, toolchain and project directories and
the selected Xcode or Command Line Tools dir (`xcode-select -p`; for an Xcode
app, its whole `Contents`, whose `SharedFrameworks` its tools load), write the
project and a temp dir of their own (`TMPDIR`, made for each command and
removed when it ends; one left by a hub crash, named `ahub-cmd-*`, goes with
the OS temp cleanup), and nothing else; the shared temp dirs are closed.

Network is off unless `local.bash_network` says otherwise. With `true` it goes
only through the hub's egress proxy on a loopback port (0.11): commands get
`HTTPS_PROXY` and the other proxy variables, the proxy opens HTTPS (`CONNECT`,
port 443 unless an entry names one) to the hosts in `local.network_allow`, and
the profile denies every other connection, direct egress and other loopback
ports (claude-mem's, the Codex app-server's) included. A listed name also
covers its subdomains; a name that resolves to a loopback or private address is
refused, and so is plain HTTP. Behind NAT64 with the well-known prefix
`64:ff9b::/96`, the IPv4 address inside the answer is what counts; the local-use
prefix `64:ff9b:1::/48` is refused outright, so on a network whose DNS64 uses it
an IPv4-only host such as github.com is refused too; use `"direct"` there (it is
removed in 0.13.0). A network-specific NAT64 prefix is not recognised. Every
refusal is a `network: refused` line in `hub.log`, by host where one is known
(with the method for plain HTTP, and the error code when a listed host is
unreachable), never a path, query or header. The default list holds the npm, PyPI, crates.io and Go module
registries and GitHub's code hosts; set `local.network_allow` in
`config.local.json` to replace it. `"direct"` keeps the open network of 0.10 and
earlier until 0.13.0, which removes it; while it is set, `hub.log` and `ahub
doctor` say so. With network on, commands may also read the public CA
bundles and Python's `certifi/cacert.pem`, which the `*.pem` key deny would
otherwise hide.
The allow-default profile of 0.9 and earlier was removed in 0.12.0: a
`local.sandbox` setting is ignored (`"allow-default"` with a note in `hub.log`
and `ahub doctor`), and a toolchain the profile lacks goes in `local.read_allow`. Newly closed outside home: `/Applications`
(an app's bundled CLI), `/nix`, `/Volumes` and `/Users/Shared`. A toolchain
there, or elsewhere in your home (a CI tool cache, a version manager the profile
does not list), needs its directory in `local.read_allow`, for example
`"/nix"` or `"~/.pixi"`.

`capabilities` in `.agenthub/config.json` narrows what a peer may do with the
hub's tools: list a peer and it keeps only the capabilities named, from
`propose` (`hub_task_propose`), `assign` (proposing with another peer as owner),
`remember` (the `hub_remember` tool; the notes the hub itself keeps of done
summaries and review verdicts are not gated) and `important` (`[IMPORTANT]`
messages). For example `"capabilities": { "local": ["propose", "remember"] }`.
A peer that is not listed keeps all of them, a listed peer whose value is not a
list gets none, and an unknown capability name grants nothing; `hub.log` says
so for each, and logs every refusal (`capabilities:`). A refused tool call says
which capability is missing; an `[IMPORTANT]` turn answer without the
capability goes out as status, with a note to the sender.
Approvals are never a capability: only the console (and the dashboard) answers a
permission request.
A committed value is ignored with a line in `hub.log`, a note from `ahub
codex` and `ahub models`, and a row in `ahub doctor`.

Managed launchers attach native peers to the project daemon:

```bash
ahub claude
ahub codex
ahub kimi
ahub pi --mode headless --backend auto
ahub local
ahub local --model <served-model-id>
```

Start only the peers configured for the project. A launcher records and checks
its project and session identity; do not start a second terminal by guessing
from a process name. For multiple projects, use the explicit selector before
the command, for example `ahub --project /path/to/project codex`.

An attached local worker switches to an explicit `--model` or `--route` when idle.
A busy worker refuses with `local is busy; retry when it is idle`. With no selection
flag the command reports that it is already attached. Before attaching or replacing
it, the hub reads the authenticated model inventory and makes a one-token availability
call to the selected models (route targets and its fallback included). A failed check
keeps the existing worker; `ahub doctor` flags a fixed model absent from the inventory.
Controlled recovery may restore a manually paused local worker without a reachable
gateway, preserving its queued work. Its manual resume validates the restored model
choice before releasing that pause.

Three consecutive deliveries that exhaust retries mark a peer as failing. Automatic
assignment skips it until a delivery completes; inspect `ahub route explain` for the
reason. A task owned by a peer whose task delivery exhausts retries is escalated with
that delivery's error, and the console is notified.

A delivery in `needs_review` holds later deliveries to that peer. The console announces
the hold once, and status, task assignment and route explanations name its delivery id.
Inspect it with `ahub queue show <id>` and explicitly choose `completed`, `retry` or
`discard` through `ahub queue resolve`. Reassignment or approval of its task never
resolves an uncertain delivery automatically.

Reviewer candidates follow `[classes.review].peers`, then attached peers with a
`reviewer` role in `roles`. The owner cannot review its own task. If none is available,
the assignment output and console notice say that `done` will approve without review
and give the skipped-candidate reasons.

Pi 0.86 assistant usage is forwarded at `message_end`, including tool-loop messages,
and recorded before settlement. If a model supplies no usable count, `ahub report`
says `tokens not reported`; the hub does not estimate usage from text length.

## A two-agent task and review

Choose an owner explicitly, then inspect the reviewer selected by the project
routing policy before work begins:

```bash
ahub task propose implement "Update the parser" --owner codex --path src/parser.ts
ahub board
ahub task show <task-id>
```

The owner accepts with `hub_task_accept`, makes the change, and reports with
`hub_task_done` including a summary and refs. The reviewer receives a review
request and responds with `hub_review`. A console review uses:

```bash
ahub review <task-id> approved "verified against the requested behavior"
# or
ahub review <task-id> changes_requested "describe the required correction"
```

A class can carry a completion check in `.agenthub/config.json`, for example
`"checks": { "implement": "scripts/check.sh", "timeout_s": 600 }`. When the owner
marks such a task done, the tool answers at once, the hub runs the command in the
project root (one at a time; what it left in its process group is killed when it
exits, at the timeout or on shutdown), and then either
sends the task to review with the command, exit code and output tail, or keeps it
with its owner and tells it what failed. `checks` is machine-local (see Install
and start): a committed file must not choose commands the hub runs. Keys that
are not task classes are ignored with a log line. A hub stopped mid-check leaves
the task in progress (`check interrupted`); the owner marks it done again.

A task reaching `approved` is a board transition. It is not proof that an
external side effect happened unless the task's refs and a live readback show
that effect. The hub can reassign after repeated review changes according to
the routing configuration.

A review request carries a checklist: map the changed signatures and call sites
to the task's plan (without one, to its detail, which the request then
includes), read the check result, and list what is
unmet (`hub_review` takes `unmet`, `ahub review ... --unmet <item>`). A reviewer
that missed the request, and the owner, read the done summary and check result
with `hub_task_show {id}`: the task's public view with its history, as the
conductor sees it, and only a stub for a PII task. Other peers are refused. The hub
records how each review turned out, per implementer, reviewer and class:
approved; caught (changes were requested and the owner's redo was approved);
contradicted (within a week, work on the same file or symbol failed its check
or review); escalated (after the reviewer asked for changes). A record counts
tasks, not verdicts. `ahub task show <id>` lists a task's outcomes and `ahub
route explain` shows each reviewer's record with the implementer. With
`"review": { "adaptive": true }` in `.agenthub/config.json`, reviewers with at
least `min_reviews` (5) reviews of that implementer in the class are ordered by
how their reviews held up, ahead of quota but after idle before busy; off by
default, which leaves assignment as it was.

An agent can claim work nobody assigned it by proposing a task with itself as
owner; without a class, and with no model to name one, the claim is filed as
`implement`. A claim or an accept can carry a plan: the files, symbols and
signatures it will change and where new code goes (`ahub task show <id>` prints
it). When a task's paths, or its plan's paths or symbols, overlap another
owner's open task, the newcomer is told to settle it and the earlier owner gets
one line with its next message, the plan included, at no turn of its own. When a
task is done (after its check passes, when one is configured), the owners of
open tasks on the same paths or symbols get a message with the changed files,
the plan's signatures and the first line of the summary, each left out when it
matches a PII pattern; nobody else does. PII
tasks are left out on both sides.

A task can wait for others: `hub_task_propose` takes `after: [ids]` (`ahub task
propose ... --after <id>`). Until every one of them is approved, the task is
offered to nobody, cannot be claimed, accepted or marked done, and `ahub route
explain <id>` says what it waits for. When the last one is approved, the task
goes through assignment like a new one; if the hub stopped before it got that
far, the task is offered within a minute of a peer that can take it attaching
to the next run.
`ahub board --ready` and
`hub_task_list {ready: true}` list the proposed tasks with nothing left to wait
for. Dependencies are fixed when a task is proposed and can only name tasks that
already exist, so they cannot form a cycle.

An owner named for a task that waits (`owner` with `after`, `--owner` with
`--after`) is its reserved owner: the task still waits, and when it is ready
routing offers it to that peer first, not to the first idle peer of the class.
A reserved owner that is offline, paused, failing, not attached or excluded is
passed over: routing proceeds as usual, the console and hub.log say which
reservation was passed over and why, and the assignment's history note keeps
it, unless it is no news (the reserved peer is the owner the task moves away
from, or it already refused the task). A peer the task was declined for (by
itself or by the console) or escalated away from after repeated
changes_requested or by hand stays excluded on every later reroute; an owner
released as gone, or moved by the hub after a failed delivery or inference, is
excluded only from that move and may get the task again from its reservation
later. Your own `ahub task assign` is not blocked by those exclusions, and it
drops the agent's reservation. The PII constraint and capability limits
still apply, so a PII task goes to `local` or nobody whoever was reserved.
`ahub task assign` on a task that waits changes its reserved owner instead of
handing it over. `ahub route explain <id>` names the reserved owner; once the
task is ready it also says whether routing would honor the reservation now, and
why not.

The peer that proposed a task may redirect it with `hub_task_assign` while it
is `proposed` and nobody ever accepted it, without the conductor role (handing
it to another peer needs `assign` when the proposer has a capabilities list).
Once it was accepted, even if a decline or release later put it back in
`proposed`, or after a person assigned or reserved it from the console (also
once the hub carried that out), only the conductor and the console move it.

An owner offline longer than `tasks.release_after_min`
(default 30, `0` turns it off) in `.agenthub/config.json` loses its open tasks
to a peer routing can give them to; with nobody to take them they stay, and a
paused peer or a hub in a recovery operation is left alone.

Use targeted messages for coordination:

```bash
ahub say @codex "[IMPORTANT] inspect the failing fixture"
ahub say @claude "[STATUS] the test run is complete"
ahub say @kimi "[FYI] the result is recorded"
```

What agents send is limited per sender (`limits` in `.agenthub/config.json`; a
project config gets the values below unless it sets others, `0` turns one off):

- `sender_per_min` (12) messages a minute from one agent, `pair_per_min` (6) to
  one recipient (a broadcast counts as one), and `important_per_hour` (6)
  `[IMPORTANT]` messages, each of which can interrupt a running turn. Limits
  count what is sent: a reply goes to the agent it answers, a reply to a
  condensed digest counts against the agents behind it, and an `[IMPORTANT]` the
  hub lowers to status is not important. `[FYI]` costs nobody a turn and is
  never limited.
- `repeat_window_s` (120): the same text to the same recipients, answering the
  same message, again within the window is dropped. "Yes." to two different
  questions is two messages.
- A refused `hub_send` answers `not sent: <why>`, with the seconds to wait for a
  rate limit, so the agent learns at once. A turn answer has nobody to refuse
  to: one over the important budget goes out as status, and one over a rate
  limit or repeated is not published; either way the agent gets the reason with
  its next delivery, and has to send a dropped answer again. hub.log records
  each refusal (`limits:`), and a value that is not a number falls back to the
  default above. The console user and the hub itself are never limited.

`@peer` addresses one known peer. With no recipient, `ahub say` broadcasts
to attached peers. `[IMPORTANT]` can bypass batching where the peer supports
it; `[STATUS]` may batch, and `[FYI]` is recorded without follow-on
delivery. A delivery or answer is not a task completion receipt.

## Telemetry: export and report

The hub writes structured events to `.agenthub/state/events.jsonl` alongside
`hub.log` (schema: `docs/events.md`). They carry ids, routing, sizes, states and
token counts, never message bodies or task titles.

```bash
ahub report --since 7d          # turns, busy time and tokens per peer, messages, overlaps, task events
ahub report --since 7d --json   # the same numbers as JSON
ahub report --by task           # tokens, turns and wall time per task and class, with the unattributed share
ahub export --since 24h         # the raw events as JSON lines, for your own analysis
```

`ahub report` counts the same overlap warnings as `scripts/overlaps.ts`, from the
structured events instead of log lines. `--by task` uses the task each usage and
token record was attributed to when it was written: the delivery that started the
turn, otherwise the peer's only `in_progress` task. Everything else is reported as
unattributed, and records from before 0.12.18 as a separate bucket; neither is
redistributed (rules: [events](events.md#per-task-usage-reports)).

## Turns and undo

In a git work tree the hub snapshots the project's tracked and unignored files (the
project directory only, when it is part of a larger repository) when a peer
turns busy and again when it stops. The snapshots are git tree objects written
through a temporary index, so your index, HEAD and branches stay as they are. The
files a turn changed are the difference between its two snapshots, which counts
changes made by shell commands as well as edits. The last 20 turns per peer are
kept (`"snapshots": { "enabled": true, "keep": 20 }` in `.agenthub/config.json`).
Snapshots are on in any project with a config file, including one written before
0.8.0 without a `snapshots` block, and off without one; set `"enabled": false`
to opt out.

```bash
ahub turns                        # recent turns of every peer and the files each changed
ahub turns codex --limit 5
ahub undo <turn>                  # lists what it would restore; changes nothing
ahub undo <turn> --yes            # puts those files back as they were when the turn started
ahub undo <turn> --yes --context  # Codex's latest turn: also drop it from Codex's conversation
```

- A turn's files are everything that changed in the project while it ran,
  whoever changed them: the hub cannot tell Claude's or your edits made during
  the turn from the peer's own.
- `ahub undo` refuses the whole turn, naming the files, when a file it changed
  has changed again since the turn ended (by anyone; modes, symlinks and a
  directory in a deleted file's place count), or when another peer's turn that
  ran at the same time changed it too, so the change may be theirs. It also
  refuses while such an overlapping turn's changes are unknown (still running,
  cut short by a stop, a failed snapshot, a PII turn, or pruned records).
  Nothing is restored then. It plans again right before restoring and stops if
  anything moved meanwhile. A turn that is already undone says so.
- A file the turn created is deleted; a file it deleted comes back.
- `--context` asks Codex (`thread/revert`) to drop the turn, and every later one,
  from its thread's saved history before the files are restored; Codex receives
  nothing while that runs. It changes no file itself, works only on Codex's
  latest recorded turn while Codex is idle, and is logged in hub.log. Whether
  Codex's running session also forgets the turn, or only its saved history, is
  still to be checked against a live Codex (docs/smoke.md).
- A turn of a peer that holds an open PII task (assigned, accepted or sent
  back) is not snapshotted, so it cannot be undone. Another peer's turn that
  starts or ends meanwhile snapshots the whole project, a PII file the worker
  has not removed yet included, and a PII file left in the project is
  snapshotted by later turns like any other file. Keep PII files in an ignored
  directory.
- A turn the hub stopped in the middle of shows as `(no end snapshot)` and
  cannot be undone.
- Claude's turns are not recorded: its channel shows the hub no turn boundary.
  Claude Code's own checkpoints cover its edits, though not its shell commands.
- The snapshots are unreferenced objects in the repository's own object store, so
  `git gc` prunes them after `gc.pruneExpire` (two weeks by default); undoing an
  older turn says so.
- Each `turn_end` event carries `files` and `snapshotMs` (`ahub export`).

## Edit conflicts

With snapshots on, the hub also compares each turn's files with what other
owners' open tasks changed before it. A turn's files count for every task its
peer has in progress, except files that another peer's overlapping turn changed;
while such a turn's changes are unknown (it still runs), the turn's files count
for none. When a peer changes a file that another owner's open task changed
earlier, both get a message naming the file and the other task, the console
shows a `conflict:` line, and `events.jsonl` records a `conflict` event (`ahub
report` counts them). Each peer, task and file is reported once per hub run.
When another peer worked during the same turn, the messages say so: the change
may be theirs. Edits by Claude or by you during a peer's turn count as that
peer's, without that note: the hub sees no turn of yours. Nothing is blocked. A
file only one agent touched, and anything to do with a PII task, warns nobody.
A file whose name matches a PII pattern is not named, as in overlap notices: the
messages and the console line only count such files, and the event leaves them out.

Claude's edits do not pass through turn snapshots, so Claude can ask before each
edit instead. `templates/claude-hooks.json` is a PreToolUse hook for Edit, Write,
MultiEdit and NotebookEdit that runs `ahub check-path --hook`. Merge it into
`.claude/settings.local.json` (or your user settings) yourself. When another
owner's open task claims the file (refs or plan paths) or changed it, Claude gets
the list with the tool result and you see one line. The hook never decides a
permission, so your permission rules apply as before. Task titles in the list
are quoted and marked as other agents' text. The hook runs `ahub`, so it has to
be on the PATH Claude Code's hooks see; otherwise every edit shows a hook error
(it never blocks). `ahub check-path <file>` prints the same list in a terminal.

## Turn-free coordination

A notice about an open task of its recipient (the completed-change notice and the
edit-conflict messages above) is checked again for each recipient right before it
is handed over, after any digest condensation: if that recipient's task has
closed, changed owner or is gone, its copy is dropped instead of starting a turn,
the journal records it as `discarded`, `hub.log` has a `STALE` line and
`events.jsonl` a `stale` event. Other recipients keep their copies. Approvals,
check results, review requests, assignments and budget, permission and recovery
messages are never dropped this way, and a dropped notice never resolves another
delivery. The condition lives in memory: after a restart, or for the oldest of
more than 1024 notices, the notice is delivered as before.

Set `"coordination": "turn-free"` in `.agenthub/config.json` to let owners of
overlapping open tasks (the overlap rules above) work without messaging each
other. The default, `"advisory"`, keeps the behaviour described so far, and it
stays the default until an evaluation says otherwise (`docs/cooperbench.md`).

- Cohorts. Owners of overlapping tasks form a cohort when the overlap is found.
  It is silent only if, at that moment, turn-free is on, no PII task is open and
  every owner's context path is verified (below). It never turns silent later;
  it stops being silent, for good, when an owner without a verified path joins,
  a path is lost or a PII task opens, and every member still at work is told at
  once that it may message again, with the completed-change notices the silence
  held.
- Verified context path. A hub-launched Claude session (`ahub claude`) gets the
  hub's hook before and after every tool call and at the end of each turn, in
  its `--settings` next to the status line tee (a `--settings` of your own turns
  them off). Codex gets context by steer into its running turn. Until a fact or a
  one-line probe has been read back, the peer counts as unverified: for Claude
  the row Claude Code writes in its transcript for the hook's additional
  context, matched by tool use id and the offer's id; for Codex the steered
  input coming back as a user message item of the turn. A new native session,
  the peer going offline, or three offers past a minute without a readback
  (checked at its boundaries and every 30 seconds; facts sent with an
  integration request wait for the next done and do not count, a refused steer
  is no offer, and an unanswered one may still be read back), makes it
  unverified again, and a Claude session whose
  transcript the hub cannot find gets no facts at all and loses a verified
  path. A session whose hooks stop altogether leaves no offer unread, so it
  stays verified; a peer without a verified path that left three
  offers unread gets none until a readback arrives. Kimi, Pi and the local
  worker have no path yet, so a cohort with one of them is never silent.
- Silence. While a cohort is silent, an agent message from a member to another
  member is held back for that recipient only: other recipients and the console
  get it unchanged, and `events.jsonl` records a `quiet` event. `hub_send`
  answers `not delivered to <peer>: ...` (or `sent to: ...; not delivered to
  ...` when some recipients got it); a native turn answer's sender hears it on
  its next delivery. Workflow messages from the hub are never held back. A
  member's messages stay held until its native turn has ended after its task
  closed (Codex's turn completes, or Claude's Stop hook runs; a member already
  between turns when its task closes has stopped; a paused peer may still be in
  its turn, and Claude's channel going offline says nothing about its session),
  so a late answer is still the cohort's. That settlement is recorded when it happens and
  never undone: the member's next turn is new work, and once every member has
  settled the cohort is over (a task reopened after that is outside it). Only a tool call starting counts as activity after
  a turn end. A message held back from all its recipients does not count
  against the sender's limits.
- Facts. At each tool call (Claude) or completed tool item (Codex) of a cohort
  member with an open task, the hub offers what changed since it last
  acknowledged them in the files every member's task names and in the files it
  touched, with the other members' new plans; the last member still at work
  keeps the others' files after they finish. A directory a task names stands for
  git's changed (staged or not) files against HEAD, new and deleted files under
  it (200 at most; the fact says when more were cut, until it is read back, and a
  new session hears it again). A file the peer has seen there stays covered after git
  stops listing it (put back to HEAD's bytes, or the directory moved away), so
  the way back is shown (200 at most, the newest versions first; the rest are
  named as no longer followed, until the peer reads that back; a new session
  hears only the drops of its own). A file there that the peer has neither seen nor touched appears once
  someone changed it so that its bytes differ from HEAD's, or created it: it is
  named without a diff (what happened before is never shown) until the peer reads
  the fact back, and until then it counts as a change the peer has not been
  shown. A rewrite with HEAD's bytes, which git lists until it refreshes its
  index, is no change (a file too large to read is compared by git's own hash).
  `.git` directories
  at any depth and what the denylist keeps from every agent
  (`src/local/deny.ts` and `local.deny`) are never read or shown. A file a peer touched before it had a view of it (a
  partial read, say) is compared with what it was then, so a change landing in
  between is shown. A change is credited to an agent
  only with effect evidence: a Claude Edit, MultiEdit or Write whose result is
  exactly its input applied to the file as observed before it, or a Codex patch
  whose diff is exactly what changed. Shell commands, concurrent writers and
  unreported changes are shown with their attribution unknown, never credited by
  elimination; an agent's own verified writes are not shown back to it. A Codex
  read action never counts as having seen a file (it may be partial); a Claude
  Read does when it returns the whole file: no offset or limit, at most 2000
  lines and no line over 2000 characters. A diff that matches a PII pattern is
  not shown (the file is named, to be read), and a changed file whose name
  matches one is counted, not named. Only an acknowledgement (a readback, or the next
  `hub_task_done` for facts sent with an integration request) moves the peer's
  view, so a fact that does not arrive is
  offered again at a later boundary; no turn is ever started for one. An
  acknowledgement says the context reached the native session, not that the
  model read it. 60 changed lines are shown at most, the cut files named; a
  history longer than the hub keeps is shown with its attribution unknown, and a
  file that falls out of the 64 a peer touched is named until the peer reads
  that back. Only regular files
  of 256 KB or less inside the project are read, re-resolved at every read and
  opened without following links; larger ones are named without a diff. Facts never go through the bus or the delivery journal;
  `events.jsonl` records `fact`, `fact_ack` and `capability` events with bytes
  and latencies.
- Integration. A member's `hub_task_done` is a completion intent. The member
  whose intent completes the set is asked, as its done result, to check its work
  against the others' (their files, signatures and summaries, plus its own facts)
  and to call `hub_task_done` again; nothing is recorded as done yet. The next
  call counts only for the same target: the same owner, cohort revision and
  files (the named ones, and those each member wrote with an edit tool the hub
  saw, Claude's Edit, MultiEdit and Write or a Codex patch, between being handed
  its task and settling, so a symbol-only overlap counts and
  a member settling keeps its files in; reading a file never moves it, a settled
  member's later work does not count, a shell command's writes outside the named
  paths are not seen, and a file the hub reads whole whose bytes equal HEAD's
  is no change, whatever git's stat data says), with every other owner's native turn
  ended after its done (or that owner idle when it finished); the integrating
  owner's own other tasks in the cohort never count as still running. A done of a member by the console counts as its
  intent too. Edits in between, a new member, an owner change, a failed check or
  a reopened review ask again; a done within two seconds of a request is taken as a retry and gets the
  same request again; after three requests the done is recorded with
  `integration unresolved`, never as integrated, and that revision asks nothing
  more (a configured check then counts as usual). A configured check of the integrating member
  counts only for the target it confirmed; when another member reopens its task,
  that member integrates instead and the earlier one's check counts as usual.
  Inside a silent cohort a member's completed-change notice is held, not sent;
  where no integration step runs for the others (the silence was lifted, a PII
  task opened), the held notices go with the lift notice or the done result, and
  for a task the console finishes, to the console. Open tasks outside the cohort
  get their notices as usual. Facts sent with an integration request are
  offered again at the next boundary until the next done acknowledges them.
  Cohorts live in memory: after a hub restart an open
  request is recorded as unresolved, and when a peer first attaches, each of its
  open tasks that overlaps other work hears that overlaps are settled by message
  again, with the completed-change notices of overlapping tasks finished since
  it was handed the task (a notice may come twice; none is lost).
- While any PII task is open the project behaves as advisory: no facts, no
  silence and no integration step, and the cohorts that were silent stay lifted.
  When it closes, the hub forgets what it had observed, so nothing changed
  meanwhile is shown as a diff; each member is told which of its files to read
  again.
- `ahub check-path` asks the hub whether the owner of the claimed path shares a
  silent cohort with the caller, and only then leaves out the request to settle
  by message. `templates/claude-hooks.json` holds only the check-path hook; the
  facts hooks need a hub-launched session.
- Routing does not change. When routing chooses the first owner of a task that
  overlaps another owner's task not started yet (`where: "routing"`, the record
  calibration reads; an escalation, relay or reassignment is not one), and when an overlap forms or changes a cohort, routed or
  named (`where: "cohort"`), the hub records a shadow split prediction (`split`
  event; `ahub route explain <id>` shows its trace as it would be now): whether
  splitting two equal units between the two peers (`o_s + u_s < o_f + 2u_f`)
  would finish sooner than the faster one alone, from the recorded task stages of
  each peer under the profile it has now. Every hand-over is tagged with the new
  owner's profile: the hub's version, the agent's (Codex's from app-server,
  Claude Code's from its transcript; other agents report none yet) and the
  coordination mode, which decides the hub's own hooks; records accumulate across
  hub runs, one per hand-over (a decline or an escalation away counts against
  the peer that failed, never the next owner), and a peer whose version is
  unknown has no profile. The user's and
  plugins' hooks are not part of it. It is unknown unless the units are equal
  and known, both peers are available (idle, or busy taking the task in
  question: in this hub run, it is still in the turn that task started (the
  task delivered at once to the idle peer) or in which it claimed the task; a
  task queued, held, or steered into a turn about something else is not taken,
  and once that turn ends, busy is another turn; for the
  other owner, while the overlapping task is not started; the routing record,
  and a cohort record formed as a task is assigned, are taken before the task is
  sent, so a busy routed peer is not available then) with no other open work (an overlapping task its owner
  has started counts), and each has five measured tasks with no more than 30%
  failures and comparable work times. The work stage of a task ends at its first
  `hub_task_done`, and the task itself is never one of its own observations.
- `"experiments": {"stale_notices": "deliver"}` in `.agenthub/config.json`
  turns the stale-notice drop off, for a controlled comparison only (the #106
  ablation in `docs/cooperbench.md`); the hub logs it at start.

## Approvals and pauses

Inspect permission requests in the terminal:

```bash
ahub console
```

Select the requested option in the console and confirm an allow decision.
For a separate plain terminal, the existing command remains available:

```bash
ahub tail
ahub permit <request-id> allow
```

Use the exact option shown by `ahub tail`; do not approve an unresolved or
unexpected request. On macOS a waiting request also raises a desktop
notification that names the peer and, for Kimi, the tool, never what it would
run. An unanswered request is cancelled after `approvals.timeout_s` (default
120, 30 to 3600) in `.agenthub/config.json`, and the console and log say so.
Set `approvals.notify` to `false` to turn notifications off; a hub started
without a project config file raises none. While Kimi waits for an answer its
turn is kept alive, so a timeout longer than the inactivity watchdog does not
cancel it.
`ahub pause <peer>` holds delivery and `ahub resume
<peer>` releases a manual pause. Budget pauses are distinct:

```bash
ahub budget
ahub budget resume <peer>
```

A budget pause remains authoritative until the budget command explicitly
overrides it or the window resets. Check `ahub status` and `ahub board` after
a pause or handoff.

Quota also shapes routing and handoffs:

- Among peers a task could go to, those with quota readings are ordered by
  headroom per hour left until the reset of the window that bounds it (the most
  used one, so a week window near its cap is not mistaken for a 5 h window about
  to reset), so the window that resets first is used first. Peers without readings, such as `local` and `pi`, keep
  their place in `routing.toml`. `ahub route explain` shows the reordering.
- When a paused peer's window resets within `budget.wait_max_min` (30 once the
  project has `.agenthub/config.json` or `config.local.json`, 0 without one; `0`
  always hands over), it keeps its work and only tasks proposed with `urgent`
  (`ahub task propose ... --urgent`) move. If the reset moves past the limit
  while it waits (a week window crosses the gate), its work is handed over after
  all. `ahub budget` shows each decision and why in the pause reason.
- A peer whose recent failures in a class (failed checks, changes requested,
  escalations by hand) reach 1.5 after decay, and outweigh its recent
  approvals there (a task without a reviewer counts when done), goes behind the
  other candidates in the same state for that class, `local` and `pi` included.
  A failure counts half after a day. `ahub route explain` names demoted peers.

## Durable delivery and queue resolution

Protocol 10 records each recipient delivery in the private project journal.
The states are `queued`, `dispatching`, `accepted`, `completed`,
`needs_review`, `failed`, and `discarded`. Adapter acceptance means that
the native bridge received the delivery; it does not prove that the agent
executed it. Only native completion or a correlated reply can settle a receipt.

The console interface is:

```text
ahub queue list [--peer <id>] [--json]
ahub queue show <delivery-id>
ahub queue resolve <delivery-id> --action completed|retry|discard --reason "<text>"
```

These queue commands ship with protocol 10 (0.7.0 and later), where a known
offline recipient may also be queued explicitly; broadcast and automatic
assignment still require an attached peer. A hub still on protocol 9 (0.6.x)
has only `ahub status`, `ahub tail` and the task board.

Resolution requires the current observed revision. A retry closes the old
record and creates one linked attempt. Stale or conflicting resolutions fail.
If dispatching or accepted work has an uncertain outcome after a crash,
the system marks it `needs_review`. Establish evidence before choosing
`completed`, `retry`, or `discard`. Timeouts,
disconnects, cancellation, and partial effects are uncertain; do not replay
them automatically.

### Claude sessions without channel pushes

Only `ahub claude` starts Claude Code with the development-channel flag. A
Claude session started another way (plain `claude`, an IDE) keeps the hub tools
but cannot show pushes, so it attaches tools-only (protocol 16, issue #205):

- Its messages stay queued. `ahub status` shows `queued N` and `tools-only:
  messages wait for hub_inbox; for pushes restart Claude with ahub claude`; the
  console footer shows `tools-only: ahub claude` and the dashboard shows the
  status line.
- The session reads them with `hub_inbox`, at most ten messages at a time plus
  the hub's recall note when one waits (it says how many still wait). Each read is one `completed` delivery (`read through
  hub_inbox` in `ahub queue list`); nothing is ever `accepted`, and the session
  has no `hub_delivery_done`. A read the model never saw (the tool call was
  cancelled, the plugin died) cannot be retried: `ahub queue show <id>` of the
  `completed` row prints the messages to send again.
- Whatever holds pushes holds `hub_inbox` too (`needs_review`, recovery,
  `ahub pause`, a budget pause, a conductor hold): it reads nothing and says
  which hold applies.
- Restarting Claude with `ahub claude` takes the peer over and pushes what still
  waits; the plain session stands by. The other way round, a plain session
  started while an `ahub claude` session holds the peer stands by and attaches
  only after that session leaves.

## Graceful shutdown

Before stopping, let active turns and approvals settle when possible:

```bash
ahub status
ahub tail
ahub kill
```

The daemon waits for shutdown work that must survive termination. Afterward,
run `ahub status` or `ahub up` and read the project state before restarting
peers. A stopped daemon does not delete task records or the durable journal.
Do not kill a native terminal by PID or start a replacement while ownership is
uncertain.

Shutdown is bounded: once it begins, a daemon that cannot finish within
15 seconds exits anyway, and a peer that refuses to stop is logged rather than
allowed to block state cleanup. A native Pi TUI owner that does not exit
gracefully is terminated by its verified process identity (never a bare PID),
so a restarted hub never launches beside a survivor. A hub whose project root
or state directory was deleted stops itself within about 10 seconds; the
dashboard manager does the same when its home directory vanishes.

## Orphaned daemons

Daemons from before those guards, or daemons whose project directory was
deleted while they were stopped mid-shutdown, are found with:

```bash
ahub doctor --orphans
```

It lists registrations whose project root is gone, with any live process
candidates (the registry claim, the state manifest, the legacy pid file).
To stop them:

```bash
ahub doctor --orphans --kill
```

`--kill` sends SIGTERM, then SIGKILL, but only while the process argv names
that project's hub daemon exactly (the argument after `--project` must equal
the registered root); a bare, reused, or merely prefix-matching PID is never
killed.
Rows without a live process are stale registrations; forget them with
`ahub projects remove <id>`.

## Upgrade and crash recovery

Upgrade running projects with the target release's own coordinator. It accepts
a running source on control protocol 9 (0.6.x), 10 (0.7.0 through 0.12.0),
11 (0.12.1 and 0.12.2), 12 (0.12.3), 13 (0.12.4 through 0.12.15) 14 (0.12.16) or 15 (0.12.17 through 0.12.19), and only
a target on its own protocol, so the target's coordinator fits every supported
source and carries every recovery fix released up to it. Protocol 8 and older
(0.5.x and earlier) are refused as `manual-bootstrap-required`. Run from the
project directory, without replacing the global CLI first:

```bash
bunx --package @staix/agent-hub@0.12.19 ahub upgrade --to 0.12.19 --dry-run
bunx --package @staix/agent-hub@0.12.19 ahub upgrade --to 0.12.19 --yes
```

| Running now | Coordinator to use |
| --- | --- |
| 0.6.x (protocol 9) | the target's, through `bunx` as above |
| 0.7.0 through 0.12.0 (protocol 10), 0.12.1 and 0.12.2 (protocol 11), 0.12.3 (protocol 12), 0.12.4 through 0.12.15 (protocol 13), 0.12.16 (protocol 14), 0.12.17 through 0.12.19 (protocol 15) | the target's, through `bunx` as above |
| any supported source, with the installed CLI already at the target | `ahub upgrade` below, which is the same coordinator |
| 0.5.x or earlier (protocol 8 and older) | not supported: bootstrap by hand with the matching CLI |

Do not use the 0.8.0 coordinator for a running 0.7.x hub with tasks on its board:
its verification never matches the board and the operation stays blocked (fixed
in 0.8.1). Such a blocked operation can neither resume nor abort, and its lock
refuses `up` and `kill` for every project; the [smoke ledger](smoke.md) (0.7.11
to 0.8.0) records the manual cleanup. Do not use an older installed CLI as the
coordinator. After an upgrade, do not start an older hub on the same project: it
does not know the newer task columns, and its board readback breaks a later
upgrade. A 0.6.x CLI cannot target
protocol 10: its plan does not check the target's protocol, so the dry-run shows
no blocker, and `--yes` stops at staging ("target protocol requires a newer
coordinator") with an operation left to clear by `ahub recovery abort <id>`. An
older 0.7.x CLI may lack recovery fixes released after it. The
[smoke ledger](smoke.md) records dry-runs from real 0.6.4 and 0.7.5 hubs (issue
#75) and these applied upgrades: one with the 0.7.0 coordinator; one with the
0.9.0 coordinator from a running 0.8.1 hub with tasks and a budget pause; one
with the 0.10.0 coordinator from a 0.9.0 hub (one completion check running and
one queued); and one with the 0.11.0 coordinator from a 0.10.0 hub with
`local.bash_network` on.

The coordinator verifies and retains the exact target package, preserves its
own source, and promotes the global CLI only after restored projects pass
readback.

Once the installed CLI matches the target release, review the current project or all registered
projects first:

```bash
ahub restart --dry-run
ahub upgrade --to 0.12.19 --dry-run
```

Apply only after reviewing the plan:

```bash
ahub restart --yes
ahub upgrade --to 0.12.19 --yes
ahub recovery status <operation-id>
ahub recovery resume <operation-id>
ahub recovery abort <operation-id>
```

The coordinator commits only once the source is quiet: no turn running, no
approval pending, no completion check queued or running. It waits up to 10
minutes and then aborts, leaving the source running; upgrade between long
checks. A 0.8.x or older source does not report completion checks or console
task commands in flight, so the coordinator cannot wait for them. Before
`--yes`, for each task whose check `hub.log` reported as "queued or running",
wait until `ahub task show <id>` has `check passed`, `check failed` or `check
finished late` after `done (checking)` (a pass with a peer reviewer writes no
line of its own to `hub.log`), and until no task command or dashboard action is
still running. A check the commit's stop kills writes to the board after the
commit has recorded it, and the operation stays blocked.

0.9.0 turns on for every project with a config file, whether or not it has the
block: `limits` (12 messages a minute per sender, 6 per recipient, 6
`[IMPORTANT]` an hour, 120 s repeats) and `budget.wait_max_min` (30). Set them
to 0 to opt out.

0.10.0 changes every project's local worker: its commands run under the
deny-default sandbox described above, and a toolchain outside the listed
directories needs `local.read_allow`; `"local": { "sandbox": "allow-default" }`
in `config.local.json` restored the old profile until 0.12.0. Off unless set:
`review.adaptive`, `recovery.auto_resume_after_crash` and `capabilities`. A hub
before 0.10.0 keeps no session record, so a crash of one is not reported as such
by the next start.

0.11.0 changes what `local.bash_network: true` means: the local worker's and
Pi's commands reach the network only through the hub's egress proxy, to the
hosts in `local.network_allow` (package registries and GitHub's code hosts by
default). `local.network_allow` is machine-local and replaces the default list:
a project that needs another host sets it in `config.local.json` with the
defaults it still needs. `"direct"` keeps the open network of 0.10.0 until
0.13.0. Each command gets a temp dir of its own, and under deny-default the
shared temp dirs are closed.

0.12.0 removes `local.sandbox: "allow-default"`: a project that still sets it
runs under the deny-default sandbox, and `hub.log` and `ahub doctor` say so.
`local.bash_network: "direct"` still works until 0.13.0, and both name it while
it is set.

The 0.7.0 transition stages the verified package and runs a retained
coordinator from the source tree. It accepts a verified protocol-9 source and
moves to a protocol-10 target. The source journal, queued envelopes, tasks,
manual pauses, budget state, and native session identity are read back before
release. The global CLI is promoted last.

A lost commit or start reply is reconciled against the actual daemon identity,
package digest, terminal binding, and phase receipt. An uncertain terminal
creation is never repeated blindly. If Claude shows its development-channel confirmation screen, confirm it in
the captured terminal, then run `ahub recovery resume <operation-id>`; resume must not open a duplicate terminal.
Kimi and local sessions may start fresh with preserved routing and task context.
A Claude session that never persisted a transcript (zero turns) also starts fresh:
there is nothing to resume, so the upgrade accepts the new session id; a session
with a transcript must come back with its original id.
Previously stopped projects stay stopped; only the reviewed running projects
are upgraded.

Do not run an upgrade with an incompatible active protocol, an unverified
terminal binding, or an unresolved operation lock. Dry-run performs no package,
plugin, daemon, or terminal mutation.

### After an unplanned stop

While it runs, the hub keeps each attached peer's session identity in
`.agenthub/state/sessions.json` (ids and launch options, no message text); a stop
removes it as it begins. When a hub starts and finds the file, the previous run
died (`kill -9`, a crash, a lost machine), and `ahub status` and the console say
what happened to each peer. Hubs before 0.10.0 kept no such record, so a
crash of one is not reported this way.

- Deliveries that were in flight are in `needs_review` (`ahub queue list`), as
  before. When a peer next attaches, its next delivery starts with a notice that
  lists them by id, sender and task (`[pii]` for a PII task), never their text.
- Kimi, Pi and the local worker run inside the hub, so they died with it. With
  `"recovery": { "auto_resume_after_crash": true }` in `.agenthub/config.json` the
  hub starts them again: Kimi loads its recorded session (ACP `session/load`), Pi
  resumes its session file, and the local worker starts without its history, on
  its recorded route (or pinned model). Off by default: the report then says
  what to start. With `pi.auto_start` on, Pi comes back on its recorded
  headless session whether or not auto-resume is on (it runs on-prem, so this
  spends no cloud quota), and on a fresh session if that fails, keeping the
  recorded backend and model; the report says which. Malformed records in
  `sessions.json` are skipped. A Pi that ran in a terminal (`--mode tui`) is never started on its
  recorded session by the hub; the report gives the command, and with
  `pi.auto_start` a fresh headless Pi starts instead.
- Codex's app-server died with the hub; run `ahub codex` again. Claude Code's
  plugin reconnects by itself while that session is open.

## Evidence and limits

The 0.6.4 release has real measurements in [the smoke checklist](smoke.md):
Pi returned an exact file marker through MLX in 5.800 seconds in the production
probe; the installed-package checks measured Pi MLX at 2.234 seconds, Pi DGX
at 1.324 seconds, and a 208 ms MLX-to-DGX handover with the same session
identity. A real Kimi 2.0.1 and Pi run showed queue counts and priority counts
matching between the CLI and status file. These are individual observations,
not a latency or reliability benchmark.

The 0.6.4 production readback retained two envelopes for a disconnected Codex
peer with identical IDs before and after recovery; general status lists attached
peers and therefore did not show that backlog. No messages were deleted. The
0.7.1 attended cutover and production readback verified queue visibility and
completion receipts; see the final section of the smoke checklist.

Issue [#1](https://github.com/STAIxBWLB/agent-hub/issues/1) remains open for
off-campus Access credentials and a natural near-limit budget pause. Tests,
synthetic approvals, and an authenticated internal network do not close those
prerequisites. Adapter acceptance is not task completion, and package
installation or a passing test suite is not proof of a successful production
cutover.


## Ollama MLX migration (issue #51)

The routing names `mlx/fast` and `--backend mlx` are retained. The normal
runtime provider is now Ollama; the standalone Python server is legacy.
Use an Apple Silicon Ollama build with MLX support and keep it bound to
loopback. Configure its finite keep-alive and one-model/one-generation
limits before use. The model is prepared only by explicit `models setup`;
an incoming generation does not download models or start a service.

Project `.agenthub/config.json` example:

```json
{
  "mlx": {
    "provider": "ollama",
    "host": "127.0.0.1",
    "port": 11434,
    "model": "agenthub-fast-mlx:4b-8k",
    "sourceModel": "qwen3.5:4b-mlx",
    "contextWindow": 8192,
    "maxInputTokens": 6000,
    "maxTokens": 2048,
    "maxConcurrency": 1
  }
}
```

1. Record the current project/hub state. Do not restart stopped hubs or
   replay queued tasks as part of model migration.
2. If the old Python server is still running, use the old matching CLI's
   `models stop` before changing configuration, or explicitly select
   `provider: "legacy"` temporarily. Its PID, start time and command must
   match the ownership record. Never kill by process name. Preserve model
   files and the old configuration for rollback.
3. Apply the Ollama configuration above, removing legacy `modelPath`,
   `runtimeDir` and Python binary settings. Existing custom legacy paths
   without an explicit provider fail with a migration error. Old 16K input
   overrides must also be reduced; the new total context is 8K.
4. Run `ahub models setup`, `ahub models start`, and `ahub models status`.
   Setup creates a dedicated derived model; an existing model is inspected
   rather than silently overwritten. A wrong context recipe must be fixed
   deliberately under a new model name or after an explicit model change.
5. Verify a streamed completion and tool call through the authenticated
   relay. Check Ollama logs for the MLX runner, `/api/ps` for context and
   finite expiry, then confirm idle eviction. Catalog availability does
   not mean the model is resident. Unit tests are not this live proof.

Ollama is shared and external. `models stop` refuses in Ollama mode rather
than interrupting another client. Hub shutdown releases local handles and
requests, not the server. Normal idle eviction is Ollama's responsibility;
no AgentHub timer unloads a potentially shared active model.

The relay's input budget is an estimate, not exact model tokenization. Keep
headroom for templates/tool metadata and choose a larger dedicated recipe
only after measuring memory. This path does not change local-worker PII
routing or the DGX backend. Rollback requires explicitly restoring the old
config with `provider: "legacy"`; Ollama errors never launch Python.

### In-process model routes

`routing.toml` supports `[hub_routes."hub/<id>"]`, separate from sidecar `[routes]`.
Set `[local] route = "hub/stage"` or a task class's `route` to enable a hub route.
The shipped examples use OmniRoute `fast` and `coding`; `fixed_model` remains the fallback.
`--model` pins the worker and bypasses both routing engines. Sidecar `sy/` routes remain optional.

Route types: `stage` scores recent tools and holds capable recovery for two calls;
`plan_execute` plans on capable until the first mutation and then stays efficient;
`advisor` holds no-tool answers for APPROVE/REDO review; `escalation` starts efficient
and latches capable after two same-category judgements with new evidence.
Optional judges have an eight-second deadline and five-minute failure backoff.
REDO feedback is kept in the completed local turn history and counts toward `max_steps`.
PII calls require a positively confirmed campus gateway immediately before transport;
PII turns never enter shared history, memory capture, or progress observation.
The `route`, `advisor`, `progress` and `stuck` events contain identifiers and aggregates only.

Pi exposes `hub/auto` for stage routing when available. Fixed `dgx/coding`, `dgx/fast`
and `mlx/fast` aliases still pin the backend. Automatic MLX selection admits the complete
input, tool schemas and requested output within the configured context window.
Progress judgements suggest reassignment; they never change task ownership.

## Disable local MLX while keeping remote auto routing

`mlx.enabled` is an optional boolean and defaults to `true`, including legacy
configurations. Operators without an available local service can set:

```json
{
  "pi": { "enabled": true, "backend": "auto" },
  "mlx": { "enabled": false }
}
```

This removes `mlx/fast` from the relay inventory. `hub/auto` continues selecting
`dgx/fast` for efficient work and `dgx/coding` for capable work. Neither a local
probe nor a local startup occurs. `ahub models status` reports `disabled` and
`ahub doctor` reports a successful disabled row without probing the endpoint.
`models setup`, `start`, and `stop` are refused while disabled; shared Ollama
continues under its existing owner.

Migrate an earlier `pi.backend=dgx` workaround to `auto` explicitly. In a project
routing file, remove `pi_backend="mlx"` pins to use `hub/auto`, or set `dgx` to
keep a remote class pin. The hub refuses conflicting operator-written routing
before startup, while inherited shipped MLX class defaults use `hub/auto` when
the capability is absent. It never rewrites these settings. Explicit
`--backend mlx`, `--model mlx/fast`, and recorded MLX recovery launches are
refused before any local startup. Re-enable MLX or explicitly migrate the
recorded launch before recovery.

## Task idle sweep

The between-turn task sweep (#186) is disabled by default. Set `task_sweep` in
`.agenthub/config.json` (or its machine-local override) to enable it:

```json
{
  "task_sweep": {
    "enabled": true,
    "interval_s": 300,
    "unaccepted_min": 60,
    "idle_min": 120,
    "review_min": 120,
    "ladder_min": 30,
    "auto_reassign": false
  }
}
```

Booleans must be actual booleans. Each time setting must be a finite number of
at least 1; timeouts are bounded to the platform timer limit. Each threshold
measures time since the last real task history event. A ladder record does not
refresh that activity; a new event resets the ladder even at the same timestamp.

The first overdue sweep sends the assigned owner or reviewer one normal task
reminder. After `ladder_min`, the next sweep notifies the console and available
planner-role peers. After another interval it reports a reassignment suggestion
from the ordinary routing function. At most one step runs per task per sweep.
PII notices contain only the public task stub, never its text, refs or plan.

Busy, paused, offline or native-active peers, queued/in-flight deliveries and
queue holds, unresolved dependencies, completion checks, recovery/shutdown and
silent turn-free cohorts suppress the sweep. An offline owner remains governed
by the existing `tasks.release_after_min` policy. Human reviews produce console
notices. The sweep does not change route-explain output.

For Claude, `ahub claude` installs the existing PreToolUse/PostToolUse/Stop
observation hooks when the sweep is enabled, including in advisory projects.
The hooks return no facts in advisory mode. A native Stop establishes an idle
boundary; a subsequent PreToolUse marks activity. A delivery acknowledgement or
task approval does not establish native idle. Restart the daemon and relaunch
Claude after enabling the sweep so its session receives the hooks. A caller's
`--settings` still wins: the launcher warns that native idle observation is off,
and the sweep cannot verify that Claude session between turns.

`auto_reassign: true` explicitly allows an available alternative owner selected
under the existing routing, role and PII constraints to receive the task at step
three. Review-pending work always produces only a reviewer suggestion. The
sweep records no failed-work outcome and never weakens routing constraints.

Each ladder step is persisted in task history before publishing. A restart
therefore does not repeat it. A crash after the history write can leave its
notice unpublished or uncertain; the history records an attempted step, not a
receipt. Inspect `ahub task show <id>` and the delivery journal before acting;
durable-delivery retries remain the journal's responsibility.

## Documentation source verification

`docs/verified.json` maps README, the current security, operations and quickstart
pages, and every agent note to a full source commit and explicit covered paths.
A stamp records a human check of the cited paths, symbols, numeric limits and
operational commands. It does not certify live deployment or prove prose
correctness automatically. Specs, changelogs and the smoke ledger retain their
own dated evidence and are outside this manifest.

`node scripts/check-docs.mjs` also runs in `scripts/check.sh`. Missing manifest
coverage, unresolved or nonancestor commits, removed source paths and a README
status version different from `package.json` fail the gate. Source commits since
a stamp and uncommitted covered changes produce sorted stale notices without
failing it. Counts are commits touching any covered path, rather than file or
line counts; an unrelated commit leaves the document fresh. Git history must
include the stamped ancestors (CI checks out full history).

During release preparation, source review precedes restamping. Review each stale
page against its covered source, correct drift, and use the full SHA of the
reviewed source commit as `verifiedAgainst`. Record any deferred page and its
specific unverified claims in the release verification report before tagging.
Do not advance a stamp solely to clear a notice. Source stamps can name an
ancestor: the manifest-only follow-up commit need not hash or stamp itself.

## Seeded guard verification

`bun scripts/seeded-check.ts` runs six guard pairs sequentially: header quoting,
Origin refusal, control-token authentication, the hop cap, PII public views and
uncertain-delivery receipts. Each named test first passes on current tracked
checkout bytes, then must fail an assertion with the corresponding guard weakened.
Seed rot (anything other than one exact replacement), a surviving seed and an
invalid detection have distinct errors. Compiler, setup, unrelated-test and timeout
failures never count as detection.

Each seed has a private temporary checkout without Git metadata, state, output
directories or user untracked files. Installed dependency packages are linked,
never copied or installed by the runner. Child tests use private home, temp and
registry directories and a scrubbed environment. The normal 20-second test timeout,
60-second hang watchdog and current-invocation process ledger/leak scan apply to
both legs. Successful fixtures are removed; a failed pair prints its preserved
fixture location with test and leak evidence for inspection.

The required Linux CI job `seeded guards` follows the ordinary checks; it does not
repeat on macOS or run recursively inside `bun test`. The runner reports every
pair's elapsed seconds and the total runtime. Runtime measurement remains pending
until that gate executes; a green ordinary check alone does not prove these pairs.

The full CI gate tests the PR head tree on Linux and macOS, followed by the
sequential seeded-guard job. Main and release jobs reuse only a successful full
PR or push check with the identical Git tree and all three successful jobs. An absent or
unreadable result runs the main gate again and refuses release. A manual
`prepare_bundle` dispatch builds reviewable plugin assets without publishing;
it is never accepted as full-gate evidence.

## Preview initialization and native launch

Run `ahub init --dry-run --json` for action/path/reason metadata, including a
managed-block summary. The real init applies the same plan and preserves user text
and legacy symlink/hardlink safeguards. Preview creates no files or registration.

Use `ahub claude --print-command`, `ahub codex --dry-run`,
`ahub kimi --model <alias> --print-command`, or
`ahub pi --mode tui --print-command` to inspect launch JSON.
Environment values and arbitrary supplied values are withheld. Native-assigned
proxy/bridge endpoints and new session identity remain unresolved.
Claude and Codex previews include conditional `AGENTHUB_INSTANCE_ID` and
`AGENTHUB_LAUNCH_ID` environment names with unresolved reasons. Claude's existing
daemon identity is read at launch; a launch identity is allocated only after
verified Orca terminal readback. Codex identities are injected when that Orca
launch record is made. Preview neither reads those runtime identities nor
allocates them, and never displays their values. Pi's environment preview
continues to describe its native builder output.
These previews do not connect to the daemon, toggle permissions, record terminal
ownership, bind servers or start agents, sidecars or models.


## Native context readings and optional checkpoints

`ahub status`, `ahub tail` and the dashboard show native context occupancy,
source and measurement freshness. Claude readings come from the status-line
tee installed by `ahub claude`; Codex readings come from its current thread's
native token-usage updates. Pi and other unsupported surfaces show unknown.
A stale or disconnected reading is unknown, not 0%. Codex's accumulated session
usage is never used as context occupancy.

Context-triggered checkpoints are disabled by default. To enable them, add
this to `.agenthub/config.json` and restart the daemon deliberately:

```json
{"context":{"gate":0.85,"stale_min":30}}
```

`gate` is a fraction between 0 and 1; 0 disables checkpoint requests.
`stale_min` must be positive. A reading at or above the threshold records a metadata-only
event and console notice, then asks an attached Claude/Codex with active work
for a checkpoint when no checkpoint request is already outstanding. The request
supplies a `request_id`; include that id with
`hub_checkpoint {summary, request_id}`. Repeated high readings do not repeat
it until a fresh below-threshold reading or new session rearms the crossing.

The resulting non-private note is saved in the state directory as
`context-checkpoint-<peer>.json`, mode 0600; saving to shared memory is attempted
when memory is enabled. Its body is never broadcast. A private turn, an open PII
task held by the peer, or PII-pattern text prevents persistence and sharing.
Requests are bound to the current peer, native session and transport generation.
A new connection claim invalidates the old request before asynchronous recall or
attachment, even with an unchanged native session id. Requests also expire after
`budget.checkpoint_timeout_s` (90 seconds by default).
Quota pause and task handoff are separate; a context checkpoint neither pauses
nor hands work over. Continue normally or deliberately restart into a fresh
session with your chosen checkpoint as preface. No automatic restart or native
compaction override is performed.
