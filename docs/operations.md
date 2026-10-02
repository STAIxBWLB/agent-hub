# Operations guide

This guide describes ahub 0.12.4 and control protocol 13. Live verification
results and remaining prerequisites are recorded separately in [the smoke ledger](smoke.md).

## Install and start

Use Bun 1.3 or newer. Install the released package and install its Claude
channel plugin:

```bash
bun add -g @staix/agent-hub
ahub setup
cd <project>
ahub init
ahub up
ahub tail
```

`ahub init` writes the project configuration and managed instruction blocks.
Run it after an upgrade when those blocks need refreshing. `ahub setup`
updates the shared Claude plugin. Keep `ahub tail` open when a local worker
may request an approval.

`.agenthub/config.json` can be committed and shared. The fields that choose
what the hub runs, which files it sends as credentials, where task text goes,
or how far the local worker's sandbox reaches (`kimi_cmd`, `codex_bin`,
`pi.cmd`, `checks`, `mlx.bin`, `mlx.runtimeDir`, `mlx.modelPath`, `omniroute.urls`,
`omniroute.access_hosts`, the `omniroute` key files, `memory.worker_url`,
`local.read_allow`, `local.bash_network`, `local.network_allow`, `local.sandbox`) are machine-local:
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
unmet (`hub_review` takes `unmet`, `ahub review ... --unmet <item>`). The hub
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
already exist, so they cannot form a cycle. A waiting task cannot name an owner;
use `ahub task assign` once it is ready. An owner offline longer than `tasks.release_after_min`
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
ahub export --since 24h         # the raw events as JSON lines, for your own analysis
```

`ahub report` counts the same overlap warnings as `scripts/overlaps.ts`, from the
structured events instead of log lines.

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
  it stops being silent when an owner without a verified path joins or a path
  is lost, and every member is told it may message again.
- Verified context path. A hub-launched Claude session (`ahub claude`) gets the
  hub's hook before and after every tool call and at the end of each turn, in
  its `--settings` next to the status line tee (a `--settings` of your own turns
  them off). Codex gets context by steer into its running turn. Until a fact or a
  one-line probe has been read back, the peer counts as unverified: for Claude
  the row Claude Code writes in its transcript for the hook's additional
  context, matched by tool use id and the offer's id; for Codex the steered
  input coming back as a user message item of the turn. A new native session,
  the peer going offline, or three offers past a minute without a readback,
  makes it unverified again; a peer without a verified path that left three
  offers unread gets none until a readback arrives. Kimi, Pi and the local
  worker have no path yet, so a cohort with one of them is never silent.
- Silence. While a cohort is silent, an agent message from a member to another
  member is held back for that recipient only: other recipients and the console
  get it unchanged, and `events.jsonl` records a `quiet` event. `hub_send`
  answers `not delivered to <peer>: ...` (or `sent to: ...; not delivered to
  ...` when some recipients got it); a native turn answer's sender hears it on
  its next delivery. Workflow messages from the hub are never held back. A
  member's messages stay held until its native turn has ended after its task
  closed (Codex's turn completes, or Claude's Stop hook runs), so a late answer
  is still the cohort's; its next turn is new work. Only a tool call starting
  counts as activity after a turn end.
- Facts. At each tool call (Claude) or completed tool item (Codex) of a cohort
  member with an open task, the hub offers what changed since it last
  acknowledged them in the files every member's task names and in the files it
  touched, with the other members' new plans; the last member still at work
  keeps the others' files after they finish. A directory a task names stands for
  git's changed, new and deleted files under it (200 at most). A change is credited to an agent
  only with effect evidence: a Claude Edit, MultiEdit or Write whose result is
  exactly its input applied to the file as observed before it, or a Codex patch
  whose diff is exactly what changed. Shell commands, concurrent writers and
  unreported changes are shown with their attribution unknown, never credited by
  elimination; an agent's own verified writes are not shown back to it. A Codex
  read action never counts as having seen a file (it may be partial); a whole
  Claude Read does. Only an acknowledgement (a readback, or the next
  `hub_task_done` for facts sent with an integration request) moves the peer's
  view, so a fact that does not arrive is
  offered again at a later boundary; no turn is ever started for one. An
  acknowledgement says the context reached the native session, not that the
  model read it. 60 changed lines are shown at most, the cut files named; a
  history longer than the hub keeps is shown with its attribution unknown, and a
  file that falls out of the 64 a peer touched is named once. Only regular files
  of 256 KB or less inside the project are read, re-resolved at every read and
  opened without following links; larger ones are named without a diff. Facts never go through the bus or the delivery journal;
  `events.jsonl` records `fact`, `fact_ack` and `capability` events with bytes
  and latencies.
- Integration. A member's `hub_task_done` is a completion intent. The member
  whose intent completes the set is asked, as its done result, to check its work
  against the others' (their files, signatures and summaries, plus its own facts)
  and to call `hub_task_done` again; nothing is recorded as done yet. The next
  call counts only for the same target: the same owner, cohort revision and
  files, with every other member's native turn ended after its done. Edits in
  between, a new member, an owner change, a failed check or a reopened review ask
  again; a done within two seconds of a request is taken as a retry and gets the
  same request again; after three requests the done is recorded with
  `integration unresolved`, never as integrated. A configured check of the integrating member
  counts only for the target it confirmed. After a hub restart an open request is
  recorded as unresolved. Inside a silent cohort a member's completed-change
  notice is held, not sent; where no integration step runs for the others (the
  silence was lifted, a PII task opened, the console finished the task), the
  held notices go with the lift notice or the done result, or to the console.
  Open tasks outside the cohort get their notices as usual.
- While any PII task is open the project behaves as advisory: no facts, no
  silence and no integration step. When it closes, the hub forgets what it had
  observed, so nothing changed meanwhile is shown as a diff; each member is told
  which of its files to read again.
- `ahub check-path` asks the hub whether the owner of the claimed path shares a
  silent cohort with the caller, and only then leaves out the request to settle
  by message. `templates/claude-hooks.json` holds only the check-path hook; the
  facts hooks need a hub-launched session.
- Routing does not change. For a routed task that overlaps another owner's open
  task the hub records a shadow split prediction (`split` event; `ahub route
  explain <id>` shows its trace): whether splitting two equal units between the
  two peers (`o_s + u_s < o_f + 2u_f`) would finish sooner than the faster one
  alone, from this hub run's recorded task stages. It is unknown unless the units
  are equal and known, both peers are available with no other open work, and each
  has five measured tasks with no more than 30% failures and comparable work
  times. The work stage of a task ends at its first `hub_task_done`, and the
  routed task itself is never one of its own observations.
- `"experiments": {"stale_notices": "deliver"}` in `.agenthub/config.json`
  turns the stale-notice drop off, for a controlled comparison only (the #106
  ablation in `docs/cooperbench.md`); the hub logs it at start.

## Approvals and pauses

Inspect permission requests in the terminal:

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
or 11 (0.12.1) and only
a target on its own protocol, so the target's coordinator fits every supported
source and carries every recovery fix released up to it. Protocol 8 and older
(0.5.x and earlier) are refused as `manual-bootstrap-required`. Run from the
project directory, without replacing the global CLI first:

```bash
bunx --package @staix/agent-hub@0.12.4 ahub upgrade --to 0.12.4 --dry-run
bunx --package @staix/agent-hub@0.12.4 ahub upgrade --to 0.12.4 --yes
```

| Running now | Coordinator to use |
| --- | --- |
| 0.6.x (protocol 9) | the target's, through `bunx` as above |
| 0.7.0 through 0.12.0 (protocol 10), 0.12.1 and 0.12.2 (protocol 11), 0.12.3 (protocol 12) | the target's, through `bunx` as above |
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

Once the installed CLI is 0.12.0, review the current project or all registered
projects first:

```bash
ahub restart --dry-run
ahub upgrade --to 0.12.2 --dry-run
```

Apply only after reviewing the plan:

```bash
ahub restart --yes
ahub upgrade --to 0.12.2 --yes
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
