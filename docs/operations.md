# Operations guide

This guide describes ahub 0.12.21 and control protocol 16. Live verification
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

Tab toggles stream and panels; `ahub console --panels` starts in panels. A panel
screen has a header (the project's directory name, then the tabs), the panel and
a three-line footer, separated by ASCII `-` rules; the stream has one rule above
its footer. The active tab is bracketed, as in `[2 Approvals]`, so it reads
without color. The Approvals tab counts pending requests and the Queue tab
counts `needs_review` deliveries, in the attention and failure tones.

Peers, Approvals, Tasks and Queue are tables with a header row. A column is as
wide as its widest cell, up to a third of the terminal; the last column takes
the rest and is cut with `...`. In Tasks, TITLE takes the rest and the STAGE
meter keeps a fixed column at the right edge.

| Panel | Columns |
|---|---|
| Peers | PEER STATE MODE LINK Q ! REVIEW PAUSE QUOTA MODEL |
| Approvals | ID PEER LEFT TITLE |
| Tasks | ID STATE OWNER REVIEWER CLASS AGE TITLE STAGE |
| Queue | ID PEER STATE REV AGE |

The MODE column appears only when at least one peer has a non-`ask` mode.
Zero counters and unknown values read `-`. Durations read `45s`, `12m`, `3h05m`
or `2d03h`; quota resets and budget pauses read `in 2h13m`, and a pause by the
console user reads `user`. When a peer's status carries #205's optional
`toolsOnly` field (a Claude session attached without channel pushes), LINK reads
`tools-only`. Below the Approvals table, a rule and the selected
request: its title, its allow options numbered as `a` offers them, and `d deny`.
A title too long for the panel is marked `(more)` in the label column; Enter
shows it whole. `d deny` always shows; options that do not fit are counted on a
`(more)` line. The first request is selected when it arrives; `[` and `]` (or
j/k in the panel) select another. `a`, `d` and `v` act on the selected request
only: when it closes, the selection clears with a notice instead of moving to
another request, and a request that arrives later waits for `[` or `]`. Moving
the selection cancels a pending allow choice or confirmation; the choice prompt
names its request. Agent-written text below a field, and option names in
prompts, are quoted unless they are a single word starting with a letter, so
punctuation, a newline or a bare number in them cannot imitate the console's own
structure. Under the `?` key table only `?`, Escape and `q` act.

Arrow keys or j/k move, Enter opens a detail of labeled fields (relative times,
never JSON), Escape returns, and `?` shows the keys grouped by panel; in the
stream, `?` prints that table and `v` prints the selected request as its push
showed it. The footer's last line lists only the keys that act in the current
mode, panel and state. A notice shows on the footer's second line until the next
key or for about ten seconds: errors and refusals (a refused command, a request
error, the size refusal) in the failure tone, notices that only inform (a closed
or missing selection) in the attention tone. With a detail open, `p`, `r`, `m` and `a`
act on the item the detail shows. `:` enters a command; its output lines
start at column 4, as message bodies do. Assignment, delivery resolution, allow
decisions and a never-ask permission mode require confirmation; delivery resolution requires a reason. Tasks use the same public redaction as the board. Panels need at least
80 columns by 24 rows; smaller terminals stay in stream mode. Full task and queue reads run only in panels; stream progress uses the existing
status state counts and never fetches the board. Leaving restores
the terminal and returning from panels replays the bounded stream buffer.

The Tasks panel summarizes the whole public board with an approved/all fraction,
a 20-cell ASCII bar and state counts. Proposed tasks with unapproved or missing
`after` dependencies count as waiting; PII stubs count normally. Each task has a
four-cell stage meter (proposed, in progress, review, approved). Changes requested
returns to in progress and uses `!` plus the failure tone. Narrow panels retain
the fraction/bar before optional counts, which appear in fixed importance order:
changes requested, review, waiting, in progress, proposed, then unknown when nonzero. Narrow widths drop
only the suffix. Bar cells and percentages round down so open tasks never imply
completion. Stream `tasks N/M approved` lives on the approvals footer line, leaving the
peer/queue footer line intact. Operator notices or an already-full approvals line
take precedence over this optional count. A brief notice hides it only until the
notice's ten-second TTL expires, then the retained known count returns on redraw; the scroll
region starts at row 1 to preserve terminal scrollback. All existing status state
counts contribute to its total, including an unfamiliar state. Until a successful
status read it says loading; later failures preserve the prior count with a notice.
Panels retain their existing full-board refresh and loading/error handling.

The dashboard Task board shows the same shared public-board progress model,
including state counts, waiting, stacked segments and a labeled four-stage track
per row. Filtering rows does not filter overall progress. The existing signature guard
updates the live region only when progress changes. The stacked SVG fills the
section width; its text legend carries every state count. Theme offers System,
Light and Dark; it is applied before first paint and stored in a host-scoped loopback cookie
(`Path=/`, `SameSite=Strict`, one-year lifetime), shared across dashboard ports.
Blocked cookie access defaults to System on reload and never prevents operation. System follows
OS color preference through CSS. Both inline scripts and the style retain CSP
hashes; there are no external chart/theme assets. Live theme/readability inspection
is tracked in `docs/smoke.md` and remains unverified until performed.

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
| Metadata | Bright black | Ages, remaining approval time and rules |
| Stream peer names | Claude bright blue (94), Codex bright cyan (96); all others default | Fixed map, no hashing or themes |
| Stream `task` keyword | Magenta | Task event keyword |
| Stream numbers | Bold default foreground (1) | Percentages, durations and measured times |
| Stream issue references | Underlined default foreground (4) | `#232` |
| Stream task references | Magenta underlined (4;35) | `#1` following `task`/`Task`, `[task #1]`, `[review #1]` |

Offline peers, primary titles, action details and message body lines keep the
terminal's default foreground. Labels and prompts remain readable without
color. Stream styling applies only to meaningful tokens in the first line: peer names,
`task`, numbers and references. Ordinary words keep the default foreground.
Task prefixes and bracketed `[review #N]` identify task references
case-insensitively; prose `review #N` and other `#N` tokens are issue references. Legacy assign/which notices lack typed reference
ranges and use the issue tone until structured spans identify them. The dated
#239 palette reserves green/yellow/red for states, cyan for navigation and
blue/cyan for Claude/Codex. Tokens use plain magenta, underlining and bold default
foreground; no token SGR equals a state or peer SGR. The `task` keyword is never
bold. Only hub-written peer slots are colored, not title words or decline reasons.
State words and structural markers retain their event tone. Numeric-looking
identifiers stay plain. Wrapped headers normalize tabs before tokenization; plain headers preserve
their original tabs with color enabled or disabled.
A projection miss on the first physical header keeps only structural tones.
A missed continuation and every following continuation are fully plain; their
text cannot supply structural tones. Projection carries its span index forward
instead of rescanning earlier spans for every line. Bodies and command output stay plain. A local denial is shown as requested, not
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
resume, budget, queue, permit, permission, ask, remember, route, turns, undo,
check-path and report operations. It executes an argument vector with closed stdin. Lifecycle,
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
hooks enabled to measure completion and supervision usage. Your own
`--settings` (given once, a JSON object or file) keeps that observation: the
launcher adds the hub's hooks to its hooks and warns only that the status line
tee is off; one that sets `disableAllHooks` is refused. The launcher records its
private session identity in ordinary
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
how far the local worker's sandbox reaches, or how often a peer asks before it
acts (`kimi_cmd`, `permission_modes`, `codex_bin`,
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
matches a PII pattern (the summary also when `signals.pii_screen = "local"` did
not clear it); nobody else does. PII
tasks are left out on both sides.

A task can wait for others: `hub_task_propose` takes `after: [ids]` (`ahub task
propose ... --after <id>`). Until every one of them is approved, the task is
offered to nobody, cannot be claimed, accepted or marked done, and `ahub route
explain <id>` says what it waits for. When the last one is approved, the task
goes through assignment like a new one; if the hub stopped before it got that
far, the task is offered within a minute of a peer that can take it attaching
to the next run. An offer is used up only by an assignment, after an approval
and on the timer alike. If no peer can take it or a ready/assignment write fails,
the task stays eligible; the timer adds no history or notices while nobody can
take it.
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

Per peer and model route, `ahub report` also counts model changes between consecutive
decisions, how many of them landed inside tool loops and, with `stay_switch` on, sessions
and the planner's switches (#197). With `stay_switch = "off"` session boundaries are not
recorded; `shadow` routes exactly as `off` does, so it is the baseline to compare `enforce` with.
A route event records the decision, so a load-moved request that its MLX fallback served counts
as a change to `dgx/fast`; the relay's request journal records which backend served it.

`ahub report` counts the same overlap warnings as `scripts/overlaps.ts`, from the
structured events instead of log lines. `--by task` uses the task each usage and
token record was attributed to when it was written: the delivery that started the
turn, otherwise the peer's only `in_progress` task. Everything else is reported as
unattributed, and records from before 0.12.18 as a separate bucket; neither is
redistributed (rules: [events](events.md#per-task-usage-reports)).

## Research records

With `"research": { "enabled": true }` in `.agenthub/config.json` (off by default), the hub keeps one record per
approved task in `~/.agenthub/research/`, shared by every project that opts in: outcome, review rounds, rework, failed
checks, tokens and time per peer and model, never task or message text ([schema](research.md)).

```bash
ahub research --since 30d          # success, first-pass, rework and check-failure rates; tokens and wall time per task
ahub research --all --json         # every opted-in project on this machine
ahub research export --format csv  # the records, for your own analysis
ahub research backfill             # build this project's records once from events.jsonl
ahub task label 12 reverted        # a later verdict (ok, regressed, reverted, incomplete, wrong, abandoned)
```

## Benchmarks

In a git repository kept for benchmarks (`"bench": { "enabled": true }` in its `.agenthub/config.json`, a clean tree),
`ahub bench` runs a suite of tasks against the peers attached to its hub and compares configurations: pass rate, first
pass, tokens and wall time per attempt, with bootstrap intervals between arms. Each attempt resets the tree to the
task's commit, so never enable it in a project you work in. The project must be the root of its repository with
nothing tracked under `.agenthub/`, and the suite file lives outside its tree ([suite format and store](bench.md)).

```bash
ahub bench run ../suites/suite.json --arm baseline --repeat 5   # a person's: resets the tree, proposes the tasks
ahub bench status                                     # the run in progress
ahub bench compare baseline ripwire-on                # arms side by side, inconclusive below 5 attempts each
ahub bench export --format csv
```

The dashboard's Benchmarks section shows the latest runs and, per suite with two or more arms, the comparison.

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
  its `--settings` next to the status line tee (a `--settings` of your own keeps
  them, added to its own hooks, and loses only the tee). Codex gets context by
  steer into its running turn. Until a fact or a
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

## Permission modes for running peers

Use a plain terminal to inspect or change a running peer:

```bash
ahub permission
ahub permission local ask-when-needed
ahub permission kimi never-ask --yes
ahub permission kimi ask
```

In the console Peers panel, `m` opens the three modes. Never-ask requires `y`,
even for a typed command carrying --yes. Its confirmation says whether the peer
uses its own tools outside the hub sandbox (Kimi), the hub sandbox/path guard/
denylist (Pi and local), or native vendor boundaries (Claude and Codex).

| Peer | ask-when-needed | never-ask | ask |
| --- | --- | --- | --- |
| Kimi Code CLI | ACP yolo | ACP auto | ACP default |
| Codex | on-request for every outgoing turn/start | never for every outgoing turn/start | Restore the known native policy once, then stop overriding |
| Claude | Allow resolving project file tools outside .agenthub/.git/.claude/.codex/.qwen/.kimi/.pi/.mcp.json | Hook allow for every tool | No hook decision |
| Pi and local | Grant write/edit outside native agent configuration paths; read never asks; shell/git writes ask | Grant each tool once within the existing sandbox/guard | Normal approval handling |

Kimi's map applies only to the actual Kimi Code CLI identity, not another ACP
agent configured in kimi_cmd. Qwen and other ACP agents start fresh/resumed
unmanaged without mode changes or mode-based startup refusals; runtime changes
are refused until their own map exists.
A set_mode timeout leaves the peer offline with mode unknown; inspect and
restart before using it. Missing ids and refused startup changes name the mode.
The benign Kimi live check verifies file edits and harmless shells in both
modes without requests; risky-action behavior remains unverified.

Claude's hook is installed in every managed launch. File grants use canonical
real paths under the authenticated project root. Missing targets, symlink
escapes, metadata directories and uncertain wildcard targets leave the native
rules in charge. Grep/Glob path-bearing filters cannot bypass the exclusions.
Other tools retain native decisions, which may already allow a harmless shell.
Permission-only PreToolUse never marks Claude busy; former observation hooks
retain their native-turn role. Settings are passed as a 0600 state file retained
until that native launch exits. Live/unknown previous launchers keep their files;
verified dead wrapper and native identities permit crash cleanup. Without
separate native identity proof, old settings remain for manual inspection. Settings carry
no inline caller values in argv. Status reports an unverified Claude hook as
unverified. Unattended native sessions cannot take a runtime mode; restart
without that native flag. Codex must be behind the hub proxy, and returning to
ask requires a known native approval baseline. An offline or absent peer accepts
`ahub permission <peer> ask` to clear its hub choice. Codex --unattended launch
is refused under a non-ask choice; clear it with `ahub permission codex ask`
first. A pending never-ask default cannot be confirmed for an unattended launch.

Project defaults use permission_modes in .agenthub/config.json or
.agenthub/config.local.json. Keys merge per peer; a local ask overrides the
same peer's earlier default, while an empty local block preserves it. Every
non-ask default start logs its mode and contributing filename. Automatic
config effects stop at ask-when-needed. Git-tracked defaults are ignored and never
offered for confirmation. Never-ask from an applied untracked file starts in ask
and appears as a pending source-labelled console question at hub start.
Only its separate console y enables that default; there is no boot --yes
bypass. Only explicit n declines and keeps ask for that hub. Esc defers without declining
and leaves approval keys usable; a refused y is not reoffered until its state changes. A successful runtime change removes that pending default. Runtime choices expire when the hub
stops, and a later restart asks again for a never-ask config default.

The CLI marker and console-role checks are operating policy, not a hostile-agent
boundary. An agent able to run unrestricted shells may clear its markers,
use --yes, or read the control token and act as the console. Hub tools,
conductor operations and ordinary agent messages have no direct mode-changing
or startup-confirmation operation, but those checks do not contain such a
shell. Review the boundaries in [security](security.md) before choosing a mode.
Modes never alter native sandboxes, hub path guards or denylists.

Permission mode starts reconcile the current operator choice after native startup before bus delivery. Each non-ask start logs the mode and its config or runtime source. Dropped git-tracked defaults never appear as startup confirmations. Non-Kimi ACP peers run unmanaged, preserving their native fresh/resumed mode; permission commands refuse changes until a vendor map exists.

Status shows non-ask modes and pending defaults, and each runtime change emits
permission_mode (peer/from/to) with no tool arguments under events schema 1.
The optional control requests preserve PROTOCOL; an older hub answers unknown
and the CLI advises upgrading.

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
notification that names the peer and, for Kimi and the local worker, the tool,
never what it would run. An unanswered request is cancelled after `approvals.timeout_s` (default
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
A refused or failed resolution puts back only that peer's queue and preface
and keeps every pause, including budget and conductor holds. A storage failure
stops the bus; a validation refusal leaves it running under the existing holds.
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
allowed to block state cleanup. A managed Pi tool that does not settle within
the stop grace does not block the teardown either: the stop goes on
(shutdown, owner teardown, process stop) and reports the failure at the end.
A native Pi TUI owner that does not exit
gracefully is terminated by its verified process identity (never a bare PID),
so a restarted hub never launches beside a survivor. A hub whose project root
or state directory was deleted stops itself within about 10 seconds; the
dashboard manager does the same when its home directory vanishes.

## Resetting a project's hub

`ahub reset` returns a project's hub to a clean state. Without `--yes` it is a
dry run: it lists what it would settle, clear, archive and keep, by delivery
id, peer name and count, never task or message text, and changes nothing.
With `--yes` it first stops a running hub the way `ahub kill` does, then acts.

```bash
ahub reset              # dry run, runtime scope
ahub reset --yes        # runtime reset
ahub reset --all        # dry run, full reset
ahub reset --all --yes  # full reset
```

The runtime reset (the default):

- discards every `queued` and `needs_review` delivery with reason `reset`
  through the delivery journal, one `resolution_history` entry each. Work
  that was dispatching or accepted when the hub stopped is held as
  `needs_review` first, so it is discarded too;
- clears manual peer holds (`ahub pause`), budget pauses and conductor holds;
- drops the agent session resume pointers `sessions.json`,
  `claude-session.json` and `claude-context.json`, so the next launch starts
  new agent sessions. Pi transcripts under `pi-sessions/` stay;
- removes the manifest (`status.json`, `control-token`, and `hub.pid` from a
  hub of 0.12.20 or older) a hub left when it did not stop cleanly, once no
  process behind it is alive (a pid that now belongs to another process counts
  as gone when the manifest carries the hub's signature, from 0.12.21);
- keeps the board (tasks, reviews, outcomes, turns, touches), `hub.log`,
  `events.jsonl` and `cli-audit/`, recovery records, execution budgets,
  configuration and files the hub does not own.

The full reset (`--all`) moves the whole state directory, unchanged, to
`.agenthub/archive/state-<UTC time>/` (mode 0700) and starts an empty state
directory holding only `project.json`, so the project keeps its id and
registration; the next `ahub up` starts with an empty board and queue.
`.agenthub/config.json`, `config.local.json` and `routing.toml` live outside
the state directory and are not touched. The archive keeps the task text,
PII included, so it stays in the project: the reset writes
`.agenthub/archive/.gitignore` (`*`) so git ignores it, and the local
worker's and Pi's denylist (file tools, sandbox, memory capture) covers
`.agenthub/archive` as it covers `.agenthub/state`. Turn snapshots leave the
archive out as they leave the state out. Nothing deletes or prunes
archives; removing one is a manual act.

To restore an archive, stop the hub, move the current state directory into
the archive too (where git and the local worker's denylist cover it), then move
the archive back:

```bash
ahub kill
mv .agenthub/state .agenthub/archive/state-$(date -u +%Y%m%dT%H%M%SZ)
mv .agenthub/archive/state-<UTC time> .agenthub/state
ahub up
```

Only a person runs `ahub reset`: an agent shell is refused before anything
happens, as for `kill`, `restart` and `upgrade`. It is refused, with nothing
changed:

- while an upgrade or recovery operation is open (the machine's recovery lock,
  or a running hub that reports an unreleased recovery);
- when no registration matches this project and state directory. A running
  hub must then be stopped with its matching CLI; a stopped project is
  registered again by `ahub up` (then `ahub reset --yes` stops it first). When
  the project is registered with another state directory, the error names
  `ahub --project <id> reset` instead;
- when the hub's ownership cannot be verified, as `ahub kill` refuses it;
- for `--all`, when the state directory is not `<root>/.agenthub/state`
  (`AGENTHUB_STATE_DIR` or a symlink elsewhere): archive such a directory by
  hand after `ahub kill`;
- for `--all`, when `.agenthub/archive` is a symlink or not your own
  directory, or its `.gitignore` is not a regular file: anything with write
  access to the project could otherwise send `hub.db` out of it. Inspect and
  remove what is there, then run the reset again.

After stopping the hub the reset holds the project's registry claim, the one a
daemon takes to run, until it is done, so no hub starts under it; a hub that
started in between makes it stop with nothing reset; a crashed hub's leftover
manifest does not count as one. If a step fails after the stop, the error says
how far it got: rerun `ahub reset --yes` to finish a runtime reset (every step
can run again), unless the error says the state cannot be read (a damaged
`hub.db` or journal fails the same way every time): `ahub reset --all --yes`
archives such a state directory as it is. A full reset names the archive once
the state directory has moved.
It never touches claude-mem: notes saved with `hub_remember` are shared memory,
not hub state. Claude Code sessions attached to the hub lose their hub session;
relaunch them with `ahub claude`.

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
11 (0.12.1 and 0.12.2), 12 (0.12.3), 13 (0.12.4 through 0.12.15), 14 (0.12.16), 15 (0.12.17 through 0.12.19) or 16 (0.12.20 and 0.12.21), and only
a target on its own protocol, so the target's coordinator fits every supported
source and carries every recovery fix released up to it. Protocol 8 and older
(0.5.x and earlier) are refused as `manual-bootstrap-required`. Run from the
project directory, without replacing the global CLI first:

```bash
bunx --package @staix/agent-hub@0.12.21 ahub upgrade --to 0.12.21 --dry-run
bunx --package @staix/agent-hub@0.12.21 ahub upgrade --to 0.12.21 --yes
```

| Running now | Coordinator to use |
| --- | --- |
| 0.6.x (protocol 9) | the target's, through `bunx` as above |
| 0.7.0 through 0.12.0 (protocol 10), 0.12.1 and 0.12.2 (protocol 11), 0.12.3 (protocol 12), 0.12.4 through 0.12.15 (protocol 13), 0.12.16 (protocol 14), 0.12.17 through 0.12.19 (protocol 15), 0.12.20 and 0.12.21 (protocol 16) | the target's, through `bunx` as above |
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
ahub upgrade --to 0.12.21 --dry-run
```

Apply only after reviewing the plan:

```bash
ahub restart --yes
ahub upgrade --to 0.12.21 --yes
ahub recovery status <operation-id>
ahub recovery resume <operation-id>
ahub recovery abort <operation-id>
ahub recovery dispose <operation-id> --fresh-session <peer> --reason <text>
ahub recovery dispose <operation-id> --stop-and-archive --reason <text>
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
A Claude session that `ahub claude` did not launch in a recorded Orca terminal
(a plain `claude`, or one whose launcher has ended) is planned as
reconnect-only: the plan lists it under `reconnectOnly`, and the command prints
`<project>: claude is reconnect-only` on stderr. Nothing in its terminal is
closed or relaunched, a `claude-session.json` left by an earlier launch is never
used as its target, and the plan does not show that record's id. Its plugin
reconnects to the new hub by itself (the coordinator waits up to 90 seconds) and
keeps the plugin version it started with until that Claude session restarts.
The target release must read recovery waivers; staging refuses one that does
not, before any runtime changes. Across a control-protocol change it cannot
reconnect; the plan then names a
blocker: end the session, or relaunch it with `ahub claude` in Orca, and make a
new plan. A refused `--yes`, and every dry-run, prints each blocker on its own
`ahub: blocker:` line before the final one.
Previously stopped projects stay stopped; only the reviewed running projects
are upgraded.

Do not run an upgrade with an incompatible active protocol, an unverified
terminal binding, or an unresolved operation lock. Dry-run performs no package,
plugin, daemon, or terminal mutation.

### A partial operation

`ahub recovery status <operation-id>` reads the receipt without changing it:
its phase, step and error; `runner`, which says whether a runner process holds
the operation now (`running` with its pid, or `none`; `stale` marks a receipt
that says running with no runner behind it); each project's phase and effect
receipts (`closed:<peer>`, `restored:<peer>` as `done`, `pending` or `failed`);
whether the shared plugin and the global CLI were installed; and `next`, the
commands that apply now, read from every source the operation has not stopped
yet (every error of `resume` ends with the same list). `resume` is left out
when it can never get past: a source replaced by another instance, or a
prepared source that stopped before any commit request. It shows no task or
message text. `resume` does not
start a second runner while one is alive. Every `next` entry and error names the
operation's own coordinator, `bun <preserved source>/src/cli/main.js recovery
...`: in the middle of an upgrade the global `ahub` may still be the older
release, whose `recovery` lacks these commands. Copy that command line. When
an older coordinator started the operation, `dispose` is named from the running
release, which has it. What
each receipt allows, given what is live, is tabulated in the recovery spec
(`docs/specs/2026-09-20-upgrade-recovery-design.md`, "Receipts, evidence and
next actions").

- The source hold lapses after 10 minutes. A later `resume` prepares the same
  source again and checks its peers again, keeping the receipts, so no terminal
  is closed twice. It refuses, naming the next step, when the source daemon was
  replaced, when another operation holds it, or when a peer changed: a peer whose
  terminal the operation closed must stay closed, a session that joined since
  must end, every other one must keep its conversation. With nothing closed yet,
  `abort` cancels the operation (also once its hold has lapsed, or when another
  daemon or operation holds the source, which it leaves alone) so a new plan
  can be made, also after a source crashed before any commit was requested
  (`resume` then stops, as there is nothing to start from, and names abort, or
  stop-and-archive once anything was done); it
  refuses while a prepared source cannot be read (its hold may still stand),
  once a commit request may have been sent (or, for an operation from
  an older coordinator, which records no such thing, while a prepared source is
  not running), and once any project has effects the way out is
  stop-and-archive. `next` offers abort only where abort would succeed, and
  `resume` (and `--fresh-session`, which resume carries out) only where it can
  get past what is live: not past a replaced or missing source, a source that
  crashed before any commit request, a refusal at staging (the target release
  or the preserved source can never change back), a hub of another control
  protocol, a target that stopped after it started when the operation's
  coordinator is older than 0.12.21, or a stopped hub without the operation's
  restart snapshot.
  A second `resume` while its own hold still stands checks the peers again
  before it closes anything.
- When a target hub dies after it started (a crash or a reboot), `resume`
  starts it again from the operation's snapshot while the project's state
  directory still holds it: it records the restart (status shows `restarts`),
  closes the terminals the dead hub's peers were restored into (or finds them
  gone), and relaunches those peers against the new hub, a session you had
  accepted instead of the original included. A launcher still running from
  the dead hub, or a session attached without an id, stops it until you end
  that session. A target that dies again in the same `resume` stops it with the
  restart count; look at its `hub.log` before resuming again. Without the
  snapshot, or for an operation started by a coordinator older than 0.12.21,
  the way out is stop-and-archive.
- A Codex conversation comes back only when a rollout file naming its thread
  exists under `sessions/` of the store the restored terminal uses (the
  recorded `CODEX_HOME`, else `~/.codex`). Codex writes that file with the
  first message, so a thread the hub saw Codex start, with no turn on it since,
  is listed under `freshStart` and restarts as a new session, with nothing to
  lose; the command says so. A thread with turns, or one whose start the hub's
  log does not show (it was resumed, or the hub is older), blocks the plan when
  it has no rollout, and so does a store that cannot be read (unknown, not
  missing). The coordinator checks again before closing the terminal and before
  creating the new one. To continue without such a conversation, end that Codex
  session and close its Orca terminal, then `resume`; it stops at restoring
  Codex, where `--fresh-session codex` below is the way on.
- A restored terminal runs its launch in a login shell, so the coordinator
  watches the launcher, not the terminal: once `ahub codex`, `ahub claude` or
  `ahub pi` has recorded itself there and its process is gone, or Orca no longer
  lists that terminal at all, the restoration failed (found within one 5-second
  wait). A launcher whose process cannot be read counts as running, never as
  gone. One that dies before recording itself leaves no record to read, and
  what happens next depends on whether Orca reports the bare login shell it
  returned to as TUI-idle, which is not verified. If it does, the coordinator
  stops at once with "original session restoration needs manual verification"
  (the terminal cannot be mapped to the session). If it does not, it stops with
  the same error after the 10-minute wait. Either way the receipt stays
  `pending`; close that terminal in Orca (or wait, if the session may still
  attach), then `resume`: with no live launcher and no attached session it
  records `restored:<peer>` `failed` and lists the failed-restoration choices.
  A `failed` receipt never counts as restored.
  `resume` settles a `pending` or `failed` receipt by what is live: the planned
  session attached is the restoration, a launcher still running is waited for,
  and no second terminal is opened while one may run. A target hub that cannot
  be read counts as unknown, never as "nothing attached", and so does a launcher
  record file that cannot be read: `resume` then stops without changing any
  receipt; when the record file is what cannot be read, inspect it and move it
  aside, then `resume`. A record file that parses but holds a row that cannot
  be evaluated (a hand edit, a damaged or a future layout) is read the same way
  for the peer that row may belong to, and `ahub codex`, `ahub claude` and
  `ahub pi --mode tui` write such rows back unchanged: fix or remove that row,
  then `resume`. A launcher recorded by 0.12.12 or older is read with its own
  unpinned signature too, so it counts as running when this command runs in
  the same time zone and locale as the launcher did. `resume` is refused while a stop-and-archive is partway. A lifecycle command refused by the lock names
  the operation's own `status` command, which lists what to do next.
- `ahub recovery dispose <operation-id> --fresh-session <peer> --reason <text>`
  applies to a Codex or Claude peer whose restoration failed (Pi is refused: a
  restored hub resumes Pi's recorded session). It records the lost session or
  thread id (status shows it under `lostContinuity`) and resumes: the peer
  starts without its old conversation, and the rest is verified as usual.
- `ahub recovery dispose <operation-id> --stop-and-archive --reason <text>`
  abandons the operation. It checks every project first and refuses while a
  hub is unreachable, starting, stopping or of another control protocol; `next`
  then says `wait until <project>'s hub settles, then ... recovery status
  <id>` instead of offering it. A hub that never answers (its pid is alive,
  nothing replies): take the `pid` from that project's
  `.agenthub/state/status.json`, check with `ps -p <pid> -o command=` that it
  is that project's hub daemon, end it by hand, then run `status` again. From
  0.12.21 a hub's manifest and registry claim and a runner's record carry the
  owner's process signature, so a pid that a reboot handed to another process
  reads as gone by itself. Records written by 0.12.20 or older carry none and
  are judged by their pid alone: if that pid now belongs to another process,
  move the stale `status.json` and `hub.pid` aside together (with only one of
  them gone the other still reads as an owner), then run `status` again;
  likewise when `next` says `wait: runner <pid>` and that pid is not an `ahub
  recovery-run` process, move the operation's
  `~/.agenthub/recovery/<id>.json.runner.db` aside, then run `status` again.
  An unsigned registry claim of such a hub, whose pid now belongs to another
  process, still reads as starting, and no command clears it: after `ps -p
  <pid> -o command=` shows that the process is not an `ahub ... daemon` of that
  project, clear it with `sqlite3 ~/.agenthub/registry.db "UPDATE projects SET
  instance_id = NULL, pid = NULL, claimed_at = NULL WHERE id = '<project id>'
  AND pid = <pid>"` (`ahub projects --json` shows the id). A
  project whose directory is
  gone is only recorded (`ahub doctor --orphans` lists a hub left running
  there). It records its decision before it acts. It releases a source hold of
  its own (that hub keeps running), stops a target hub it started and has not
  released (one an older coordinator started is stopped at that release's
  control protocol), moves that operation's
  `restart.json` aside as `restart.abandoned.<hash>.json` and leaves any other
  hub running; only then is the operation recorded `cancelled` and the lock
  released. If it fails partway it keeps the lock, records what it did, and
  `resume` refuses until you run it again. Once a stop-and-archive is recorded,
  only the command `next` names continues it. On an operation whose
  coordinator predates these commands it also marks the receipt `schema: 2`,
  which every older release refuses before it acts: an older global `ahub
  recovery resume` still prints "scheduled", but its runner exits without
  touching the operation, and an older `ahub recovery abort` refuses with
  "unsupported operation receipt". Queued messages are not delivered
  from the archived file; a 0.7.0 or later hub reloads the queues it kept in
  `hub.db` when it starts again. Terminals it closed stay closed: start those
  sessions again by hand. Replacement terminals it opened stay open but have
  no hub: Claude's plugin reconnects once a hub runs, Codex needs `ahub codex`
  again.
  Start a project whose target ran with that release's CLI (`bunx --package
  @staix/agent-hub@<version> ahub up`), since it may have changed the task
  database. The global CLI was not promoted.
- Both choices are for a person in a terminal; an agent shell is refused, and
  the reason is kept in the operation's audit. Run each with the command
  `next` or the error prints: the operation's own coordinator, or the release
  you are running when that coordinator predates these commands (its `resume`
  still runs the old runner, and `next` says what that runner cannot do).
  `--fresh-session` never applies to such an operation: its runner never
  records a restoration as `failed`.
  `--fresh-session` is not offered when the target release cannot read recovery
  waivers, since it could never release a new session; `status` says so in
  `freshSession`. A runner record that cannot be read shows as `unknown`, and
  `resume`, `abort` and `dispose` are refused until it can be read.

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

Session-aware stay/switch (#197) covers `hub/auto` and `stage` routes. The top-level
`routing.toml` key `stay_switch` is `off`, `shadow` (default: route events record what the
planner would do, routing unchanged) or `enforce`. Enforced, a hard override (compaction,
critical failure, repeated failure) escalates at once; a tool-result turn keeps the
session's tier; other changes wait for the next user turn, and a de-escalation whose
conversation is larger than `max_switch_prefill_tokens` (default 32000) stays; a PII route
has no such bound, so its size never shows in a decision. A capable
hold then lasts at least until the next user turn; `hold_turns` can extend it past that
turn. A tier whose backend
cannot hold the conversation is never chosen; no route summarizes or trims the history.

Pi exposes `hub/auto` for stage routing when available. Fixed `dgx/coding`, `dgx/fast`
and `mlx/fast` aliases still pin the backend. Automatic MLX selection admits the complete
input, tool schemas and requested output within the configured context window.
A `hub/auto` request bound for MLX has two candidates, MLX and its `dgx/fast` fallback; load
and cooldowns only change their order, never remove one (#199). A fixed alias (`mlx/fast`,
`pi_backend = "mlx"`) keeps its backend first as before. `dgx/fast` goes first when MLX is
cooling down (route event `source: "cooldown"`). Load moves are opt-in until they are
measured: with `[pi] efficient_wait_ms` set (0 to 119999; 0 tries once; read when the hub
first starts Pi, like `dgx_max_context_tokens`, so a change takes a hub restart), a request
whose MLX slot is still busy after that wait goes to `dgx/fast` first (`source: "load"`), and
so does an enforced tool loop pinned to it (`source: "pin"`); without it nothing moves for load. `dgx/fast`
never goes first while it is cooling down, or while its own last dispatch failed in any way,
an error status or a failed stream included, until it succeeds or 30 s pass (`ahub status`:
`last dispatch failed, no load moves until ...`). No load move or pin happens while the request
runs under an execution budget, and enforced, a load move happens only at a user turn. A moved
attempt gets 15 s to its response headers after the gateway lookup (OmniRoute's own probe,
up to two 4 s rounds when no gateway is cached) and is then abandoned for MLX, which serves
with the usual slot wait. The bound ends with the headers: a stream that stalls or fails
after them is not retried on MLX, and a failed one marks `dgx/fast` failing (a client that
disconnects does not). Each backend is tried once per request, so with moves on, a moved attempt
cut at 15 s followed by an MLX slot that stays busy past 120 s fails the request (502), where
without moves the request would have waited for MLX and then had `dgx/fast` with its full
deadline; this is part of what the opt-in accepts until #199 AC5 measures it. After three
consecutive transport or startup failures outside a cooldown (a failure more than 10 min after
the last counted one starts the count over), a relay alias cools down for 30 s, doubling up to
5 min. A busy MLX slot and timeouts cut short by an execution budget never count; any HTTP
answer, a success or an error status, proves the transport works and ends the streak and the
cooldown. `ahub status` shows `cooling down until ...` on the backend line and `events.jsonl`
records `cooldown` events.
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
`--settings` keeps them: the launcher adds the hub's hooks to the caller's and
warns only that the status line tee is off.

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

## Pi tool refusals, exit causes and idle automatic restart

Pi hub-task/conductor refusals proven before any task or board effect return
their original `error:` text and are recorded as completed tool receipts.
PII screening and its telemetry record may precede the refusal. An uncertain
post-effect or storage failure remains pending: inspect it before repeating an
action. Old pending receipts carry no proof of a past refusal and stay pending
across startup. Conductor assignment and escalation entry checks explicitly opt
into refusal typing; internal escalation after a saved review remains generic.

Pi exit records show code or signal, turn/tool activity, whether teardown was
expected, startup status, and the last tool's name without arguments. An
unobserved native-terminal exit records unknown OS status. The console notice
gives the next action, usually `ahub pi`, or says why automatic start is held.
A replacement says the owner stopped for a new Pi owner, including when the
replacement is refused. Internal failure teardown directs session inspection
rather than claiming a person requested it. Replacement, failed-start and
active-turn guidance appears before automatic-start-disabled guidance.

With `pi.auto_start`, an unexpectedly idle headless Pi is resumed on its
verified persisted session once. The 60-second retry window rearms when the
attempt settles; a second exit inside that window stays offline. Missing or
invalid session history has no fresh fallback; inspect it before running
`ahub pi`. Active turns/tools, failed startup, a superseded owner, native
terminal exits, requested shutdown and recovery operations suppress this
restart. Crash recovery's #66 recorded-session/fresh-start choices are unchanged.

### Pi/local unanswered approvals

An expired Pi/local request says "approval expired: no person answered". The
worker must not retry that call; hand the task off or stop. Two consecutive
unanswered requests end the current turn and produce a console notice. An
expiry counts only when no person answered a request of that peer while it
was pending, so a batch of parallel requests does not stop a worker whose
person is answering; a grant served from the always-allow cache or a permission
mode is not an answer and does not reset the count. A new turn also resets it. The turn ends
through the same abort path an execution-budget stop uses: Pi stays attached
and the sender is told the approval reason. Supported Pi and local settle that
delivery after reporting the reason, so the next queued message runs without
an operator release. Pi clears turn-only approval state at settlement; the
person's idle `!command` remains usable and a later failure keeps its own reason.
A Pi whose extension cannot abort
a turn (an older hub extension or a runtime without native abort support) goes
offline instead. Inspect prior work, restart with `ahub pi`, find the held
delivery with `ahub queue list --peer pi`, inspect it with `ahub queue show <id>`,
then explicitly settle it with `ahub queue resolve <id> --action completed|retry|discard --reason "<text>"`.
A cancelled tool withdraws
its request immediately; a later `ahub permit` answer is refused and cannot
create an always-allow grant. Tool requests from a previous turn or an older
extension missing session/turn identity are refused before execution; restart
Pi with the current hub extension rather than retrying that old call.

The dashboard shows the number of waiting Pi/local requests and where to
answer them. It remains deny-only for those private rows. Use the console or
`ahub tail` to inspect the request, then `ahub permit` to answer it. Recovery
stops waiting for an approval when that request is withdrawn.

A person's `!command` in the managed Pi TUI runs through the managed sandbox
without asking for another hub approval. Its reported exit code comes from
the process, including a nonzero exit; text printed by the command does not
set its status. This exception requires the current idle TUI owner's reserved
request and does not apply to model-origin bash calls.
