# Operations guide

This guide describes ahub 0.20.0 and control protocol 16. Live verification
results and remaining prerequisites are recorded separately in [the smoke ledger](smoke.md).

## Agent-operated live verification

Every open live leg in [smoke.md](smoke.md#open-live-legs-by-class) is classed `agent-executable`, `agent-evidence / person-verdict`, `person-only` or `external-blocked` (#784); this section is how an agent runs the first two.

When the user explicitly authorizes a live test, its agent may run console
commands using `ahub --live-test [--project <path|id>] <command> [args...]`.
For example, `ahub --live-test --project <scratch-path> ui --no-open` starts the
real dashboard listener and prints its one-time link without opening a browser.
`ahub --project <scratch-path> --live-test reset --all --yes` exercises reset on
that selected disposable project. The global options precede the command and
may appear in either order; a flag after the command is not delegation.

This grants console authority for operational console-class and peer-lifecycle conductor-class commands, including destructive actions, for one
invocation and its ahub continuations. Use only the user-authorized targets and
commands; destructive live checks belong in disposable projects. Existing
project discovery still applies: initialize the scratch folder as its own Git
repository before `ahub init`, then confirm `status --json` reports that exact
`cwd` before any destructive check.
Existing confirmations, process ownership checks, native identity fences and recovery
locks still apply. Do not remove agent markers. The initiating peer and command
label are audited before effects; an unavailable audit blocks delegation. A new
unflagged invocation has ordinary peer authority again. Native tools launched
by the command keep their own peer identity and receive no delegation flag.
Allowed-class commands keep peer identity and permissions even with the flag:
`--live-test say` sends as the peer. Peer starts, pause and resume may use
delegated console authority. Flagged task assign/escalate refuse; omit the flag
to use the ordinary actor-preserving conductor path when the peer has that role.
Person verdicts and user-authored workflow writes are not delegated. Dashboard
sessions issued through the flag retain operational controls but refuse message
and task/planning content writes. Use native peer tools for agent-authored work.

Use a CLI/coordinator containing this feature throughout the experiment. Ordinary
delegation requires `cli_audit_delegated` in the authenticated running daemon's
welcome, rather than its protocol number or disk status. Execution reuses that
connection; all helper connections are pinned to its authenticated instance, and
local commands check that instance before dispatch. Replacement control
connections refuse. Before effects, the same daemon must acknowledge the exact
audit UUID after successfully appending its event; a feature claim or spool write
alone is insufficient. That retained event survives later consumer replacement,
including a delayed local setup confirmation. Missing or unavailable
support refuses before command effects with an upgrade remedy; its refused audit
uses an outcome older consumers retain. The private pending audit is reserved
before connecting, so an unavailable outbox still refuses before any connection.
Upgrade/recovery uses a compatible `run` spool row and stores the authoritative
delegation in the operation's `delegatedAudits`: peer, closed command label,
timestamp and operation id. Creation, resume handoff, runner, abort and disposal
persist this evidence before runtime/target effects, independently of the source
daemon's drain. Schema-1 receipts retain it through source replacement and resume;
stored evidence never grants a later invocation authority. The journal is capped
at 256 entries and refuses further delegated attempts rather than evicting its
initiator. Local bootstrap commands with no daemon manifest use the compatible
`run` row too. This policy does not
change external computer-use restrictions. Recovery staging refuses old targets
without live-test support before source effects. Delegated headless recovery restores through the ordinary target CLI, carrying
its operationId on the delegated console connection; existing native ownership
and session-identity checks remain. Record actual observations in the
smoke ledger; the presence of this option proves no outstanding #273 live leg.

## Command output

`ahub status`, `board`, `budget`, `doctor`, `projects`, `queue list`, `turns`, `report` and `usage` print shared console tables and labelled details.
`status --all` uses the projects table. `queue show`, `models status` and `budget execution status` show labelled fields; add `--json` for the raw fetched document.
`report --by task` keeps the attribution and coverage sentences with section headings and aligned counters.
Use `--json` for scripts; it returns the fetched data without color, and `status --json` keeps its existing document.
`sdlc status`, `sdlc explain`, `sdlc queue`, `sdlc release`, `sdlc metrics`, `sdlc costs` and `sdlc authorize-release` print readable output by default (#814: aligned columns, wrapped text, readable times, `--color=auto|always|never`). A script that parsed their JSON must pass `--json`, which prints exactly the document they printed before. `sdlc export` is a data format and stays JSON, as do `export`, `research export` and `bench export`.
`restart` and `upgrade` off an interactive terminal (a pipe, `--dry-run`), `recovery status` and the results of `recovery reattach`, `resume`, `abort` and `dispose`, `models setup` and `start`, `queue resolve`, and `budget execution configure` and `disable` print readable text by default (#814); a script that parsed their JSON must pass `--json`, which prints exactly the document they printed before, including `restart --json --yes`. A readable plan lists each project, each peer with how it runs and what happens to it, every blocker, every reconnect-only session and every fresh start, and says nothing was changed; `--json` keeps those as stderr lines. A pipe wraps at `COLUMNS` when it is set, else at 80 columns.
`task show`, `task cancel`, `backlog groom`, `backlog return|plan|pin|split|undo|pull-ready` and the `release` commands (`list`, `show`, `new`, `plan`, `activate|freeze|ship|drop`) print a readable block by default (#814): the task or release as the hub holds it, a table for lists, every identifier whole, long text wrapped to the terminal. A script that parsed their JSON must pass `--json`, which prints the hub tool's text exactly as before. A private task arrives from the hub as its stub and is shown as that stub. Because these commands also take free text, `--json` and `--color=` count as flags only at the start or the end of the arguments: `--json` in the middle of a reason is part of the reason, and a value flag's value (`task cancel --reason --json`) is never a flag. A reason that ends in a bare `--json` loses it to the flag. `backlog add|pull`, `task escalate|assign|unassign` already answered one sentence and are unchanged.
In `projects --json` and `status --all --json`, an unavailable hub that explicitly refuses an inspection for SQLite contention also carries `failure: { "code": "database_busy" }`; it is additive metadata alongside the neutral `error` sentence.
Text columns are a human interface, not a scripting contract. An identifier accepted as a command argument is whole wherever its available column can hold its own length:
turn ids, queue ids, project ids, execution budget ids and ids in labelled views. Only status's informational settlement and hold ids are shortened;
`status --full` keeps those whole too. Identifiers in suggested commands are always whole.

`--color=auto|always|never` uses the console palette. Auto colors only a TTY with `TERM` other than `dumb`
and empty `NO_COLOR`; pipes and redirects stay plain. Color never replaces a state or level word.
TTY width is its columns (at least 80). A pipe uses a positive integer `COLUMNS` when supplied, otherwise rows
are complete and unwrapped. Long fields wrap within their column; when whole metadata words and the readable flexible-column minimum do not fit, table bands retain every field. Each band carries the row id; when it cannot share a line with the metadata, a per-row id banner links them. Labelled two-column views keep each label beside its value, wrapping the value instead of separating labels and values into bands. In `turns`, the time and state cells wrap at word boundaries only when the file list needs the room and the listing gets shorter for it. When `projects` bands, the task list stays with the state columns in the first band and the second band is always PROJECT and ROOT. Console children receive the console's width
minus its four-column indent and remain uncolored.

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

### Shell completion

`ahub completion zsh|bash|fish` prints a completion script; it never installs
files or edits shell configuration. On each Tab the script runs
`ahub __complete`, which answers from the help entries above (commands,
subcommands, options, their listed values and file names for path arguments)
without loading the rest of the CLI or contacting a hub, so completion always
matches the installed `ahub`. Agent shells may print the script too.

```sh
# zsh: any directory on fpath works; this one needs no .zshrc change with oh-my-zsh
ahub completion zsh > ~/.oh-my-zsh/custom/completions/_ahub && rm -f ~/.zcompdump* && exec zsh
# bash
ahub completion bash > ~/.local/share/bash-completion/completions/ahub
# fish
ahub completion fish > ~/.config/fish/completions/ahub.fish
```

Upgrading ahub needs no regeneration. To remove it, delete that file and start
a new shell.

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

In `ask-when-needed`, Pi and the local worker also grant bounded read-only shell calls at the host permit boundary (#816). The command must parse as one literal command and satisfy a closed program/flag table, trusted executable lookup and the existing root/path guard. Unknown flags, operators, expansions, pipelines, output files, unsafe helper/follow/file-list options and outside-root paths keep the ordinary approval path. Single quotes preserve literal data; double quotes containing `$`, backticks or backslashes are not automatically granted.

The fixed program set is `ls`, `cat`, `head`, `tail`, `wc`, `rg`, `grep`, `stat`, `file`, `tree`, `pwd`, `find` and supported read-only `git` forms. Git patch forms need both `--no-ext-diff` and `--no-textconv` where supported; a configured helper-bearing key (`core.fsmonitor`, `log.showSignature`, `gpg.program`, `gpg.<format>.program`, `diff.external`, `diff.<driver>.command` or `diff.<driver>.textconv`, `format.pretty` or `pretty.<name>`) outside the hub's own command scope keeps every git form asking. Custom `--format` and `--pretty` options also ask because signature placeholders can invoke the default GPG program. The host revalidates executable and path proof after each await, immediately before execution. A changed proof requires an explicit approval, including in unattended mode; persistent instability runs nothing. Neither argv nor environment is rewritten. Scoped read-only grants log the tool and class without command arguments.

`ask` retains shell approval behavior; `never-ask`, existing Pi tool-wide grants and the always-ask action policy retain their precedence. Seatbelt, the path guard, read allowlists, home and network access are unchanged. The person's Pi setting and live triage receipt are separate AC4 work; this feature's tests do not certify that rollout.

Tab toggles stream and panels; `ahub console --panels` starts in panels. A panel
screen has a header (the project's directory name, then the tabs), the panel and
a three-line footer, separated by ASCII `-` rules; the stream has one rule above
its footer. The active tab is bracketed, as in `[2 Approvals]`, so it reads
without color. The Approvals tab counts pending requests and the Queue tab
counts `needs_review` deliveries, in the attention and failure tones.

Tab `7 Usage` (#683 U3, key `7`; Left and Right wrap as Settings does, so the `1`..`5` cycle is unchanged) lists each peer with the tokens of today (the UTC day),
the last seven UTC days and its lifetime, the current budget pause, its quota windows with their reset time, and its last reset. Every number names its
source (`native`: the provider's own total, `hub`: what the hub counted for a peer that reports none, `at least`: a partial sum); a counter nobody reported
is `unknown` and a period with no records is `no records`, never 0. Enter opens a peer: today, 7 days and lifetime with input, output, cache read, cache
write and the hub count each on its own, and the last three resets. The task selected in Tasks when you press `7` is shown below the table with its tokens
per peer (`#id [pii]` for a private task, never a title). The panel asks the hub's `usage` op only while it is open, and a refusal shows as
`usage unavailable`. The numbers come from the roll-up of `ahub usage`, so the console and the CLI agree. A request folds the event log first, within 250 ms;
when a very large log is not folded yet the answer carries `behind: true`, the panel says `still catching up` and `ahub usage` prints a warning on stderr, so a partial number is never shown as the whole.

The dashboard's Usage view (#683 U4) sits in the Agents view, under Usage budgets, and shows the same roll-up: the lifetime, without-cache and cache-read totals with
the peers whose figure is unknown, the last 14 UTC days as stacked columns per peer (a day with no record is a `no record` column, never zero), a limits table with the
open pauses and the last 20 pause, resume and reset events, and a task table (state, owner, PR, input, output, cache read, cache write, total). Every figure names its
source like the console does and `unknown` stays the word. A private task shows `#id [pii]` and never its title. The page asks for the figures only while the Agents view is open
(`view: "agents"` in the snapshot request), so a hidden view costs no roll-up work on the 1 s poll. When the roll-up is still behind a very large log the snapshot carries
`usage.behind: true` and the view says the figures are a lower bound until it catches up; a roll-up that cannot be read shows `unavailable`, never the last figures. When there
are more than 20 limit events the table says how many older ones it leaves out and that `ahub usage limits` lists them. Colours are design tokens only, the view reflows to one column at 600 px, and its
tables and chart scroll inside themselves.

Reviewing from the console (#711): on a task in review in Tasks (a selected row, or the open task detail), `r` asks which verdict first on the prompt line,
`review #372 "<title>": a approve  c request changes  Esc cancel` (the title is quoted and cut, a private task shows `[pii]`). `a` puts `review 372 approved ` on
the input line with a guide line above it (`Enter approves #372. You can type a note first. Esc cancels.`); `c` puts `review 372 changes_requested ` there and
asks for what to fix (`Say what to fix, then Enter. Esc cancels.`): Enter with no note is refused in the console with `say what to fix before requesting
changes`, and nothing reaches the hub. The footer says `r approve or request changes`, and `your review: r approve or request changes` when the reviewer is
`user`, also while the task detail is open. When the command finishes the console shows `#372 approved` or `#372 changes requested`, or the CLI's refusal verbatim
as a failure notice, in panels mode too. A task that left review while the choice was open says `#372 is no longer in review (<state>)` and nothing is
prefilled. The console runs `ahub review` as the person; the hub still decides who may review, and nothing about authority changed.

An agent shell (a `!` command inside a Claude or Codex session, or any shell with `AGENTHUB_PEER_ID`, `CLAUDECODE` or `CODEX_THREAD_ID` set) runs as that agent, not as
you. When the hub refuses it something only the person or the task's own reviewer may do, stderr adds one line: `This shell runs as agent "claude" (AGENTHUB_PEER_ID
and CLAUDECODE are set), not as you. Run the command in your own terminal, or use the ahub console: Tasks, select #372, r.` The refusal and the authority are the
same as before, and the console identity never gets the line. The hub's notice that a task waits for your review now names the console path as well as
`ahub review N approved|changes_requested [note]`.

The console attention companion (#280) shows waiting, blocked, review, working,
idle or asleep with separate action/watch counts. Outside the Tasks table, `n` selects the exact approval,
held queue or review row, or prints applicable guidance; it never answers a
request or runs a command. Editing, choices and confirmation retain their controls.
`P` cycles the five built-in characters and off for the current console.

Configure `pet` in `.agenthub/config.json` or `config.local.json`; local options
override shared ones. Defaults are `character: "stai"`, `size: "line"`,
`glyphs: "auto"`, `blink: true`, `bell: false`. Line preserves the three footer
rows and prompt position. Mini/full reserve a bounded character rectangle and
fall back when the terminal is too small. Supported glyphs and character choices
are described below. `pet: false` or `ahub console --no-pet` disables presentation.
Unknown options produce one bounded notice and fall back. Only an open approval
blinks through the existing redraw; `blink: false` disables it. The optional bell
sounds on an action-count transition from zero, at most once per minute, never
for a message alone. Plain mode prints the line only when the action count changes.
Messages addressed to `user` remain attention items until the next key. Drawing
adds no timer, network request or writable settings path.
The operational tabs change with digits 1 to 5 or Left and Right (wrapping at both
ends), never while a command is being edited or a choice is open; under a
confirmation an arrow dismisses it like any key but y, without moving a tab. A pasted
chunk can only edit the command line, but a read that holds nothing but arrow or
Home/End sequences is that many key presses, so a held key repeats its move. Home
or `<` jumps to a panel's first row and End or `>` to its last; the Events tab
follows new events while the last row is selected and stays on a row you moved to.
`w` opens the dashboard outside the Peers tab; in Peers it edits the selected
peer's WIP limit. `o` opens the pet window; `:ui --all` and `:pet --window --close`
work on the command line too. In the Peers tab the planner's row reads `(planner)`, and
`l` then `y` makes the selected peer the planner (`ahub settings set planner <peer>`). In the Events
tab a row's header line is tokenized and coloured exactly as the same event in
the stream; only the header is tab-flattened before tokenizing. Body lines retain
the previous rendering and stay plain, as does command output; colour never changes
what the panel's text says.

Peers, Approvals, Tasks, Queue, Settings and Usage are tables with a header row. A column is as
wide as its widest cell, up to a third of the terminal; the last column takes
the rest and is cut with `...`. In Tasks, TITLE takes the rest and the STAGE
meter keeps a fixed column at the right edge. In Usage, LAST RESET is the column that gives way on a narrow terminal.

| Panel | Columns |
|---|---|
| Peers | PEER STATE MODE LINK Q ! WIP REVIEW PAUSE QUOTA MODEL DOING |
| Approvals | ID PEER LEFT TITLE |
| Tasks | ID STATE OWNER REVIEWER CLASS AGE TITLE STAGE |
| Tasks, backlog view (`b`) | ID PRI RESERVED DEPS CLASS AGE TITLE |
| Queue | ID PEER STATE REV AGE |
| Settings | GROUP KEY VALUE SOURCE APPLIES |
| Usage | PEER TODAY 7D LIFETIME PAUSE QUOTA LAST RESET |

In Tasks, `b` toggles open work and backlog. The backlog heading counts its rows;
rows sort by rank, then id. PRI shows priority/rank, RESERVED the reserved peer,
and DEPS either `ready` or the unapproved dependency ids. Titles use the public
board projection, so PII work remains `[pii]`. Narrow layouts keep ID, RESERVED
and TITLE before the other columns.

On a backlog row, `p` prefills `backlog pull-ready <id> <planningRevision> <reason>`,
`a` prefills `backlog plan` with a reservation JSON object, and `e` prefills the
same command with priority, rank and deps. Edit the JSON and supply a reason;
`c` uses the existing revision-bound `task cancel` command. Once pulled into open
work, `a` uses the usual task assignment flow. In either Tasks view, `n` prefills
`backlog add implement `; edit the class and title, or use
`:task propose --backlog` with paths/deps flags. On proposed or in-progress open
work, `R` prefills `backlog return <id>` for an ownerless proposal, or the
planning-revision-and-reason form for accepted, untouched work. The hub refuses
returns with execution, branch or commit evidence; its refusal appears as a notice.

These actions run the existing person CLI commands, after explicit confirmation;
Esc sends nothing. Row-prefilled ids and revisions cannot be edited, and stale
row revisions require a reload. `:backlog list` reads without confirmation;
backlog mutations (including pull, pull-ready, return, plan, split and undo)
confirm first. The console adds no write path or planner authority.

The MODE column appears only when at least one peer has a non-`ask` mode.
Peers' WIP column shows planner work in progress as `wip/limit` from `taskWip`,
including `0/2`; a peer without an entry reads `-`. At or above the limit, the
cell uses the attention tone. At narrow widths WIP gives way before PEER, STATE
and QUOTA, whether or not MODE is present.

DOING (#878) is what a peer is working on, from signals the hub already receives:
a Claude session's title (its transcript's latest `ai-title` row) and the
in-progress item of its `TodoWrite` list or the task `TaskUpdate` put in
progress; a Codex thread's name and its plan's in-progress step; an ACP agent's
plan entry in progress. The current item wins over the title, cut to 120
characters. A peer with no such source, or one that is offline, shows nothing,
and the column appears only when some peer has a value; it is the first column
to give way on a narrow terminal. The value is a `[private]` stub while the peer
owns or reviews a PII task or is in a private turn, when it was observed then,
or when the public metadata screen refuses it or fails. `ahub status`, the
dashboard's peer rows and the conductor's `hub_status` show the same value; it
lives in the daemon's memory only, never in `status.json`, a log, an event or
memory capture. Board WIP is unchanged.

In Peers, select a row and press `w` to edit `tasks.wip_limits.<peer>`, prefilled
with its current limit. The editor stays on Peers and uses the existing Settings
value, daemon preview, nonempty reason and `y` confirmation flow; Esc cancels without writing. The
setting definition supplies the bounds (currently 0..32), risk label (`raises`)
and `applies: live`; the shortcut adds no configuration write path. The Peers
hint reads `w WIP limit` and shortens to `w WIP` at narrow widths, alongside
`m permission mode` shortening to `m mode`. Without a `taskWip` entry, `w` shows
a notice and opens no edit. Press `6`, then `u` to preview and confirm the usual
Settings undo. These controls remain person-only, and `ahub settings` retains
its agent-shell refusal.

Other zero counters and unknown values read `-`. Durations read `45s`, `12m`, `3h05m`
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

Up/Down arrows or j/k move, Enter opens a detail of labeled fields (relative times,
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

Tasks and Queue selections follow the selected id across refreshes. If that row
disappears, no replacement row inherits the action. Task actions also bind the
row's `flowRevision` (its history length); queue actions bind the delivery
revision. The id and revision in a row-started command cannot be edited. Peer,
reason and the final role/action remain editable, and the confirmation names the
validated result. An older hub without `flowRevision` refuses revision-bound task
row actions instead of silently running them unchecked.

In Tasks, `a` assigns the owner in ordinary open states and the reviewer in
`in_review`; a waiting task says when assignment is a reservation. `u` unassigns
the corresponding role, and `r` reviews only in `in_review`. In Queue, `r`
prefills `discard` for a queued row and `retry` for a needs_review row, with the
action still editable before confirmation. `completed` is never the default.
Status, console notices and `route explain` show every held row with its id, sender, kind and age. The hub completes rows made entirely of superseded hub workflow notices or presence items, recording an ids-only reason and the hub actor. An owner task offer with its structured offer marker also settles when the recipient still owns the task, has reached in-progress, in-review or changes-requested state, and its own acceptance follows the last ownership change. A person's acceptance and an unread replacement-owner offer do not count; missing or older-than-4096-entry proof keeps the hold. This runs on hold entry, hub startup, recovery release and task changes, with an ids-only accepted-task reason and the hub actor; it is a disposition, never proof that the offer was read. Mixed messages, unaccepted offers, unmarked live reminders and unknown references remain held. A requested-stop hold still needs the person. A Claude session without channel support safely returns unseen pushes for `hub_inbox`; a thrown notification write remains uncertain.

Claude channel/pull sessions, Codex and Pi may call `hub_delivery_retry { delivery_id }` for their own
`needs_review` row once. Its tool results show held-row count, ids, senders,
kinds and age, never message bodies or task text (up to 32 rows/4 KiB, with an
explicit truncation notice). The redelivery starts with a fixed warning that
the earlier attempt is uncertain and its effects must be checked before acting.
The warning fits within the existing journal body limit. If needed, only the rendered copy is clipped at a Unicode character boundary and ends with an explicit cut marker; the original message is retained. Consumed-retry proof follows every coalesced original atomically with a successful checkpoint, surviving safe failure, stale removal, pruning and restart.

Any earlier explicit retry in the same recipient's lineage, including a person's
retry, leaves a later hold for the person. A busy peer's request only requeues
the originals; delivery waits for idle and retains all pauses and recovery holds.
Hub presence prefaces are mutable context, so they do not consume or inherit a
message's retry allowance and never receive the uncertain-retry warning.
The tool cannot complete or discard a row. If a recovery snapshot lacks retry
history, or older pruned retry records cannot be mapped, the affected message
lineages require a person; unrelated new messages retain the one-retry option.

The local worker and headless ACP peers, including Jcode, receive tools only inside a delivered turn. A hold prevents that turn, so these delivery-only transports do not offer recipient retry; their held hints ask the person to resolve the row. Ordinary messages stay queued. This restriction follows the current transport, not the vendor name: Kimi TUI remains pull-only and can request its one retry.

Every console resolution needs a reason. Queue `discard` removes queued originals or
settles a needs_review receipt; it never cancels a task or native turn.

`ahub task unassign <id> [--role owner|reviewer] [--revision N]` is available to
the person or configured conductor. The board records the caller that performed
the unassign. Owner removal is allowed in `proposed`, `in_progress` and
`changes_requested`, returns active work to `proposed`, and clears any owner
reservation. It is refused in `in_review`, `approved` and `backlog`. Reviewer
removal retains the state, including `in_review`, and refuses to remove the human
reviewer of PII work. No replacement is routed and no native process or external
effect is rolled back. An owner-unassigned task stays out of automatic owner
offers across dependency release, planner-pull processing, release timers and
restarts until a later authorized explicit assignment or reservation. The later unassign also
fences planner undo, so undo and re-pull cannot restore the removed reservation.
Former queued assignment or review requests are withdrawn without resolving
uncertain deliveries, and the former agent loses current authority. A withdrawal
notice uses delivery evidence or that peer's own accept/self-claim after the
latest assignment; another owner's in-progress state or an earlier acceptance
does not count. Withdrawing an unread queue alone sends none. If a later person
assignment supersedes an escalation or offline relay, the stale success result
and decision note are suppressed, but the former owner is still told the current
owner and to stop working.

`ahub task assign <id> <peer> [--role owner|reviewer] [--revision N]` uses a
checked console operation when a revision is present. Without it, existing CLI
behavior is unchanged. `ahub queue resolve ... [--revision N]` uses the supplied
revision instead of a fresh show. A `queued` delivery was never handed to its peer, so it can be discarded while the peer is busy (a pull-only TUI is busy most of
the time); `dispatching` and `accepted` deliveries stay refused, and `retry` keeps its rules. A refused resolution names its cause (`active delivery`, `peer busy`,
`stale revision`, `unknown delivery`, `already resolved`, `queued delivery is already scheduled`, `recipient queue is full`, `delivery journal unavailable`), never one
generic sentence (#713).

`ahub queue discard --peer <id> --reason <text> [--state queued|needs_review] [--yes] [--json]` clears one peer's backlog and is for the person only (an agent identity is
refused). Without `--yes` it only says how many deliveries it would discard; with `--yes` it discards each queued (default) or `needs_review` delivery of that peer through the
same resolution as `queue resolve --action discard`, each recorded with the reason, and prints `discarded N of M` with the causes of any it could not discard. Only the
named peer's queue is read, so other peers are untouched; it is refused while recovery or shutdown holds queue mutations. In the console Queue panel, `D` on a row opens
the same command for that row's peer, asks for a reason, then a `y` that names the count. No task is cancelled and no native turn is stopped.

Completed-change notices (`Task #N (owner X) is done and touches your open ...`, #713) go one per recipient per done, naming all of that recipient's overlapping tasks, and
only for tasks the recipient has accepted (in progress, in review or changes requested): an offered or proposed task gets none, since its offer or its accept already shows the
current board. A newer notice for the same done task replaces the queued, undelivered one for that recipient (a `superseded completed-change notice` discard in the journal), so
a task that is sent back and done again three times leaves one queued notice, the newest. Revision mismatches and superseded post-await
publications fail without a board or delivery side effect; a reviewer-only change
keeps a valid owner assignment but refreshes its reviewer content.

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
including overall state counts, waiting and stacked segments; each task detail
retains its labeled four-stage track. Filtering rows does not filter overall progress. The existing signature guard
updates the live region only when progress changes. The stacked SVG fills the
section width; its text legend carries every state count. Theme offers System,
Light and Dark; it is applied before first paint and stored in a host-scoped loopback cookie
(`Path=/`, `SameSite=Strict`, one-year lifetime), shared across dashboard ports.
Blocked cookie access defaults to System on reload and never prevents operation. System follows
OS color preference through CSS. Both inline scripts and the style retain CSP
hashes; there are no external chart/theme assets. Live theme/readability inspection
is tracked in `docs/smoke.md` and remains unverified until performed.

The dashboard Office section (#264, phase 1 of 4) draws the same snapshot as a
static flat office: one desk per peer in a stable slot (claude, codex, kimi, pi,
local, then others by id; a peer going offline dims its desk and never moves
another), rooms for the board columns in a fixed order (To do, Work floor,
Review, Done as a count only), at most 8 cards per room with "+N more"
filtering the task list to that state, and at most 12 desks with "+N peers".
Work-floor cards sit at the owner's desk, marked for rework; a busy peer's task
bubble names its task only when it has exactly one in progress. Every peer
condition (idle, busy, offline, paused, waiting on approval) has a glyph and a
text label, and the scene carries ids, classes, states, kinds, counts and public
titles only: message bodies, task details and approval titles never enter it.
The scene adds no timer, frame loop or request and re-renders only when its
signature changes. A View control offers Off (the default), Flat and
Isometric; the choice is stored in a second host-scoped loopback cookie `agent-hub-office` with the
same attributes as the theme cookie, and blocked cookie access defaults to Off
without preventing operation. Desks and cards are focusable buttons; activating
one scrolls to and highlights the matching list row, and a list row highlights
its desk or card on focus and hover. The scene performs no action: every control
stays in the lists. The View control's third option, Isometric (phase 4),
renders the same model through the same code path with the grid coordinates
projected (x' = (x - y) cos 30, y' = (x + y) sin 30): tiles become
parallelograms, cards and labels stay upright, and the DOM order and
accessible names are identical to Flat. Switching the view jumps to the new
projection without animating; the settle rule and reduced motion apply
unchanged. The live browser look is tracked in `docs/smoke.md` and
remains unverified until performed.

Motion (phase 2): card moves between rooms and desks, message arcs between
desks (from the hub or the console they start at an anchor point), delivery
warning marks and the busy latch all follow the snapshot. Motion is CSS only:
transitions on transform and opacity (at most one second), keyframe fades for
the transient marks. Arcs and marks hold, then fade out ten seconds after the
event, timed at render from the model's timestamps; expired nodes purge on the
next changed render or their own animationend, never on a timer. Arcs expire on
the snapshot's own envelope clock, so an unchanged snapshot re-renders
identically and writes nothing to the DOM. The scene goes straight to final
positions on the first snapshot, after a project switch, after a snapshot gap
over three seconds, or when one snapshot brings more than six transitions.
`prefers-reduced-motion: reduce` removes all scene transitions and animations.
Event reasons and bodies never enter the scene; arcs carry from, to, kind,
priority, the task ref and the dropped flag only.

Snapshot fields (phase 3): three additive optional fields, so older pages and
older daemons mix freely and `PROTOCOL`/`EVENTS_SCHEMA` stay unchanged. A peer's
open turn (`since`, `task`, `attribution`) names the busy bubble's task exactly
instead of the single-in-progress-task heuristic, and a turn still open while
the peer is paused adds a "finishing a turn" line under the Break sign. A task's
`checking` flag draws a check-running mark on its card, which stays at its
owner's desk (rooms follow states only). Warning `links` (overlap from the
board's overlap test, cohorts, and recent turn-end conflicts the daemon keeps in
a bounded in-memory list) draw dashed lines between the desks they name, labeled
with kind and task ids; all three carry task and peer ids only, and a PII task
never joins a link.

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

## Authority by command

`classifyPeerCommand` (src/cli/identity.ts) is the gate for an `ahub` command
run from an agent shell. It gives every command one of three classes:
**Allowed** means any agent may run it; **Conductor** means only the
configured conductor peer may (actor-preserving and audited); **Console** means
only the person's own terminal. A command the gate does not name is Console,
and so is every help entry the gate has no class for yet;
`test/identity.test.ts` pins each classed form below.

### Allowed (any agent)

| Command | Class | Why |
| --- | --- | --- |
| `ahub doctor [--json] [--full] [--color=...]` | Allowed | a read-only check of tools, daemon, plugin, gateway, models and memory |
| `ahub doctor --stale-anchors [--json]` | Allowed | a bounded read-only report of memory symbol anchors at current HEAD |
| `ahub queue list [--peer <id>] [--json] [--full] [--color=...]` | Allowed | public queue metadata only; held bodies and resolution remain conductor operations |
| `ahub roster [--json] [--color=...]` | Allowed | public roster status; add/remove retain conductor admission |
| `ahub settings [list] [--json]`, `ahub settings get <key> [--json]` | Allowed | public registry values; secret-locating values, paths, undo records and config-editor details are withheld |
| `ahub sdlc status\|explain [<task>] [--json] [--color=...]` | Allowed | public lifecycle status; private tasks stay stubs, without private evidence or receipts |
| `ahub sdlc queue <owner/repo> [--json] [--color=...]`, `ahub sdlc release <owner/repo> [live-issue...] [--json] [--color=...]` | Allowed | public delivery/release readback for the checkout's GitHub origin, explicit SDLC config repos or person-imported public external records; no release authorization or mutation |
| `ahub release show <name>` | Allowed | public release metadata; private scope and internal history remain withheld |
| `ahub projects [--json] [--color=...]` | Allowed | lists registered projects; `projects remove` stays Console |
| `ahub models status [--json] [--color=...]` | Allowed | reads local model state; `setup\|start\|stop` stay Console |
| `ahub recovery status [<op-id>] [--json]` | Allowed | reads a preflight operation; the bare interactive screen and `reattach` stay Console |
| `ahub upgrade ... --dry-run` (no `--yes`) | Allowed | reviews the upgrade plan and applies nothing; apply requires an exact conductor proof or the person's terminal |
| `ahub restart --yes` | Conductor | only with a source-issued continuation proof for this project's own operation |
| `ahub upgrade --yes --to <exact-version>` | Conductor | only when source and target support the bound continuation protocol; the parser still validates the exact version |
| `ahub recovery resume|abort [<op-id>]` | Conductor | only for that same conductor's restart/authorized-upgrade operation and its current proof; otherwise person-only |
| `ahub task unassign <id> [--role owner|reviewer] [--revision N]` | Conductor | actual caller is retained; no replacement is routed and native work is not stopped |
| `ahub restart --dry-run [--json]` (no `--yes`) | Allowed | reviews the restart plan and applies nothing |

`backlog list`, `release list` and `sdlc costs|metrics` retain their existing
planner/person policy. Their CLI forms stay Console for ordinary agents; a
configured planner can use the existing planner tools without borrowing console
authority. All newly admitted reads use the ordinary tools connection and public
views, never console identity. The person's full readback stays unchanged.
Conductor operations are listed in [the operational command table](#conductor-operations-812-t2).

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
`hub_peer_start` starts a peer in the start mode a person set for it (see
"Start modes"): local and headless Kimi, Pi, Codex or Jcode start at once; for a
TUI peer the hub opens a terminal running the fixed `ahub <peer>` command,
after validating it through the shared launcher planner, and when it cannot
open one the call fails with that command for the person to run. The
conductor cannot choose the mode. `hub_peer_hold` and `hub_peer_release`
manage only holds placed by that conductor. Assignment also requires `assign`
when the conductor has an explicit capabilities list.

Check the returned owner and task state after assignment. Routing skips paused
peers, so assign work before placing a delivery hold. Hand work out through the
board and report to the person with `hub_send` addressed to `user`, or a `[FYI]`
final response in the native TUI. Broadcasting implementation instructions can
cause an otherwise unassigned owner to claim duplicate work.

The person answers approvals in the console, resolves `needs_review` deliveries
with `ahub queue resolve`, stops a headless peer with `ahub stop`, and handles
budget overrides and hub lifecycle.
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

## Pi with DGX and MLX

Pi is optional. Install Pi separately and set `pi.enabled` to `true` in
`.agenthub/config.json`. Set `pi.auto_start` to `true` to start it with the hub.
Pi starts in its TUI by default; `ahub pi --headless`, or the start mode
setting (`ahub settings set peers.pi.start_mode headless`), asks for the
background peer instead. The project uses its existing OmniRoute connection for DGX;
`pi.dgx_coding` and `pi.dgx_fast` select the gateway's configured model IDs.
Every Pi start (headless, TUI, console or auto start) first runs the configured
`pi.cmd` with `--version` (#847). Pi 1.4.0 is verified
([model-free receipt](verification/2026-10-26-pi-140-compat.md)); another
version, or one that cannot be read, is refused before Pi starts, unless the
person trusts that exact version with `ahub agents trust pi <version>`.

```bash
ahub models setup       # prepare bounded Qwen3.5 4B MLX in an existing Ollama service
ahub models start       # verify loopback Ollama/model readiness (no daemon spawn)
ahub models status
ahub pi --headless --backend auto
ahub say @pi "Read the project and summarize the next small implementation task"
ahub pi                # its TUI in this terminal; an idle headless session moves into it
```

The default routing template assigns implementation, bulk edits and tests to
DGX, and summaries/triage to MLX. Pi and the existing local worker take priority
before cloud peers; planning and final review stay with Claude/Codex. Existing
projects keep their routing file, so add `pi` to the relevant `peers` lists and
set `pi_backend = "dgx"` or `"mlx"` for each class. PII tasks remain local-worker
only. `--backend dgx` or `--backend mlx` explicitly pins a Pi session's backend.

Pi connects to an authenticated relay with model aliases `dgx/coding`,
`dgx/fast`, and `mlx/fast`; upstream gateway credentials stay in the hub.
Its managed tools use the existing path guards, shell sandbox and terminal
approval flow. Keep `ahub console` open to approve write/edit/shell operations:
a request nobody answers expires, and two in a row end Pi's turn.
Tool-call receipts survive daemon restart; an interrupted operation with an
unknown outcome must be reconciled before repeating it. Cancelling a Pi turn
does not automatically hand its task to a cloud peer.

For assigned, non-private work, `hub_task_spec` reads the named GitHub issues
through the hub's authenticated, bounded read path. `hub_check_start` runs an
exact Git ref's permitted tests or typecheck in the opt-in isolated container
runner (`checks.runner: "container"`, or the optional `"remote"` backend); `hub_check_result` and `hub_check_cancel`
read or cancel that owned run. Missing spec/check capability refuses the
assignment early; it never grants host commands, credentials or broader sandbox
access. Receipts distinguish exact source/tree/lockfile, platform, exit and
uncertain or cancelled outcomes. See [bounded spec and check access](security.md#bounded-task-specs-and-isolated-checks-418)
for the authorization and resource bounds.

Remote runner configuration (#793) is permitted only in the person's untracked `config.local.json`: select `checks.runner = "remote"` and supply `checks.remote.host`, `checks.remote.image` (immutable SHA-256 image reference) and `checks.remote.root` (reserved absolute metadata, unused by any current command). No remote destination belongs in tracked project files. The runner uses the person's host SSH capability (including the hub's authentication agent socket) in BatchMode, with TTY allocation, agent/X11 forwarding, configured forwardings and local SSH commands disabled, and fixed Docker argv; it never installs host tools, mounts host paths or falls back to this Mac. A failed SSH, Docker, image or hardened network-none/transfer probe marks sandboxed test capability unavailable with a generic remote-runner reason. A successful platform line names only Linux architecture and numeric Docker version.

The remote source is the recorded Git commit, streamed into a hardened non-root container. Mac dependencies are excluded. Before a check, the runner proves or prepares a Docker volume named from the commit's lockfile hash, its manifests and install configuration (`package.json`, `bunfig.toml`, `.npmrc`, `patches/`), the Bun version and architecture of the pinned image, and its digest (#793b): the first run for a new lockfile spends extra time and is the only moment a container has a network, running exactly `bun install --frozen-lockfile` into the volume. Later runs find the volume, verify it read-only offline and install nothing. The check itself never installs, has no network and mounts the volume read-only. The ten-minute run budget includes preparation, so a very large first install can time out and is simply retried. A commit whose root or workspace `package.json` declares an install lifecycle script (`preinstall`, `install`, `postinstall`, `prepublish`, `preprepare`, `prepare`, `postprepare`) is refused the same way, since such a script can read source the volume key does not cover. If the volume cannot be proven the run ends with `remote dependencies unavailable`; there is no writable shared cache and no fallback to this Mac. The newest three prepared volumes per project are kept and older ones removed after a verified run. Remote `root` is validated but unused because no host path operation is needed. The bounded [local Docker transport receipt](verification/2026-10-25-remote-docker-transport.md) records the extraction, cleanup and dependency-volume legs. Actual remote-host opt-in, SSH and pi's live check receipt remain unverified follow-up work. Existing local Apple-container behavior remains available by explicit selection.

Retention bounds inactive valid check receipts to 200 records and the newest 20
full outputs, excluding active runs. Full output is also consumed by the owner
result read or expires after 24 hours.
Malformed or unreadable receipts are a retention exception: their receipt bytes,
output and staging stay for inspection, with ID-only warnings separate from
unknown container-owner warnings. Maintenance skips them while continuing valid
retention; it never deletes an unknown container. See the security contract for
the same-user parent-swap cleanup limitation. These source guarantees do not
establish the separate native macOS acceptance leg.

The `mlx/fast` alias now defaults to an externally managed Ollama MLX backend.
Install and start Ollama separately, with `OLLAMA_NO_CLOUD=1`,
`OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=1`, and a finite
`OLLAMA_KEEP_ALIVE` (five minutes is the tested setting). `models setup`
prepares `agenthub-fast-mlx:4b-8k` from `qwen3.5:4b-mlx`, with an 8K total
context and a 2K output cap. The relay budgets input separately at 6,000
estimated tokens and serializes local requests across project hubs.

`models status` distinguishes model availability from memory residency.
`models stop` refuses to unload an externally managed Ollama model: other
clients may be using it. Ollama owns idle eviction; stopping a hub never
kills Ollama. The OpenAI compatibility endpoint does not enforce a request
`keep_alive` field, so configure the server and verify its expiry readback.
The relay can fall back to DGX before streaming starts as before. See the
[Ollama migration procedure](#ollama-mlx-migration-issue-51)
for existing Python runtime/configuration cleanup and rollback.

A project has one managed Pi session owner. Mode changes require the agent to
settle and preserve the session file. Before the first generation, a live source
verified to be empty can instead retain its exact session ID without a file.
Missing history from a nonempty session blocks handover. Protocol 9 adds Pi
recovery metadata. Protocol 10, released in 0.7.0, adds durable delivery
receipts and conservative queue recovery; it is verified live (see the
[smoke checklist](smoke.md)).
Older protocol hubs still require their matching CLI and an attended bootstrap.

## Local dashboard

With a running daemon, `ahub ui` opens a local dashboard for messages, peer states
and queues, the task board, budget windows, pending approvals and this machine's
benchmark runs. Use `ahub ui --no-open` to print a single-use link when the
browser cannot be opened.
Open the link within 60 seconds; the browser session lasts one hour.

The dashboard can send console messages, propose and assign tasks, pause or resume
peers, answer approvals, start a peer in its start mode and show the settings.
An ordinary session changes the safe switches and lowers a mode to `ask`; the
rest needs `ahub ui --settings` or `ahub settings` in a terminal. See
[Settings](#settings-from-the-dashboard-and-the-terminal) and
[Start modes](#start-modes-tui-by-default-headless-as-opt-in).
Budget pauses still require the terminal override.
Private envelopes and PII tasks stay redacted. Local-worker and Pi tool details and
allow decisions stay in `ahub tail` / `ahub permit`; the page can deny them.
No dashboard port is opened until requested. See [the session security model](security.md#local-dashboard-sessions-issue-6).

### Dashboard design tokens (#469 R1)

The page's style block starts with one token block that owns every colour, the 4px spacing scale (4, 8, 12, 16, 24, 32), the
type scale (12, 13, 14, 16, 20) and the radius rule: 6px for controls, 10px for surfaces (panels, cards, the dialog), full
radius for chips and avatars. Neutrals are one cool family with three surface levels (page, panel, raised) and one accent for
primary actions, focus and selection; the state colours keep their meaning. The dark values are written twice, once for
`data-theme="dark"` and once for the system preference, and a test keeps the two identical. Two shadows exist for raised
elements only (`--shadow-2` is the dialog's; `--shadow-1` waits for the board cards in R3). Each peer colour has a light and a
dark variant of one hue, generated from the registry's colour by `peerPaletteThemeCss` (`src/ui/peer-palette.ts`) so it clears
3:1 on every surface. System fonts only. The layout, the views, the keys and the behaviour are unchanged by R1; the contrast
test (`test/office-view.test.ts`) covers the text pairs, the accent, the dots, disabled controls and every peer colour in both
themes. The Office scene keeps its own rules until R5.

### Dashboard app shell and keys (#469 R2)

From 1024px up, a sticky top bar holds the project context, the connection status (a coloured dot and its text, green when live
and red when disconnected or closed), the attention badge, the theme switch and a shortcuts button; the seven views sit in a
left sidebar with an icon and a label, and the approval count still rides on Agents. Below 1024px the same nav is one row of
tabs that scrolls sideways inside itself, so the page never scrolls sideways. The view names, their order, the
`agent-hub-view` cookie and every id are unchanged.

Keys: `1` to `7` switch to Board, Office, Stream, Agents, Message, Memory and Settings, `?` opens the key list, and `Esc` closes
the key list or the task detail (both are native dialogs). View keys are ignored while you type in an input, a textarea or a
select, with Ctrl, Alt or Cmd held, and while a dialog is open. Icons come from one inline SVG sprite of nine Tabler icons;
the MIT notice is in `THIRD_PARTY_NOTICES.md`. Nothing is fetched and no package is added.

### Dashboard board, side sheets and the Plan sheet (#469 R3)

A board card shows the title (two lines at most), the owner as a round avatar in the peer colour with its initial, one badge that
holds the state and the priority ("in review P1") and the release when there is one. Everything else moved to the task detail,
which keeps the same dialog and opens as a sheet pinned to the right edge (full screen below 600px). The detail groups its
lines into Status, People, Dates and Links, and leaves out a group with nothing in it. Pull, Assign, the Ready and Waiting
subheads, "Show N older" and drag and drop are unchanged.

The five board forms (plan a task, split a backlog task, releases, delivery evidence, propose a task) are in a Plan sheet, opened by
the Plan button in the board toolbar. It is a native dialog, so `Esc` closes it, and view keys do nothing while it is open. The
fields, ids and actions are the ones the forms had. The sheets slide in on `transform` and `opacity` and not at all when the
system asks for reduced motion.

### Dashboard Agents, Stream, Memory, Settings, Message and the Office colours (#469 R4, R5)

Agents: a peer is one row with its name and state, a summary line (queued messages and "Working on #n" or "No active task") and a
single "Details" fold that holds the diagnostic lines it used to list. A status notice stays visible outside the fold. Approvals
stay first. Stream: one aligned row per event (time, kind, sender, body in monospace); the filter chips and Follow latest sit in
the section head, above the scrolling list. Memory: result rows show title, kind and age, the selected row is marked with an accent
edge, and the graph and the detail pane use the colour tokens. Settings: each group is a section with a short header, a key that waits
for a restart carries a "restart pending" badge, and "Pending restart" shows a count; the text lines, Preview, Save and Undo are as
they were. A Structure group edits structural configuration in a settings session (#689, see Structural configuration below). Message uses the shared form styles.

Icons replace the symbol glyphs: the star mark, the stream arrow and the Office "checking" mark are sprite icons (twelve Tabler icons
in all), and the Office draws each condition (idle, busy, offline, paused, waiting on approval) as a shape (ring, disc, cross, bars, raised hand)
next to its words. Condition names are unchanged. The Office scene names its colours only through the same tokens as the rest of the page, and the
contrast test checks every token an Office rule uses, in both themes.

### Dashboard keyed rendering, motion and states (#469 R6)

The page still polls `/snapshot` once a second and still skips a redraw when a container's JSON did not change. What changed is how
a changed container is redrawn: task cards, peer rows and memory rows are kept per id. A card, row or memory entry whose own data
did not change keeps its DOM node, so hover, an open "Details" fold and a focused card survive a poll that changed something
else. One that changed is replaced by a fresh node, and if it held focus the focus moves to the replacement. A card that moves to
another column fades in; one that disappears is simply removed.

Motion moves `transform` and `opacity` only, 120 to 200 ms, ease-out: button press, a short fade when you switch views, a card
arriving in a column, the toast, and the side sheets. The Office keeps its own motion. Nothing new loops. With the system setting
"reduce motion" every transition and animation in the page is off.

States: until the first snapshot arrives, after a project switch too, the board and the peer list show grey blocks shaped like them. Each empty view says what
fills it and the command that does it (`ahub task propose`, `ahub claude` or `ahub codex`, `ahub say`, `ahub permit`, `ahub
remember`, `ahub goal new`). When a poll fails the connection status turns red, the content dims to 60 percent but stays readable,
and a line at the top gives the time of the last snapshot and says polling continues. Notices are a stack of up to four toasts in
the bottom corner (`aria-live="polite"`): a success fades after 4 seconds (and stays under reduce motion), an error stays until
you press Dismiss.

## Multiple projects and worktrees

Version 0.4.0 adds one independent hub per repository or Git worktree.
Subdirectory commands resolve to that project; symlink aliases resolve to the same
hub. Explicit selection works from any directory:

```bash
ahub --project /path/to/project-a init
ahub --project /path/to/project-b init
ahub --project /path/to/project-a up
ahub --project /path/to/project-b up
ahub projects
ahub status --all
ahub --project /path/to/project-a codex
ahub ui --all
```

The unified dashboard lists registered roots and opens their boards, streams,
messages, approvals and budgets. It can start hubs and stop a selected hub after
confirmation. Its Start control opens a peer's TUI only through a terminal provider
(`terminal.open` or Orca); without one, launch Claude/Codex TUIs from a terminal. The manager stays available
when a project stops; `ahub ui --all --stop` stops only the manager. Existing
`ahub ui` still opens the current project's dashboard.

`ahub projects --json` returns machine-readable live status. Use a listed ID or a
path with `--project`; the selector must precede the command. `ahub projects remove
<id>` forgets a stopped registration without deleting project data. A moved root
gets a new registration. Missing roots remain visible until removed.

Runtime state stays in each project's `.agenthub/state/`. The machine registry is
`~/.agenthub/registry.db`; existing `ports.json` allocations are imported once.
`AGENTHUB_HOME` selects an isolated machine registry (also used by tests). An
inherited state directory from a different project cannot redirect a new CLI
invocation. Explicit custom state requires a matching project marker or the
initialization pair `AGENTHUB_PROJECT_DIR` / `AGENTHUB_STATE_DIR`.

Manager-started hubs use attended mode and project configuration, including
credential-file references. They do not inherit the launching project's gateway
URL/key overrides. Native memory is shared by memory project key: the project's
normalized `origin` remote (without one, its git chain and main working root),
mapped through the person's `amem alias` log, so a worktree or subdirectory uses
its main checkout's key. The manager's shared-alias notice compares project-name
chains instead (superprojects down to the repository, `<parent>/<worktree>` for a
worktree). Neither means that task boards or agent sessions are shared. Provider quota readings
may describe the same account and should not be added across projects.

Before upgrading an older hub, inspect the plan with the matching CLI.
Incompatible or unverified processes are shown explicitly and are never killed by
PID-name matching. See the operations guide and the
[multi-project specification](specs/2026-09-19-multi-project-design.md).

## Install and start

Use Bun 1.4.2 or newer. Source checks and CI use the version pinned in
`.bun-version` (currently 1.4.2). Install the released package and install its Claude
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
`omniroute.access_hosts`, the `omniroute` key files, `memory.worker_url` (still
accepted, ignored since 0.16.0),
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

Some names stay closed to those commands, and to Pi's, wherever they may
otherwise write: anything named `.git` at any depth, the `config` and `hooks`
directly under a `.git`, `commondir` below it, and `.agenthub` anywhere in the
project, plus `config.worktree` beside each such `config`. A submodule's git
directory gets the same `config` and `hooks` refusal under every `modules/`
tree the project can reach: the common dir's, the worktree's own and every
linked worktree's (#281, task 518). Nothing else may be written under such a tree
outside a discovered submodule git dir (#865). A command can therefore not
create, rename or remove a `.git`: `git init`, `git clone` and
`git worktree add` do not run inside the sandbox, and neither do
`git worktree remove`, `git worktree prune` of a stale record,
`git submodule update --init`, `git clean -ffd` over a nested repository or
`rm -rf` of a directory that holds a `.git`. The shared object store takes
only new loose objects (#864): `objects/info` (alternates, commit-graph) and
`objects/pack` are closed and an existing object cannot be changed, removed or
replaced, so `git gc`, `repack`, `fetch` and `maintenance` do not run inside
the sandbox either. `git add`, `commit`, `stash` and `checkout` work, and
`.gitignore` and `.github/` stay writable; a commit that your git configuration
signs with a key under `~/.ssh` or `~/.gnupg` fails, because the sandbox cannot
read those directories. Run a refused command yourself, in a terminal.

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
summaries and review verdicts are not gated), `memory_correct` (propose a local correction candidate for person review), `memory_read`
(`hub_memory_search`, `hub_memory_show`, `hub_memory_graph`) and `important`
(`[IMPORTANT]` messages). For example `"capabilities": { "local": ["propose", "remember"] }`.
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
ahub pi                 # its TUI; --headless for the background peer
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
resolves an uncertain delivery automatically. The same rule holds on every path that
assigns a task (#297): once the move is saved on the board, a failed delivery prints
exactly one console notice ("the move is saved... delivery is not confirmed"), printed
where the error is thrown, and the caller (a peer in its turn, or the CLI) still gets
its error. Two exceptions, by construction: a move superseded while the assignment was being prepared, meaning a later history entry that moves or settles the task (another assignment, an unassign, the owner's accept, done, approval, close; the hub's quiet bookkeeping such as a late check result or a reviewer change does not supersede), returns the current task without a failed tool call and with no notice naming either owner; and a claim is its own hand-over, so its
accepted write and line stay outside the delivery rule (its overlap and routing announcements to earlier
owners are deliveries and share it). The repair is always
to look for a queued or needs_review delivery with
`ahub queue list --peer <owner>` (then `ahub queue show <id>`, or the accepted entry in
`ahub task show <id>` if the journal itself is down) and then send the assignment again
with `ahub task assign <id> <owner>`. Nothing resends automatically: a blind resend can
duplicate a delivery that actually left.

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

At a terminal width `ahub board` prints one line per task (#724): TITLE is cut
with `...`, dependencies are an AFTER column (`#113,+2`), and STAGE is the
progress meter with the stage and a short next-step code (`intent: issue?`,
`review: CI?`, `ready`), explained by a legend line. A column that is `-` on
every row is left out. When TITLE would get fewer than 30 columns (or fewer
than its longest title), REVIEWER, CLASS and AGE give way in that order, then
STAGE drops the stage name; at a width still too narrow AFTER goes and OWNER is
cut.
`ahub board --full`, `ahub task show <id>` and piped output without `COLUMNS`
keep the whole title and the full SDLC advice.

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
exits, at the timeout or on shutdown, and a check killed at its timeout or on
shutdown settles within one second even if its exit is never reported), and then either
sends the task to review with the command, exit code and output tail, or keeps it
with its owner and tells it what failed. `checks` is machine-local (see Install
and start): a committed file must not choose commands the hub runs. Keys that
are not task classes are ignored with a log line. A hub stopped mid-check leaves
the task in progress (`check interrupted`); the owner marks it done again.

While the project root checkout is on a branch other than its default
(`origin/HEAD`, else `main`), finishing a task adds `the main checkout is on
<branch>; move the work to a worktree under .worktrees/` to the owner's result
and the reviewer's request, and `ahub status` shows it as `main checkout`
(#572). It is advice only. A branch name that fails the hub's public-text screen
is withheld from the sentence.

A task reaching `approved` is a board transition. It is not proof that an
external side effect happened unless the task's refs and a live readback show
that effect. After `tasks.escalate_after` consecutive `changes_requested` verdicts
(default 3, `.agenthub/config.json`), the hub moves the task to the next attached
peer in the class's `escalate_to`.

A review request carries a checklist: map the changed signatures and call sites
to the task's plan (without one, to its detail, which the request then
includes), read the check result, and list what is
unmet (`hub_review` takes `unmet`, `ahub review ... --unmet <item>`). A reviewer
that missed the request, and the owner, read the done summary and check result
with `hub_task_show {id}`: the task's public view with its history, as the
conductor sees it, and only a stub for a PII task. The configured planner reads any
task outside the backlog the same way (#812); a staged backlog row stays hidden from agent
task tools and is read through the planner tools. Other peers are refused. Each
request also carries the hub's review brief for the task's commit: reviewable and
excluded files with reasons, the `REVIEW.md` and `ahub-review-rules` rules read at
the merge base, and a cross-check list; `ahub review brief <id>` prints it.
Optional code facts (#682) add per-file observed symbol names, kinds and spans,
plus changed/planned, changed/not-planned and planned/not-seen lists. Install
ripwire 0.6.7 on the daemon's host PATH to enable them; missing, unsupported,
failed, busy or timed-out reads show `unknown` and never stop the review request.
Each native call is capped at 5 s, output is capped, and successful values are
cached by repo, commit and query. PII tasks never query it; displayed names use
the hub's public metadata screen. It always analyzes a disposable raw-blob
snapshot, never main or a dirty/untracked owner tree, and removes that worktree
after the owned process stops. No heavy slot is acquired. Trees beyond the
regular-file/4096-file/32-MiB bounds remain unknown.

Ripwire 0.6.7 omits deleted definitions and does not classify change kinds, so
all symbol rows say `change: unknown`; planned/not-seen is not proof of no
change. Graph name-only matches are hidden as ambiguous, and graph count floors
remain explicit. The file-based coverage gate is unchanged. A future both-tree
inventory or bounded base/head probes can improve this advice after dogfooding.

At completion, optional symbol advice also becomes a head-bound task observation
(`#684` phase 2a). Console task detail and the UI task snapshot expose the
screened IDs, paths, names and kinds, without source/spans or internal repository
keys. Public reads re-screen current policy; PII stores nothing. Unknown or
stale evidence remains unavailable. Completion prepares this optional data even
without a reviewer, without adding a review gate. Foreign-repository tasks stay
unknown until the brief can independently bind its analysis repository.

In the console, Enter on a task in Tasks shows a `symbols` block after its plan (#684 phase 2b): each observed changed symbol is `matching` the plan or
`unplanned`, and each planned symbol that nothing changed under is `untouched`, with the counts and the head they were observed at. The match rule is the review
brief's own (a pair of qualified names must be equal, otherwise the last segments are). Without code facts it reads `changed symbols: unknown (no code facts)`;
an incomplete observation says an untouched symbol may have changed; a private task shows nothing. Names are quoted like every agent-written string, at most 40 are
listed and the rest are counted. The block is advice: deleted definitions are not reported, so it never proves a plan was or was not followed.

The dashboard's task sheet has the same block as a "Code" group (#684 phase 2c): the changed symbols as buttons marked `matching` or `unplanned` against the plan, the plan names nothing changed under as `untouched`, and the same advisory line (deleted symbols are not reported, an incomplete observation may hide a changed one). The hub classifies them (`codeGroup` on each task of the UI snapshot, from the same public observation the console reads), so the page never matches names itself. A symbol opens the Memory tab with its canonical node (`symbol:<name>@<path>`) as the graph start; the list is capped at 40 with the count of what is left out, and a summary line counts matching, unplanned and untouched before the cap. A plan name the hub withholds (screened out or malformed) is counted, and the line then says a symbol marked unplanned may be in the plan. Without code facts the group reads `unknown (no code facts)`, and a private task has no group at all, so the sheet shows nothing for it.

Task detail also shows an `overlaps` block (task 379), using the hub's read-only
`symbolOverlaps` projection of its existing open-task/other-owner overlap selection.
Each row names the other task ID and screened shared paths. A row says "same file,
different symbols" only when the same current screened predicate used by completion
notices establishes observed disjointness; otherwise it remains an ordinary overlap.
The block states "observed names only, deleted definitions may be missing". PII tasks
are excluded on both sides by their markers, even if the routing locality limit is
disabled. No pair result is stored, and the console never infers
one from its own plan or receipt. Missing fields on older hubs show no block; an
empty list says `none`. At most 40 pairs and 40 paths per pair are listed, with
omitted counts. Related-note counts remain a later slice.

When both tasks have complete public observations and non-empty disjoint sets
for every exact shared file, a completed-change notice says "same file, different
symbols" with the observed-name/deleted-definition ceiling. It still tells the
recipient to check the completed work. Missing or partial evidence keeps the
ordinary notice; plan-time overlap and coverage gates are unchanged. The receipt
keeps one current head, with at most 500 entries and 64 KiB total. This is the
data slice; the formatted Code panel and memory links follow separately.

`hub_review` takes `coverage {reviewed, skipped}`: in enforce an approval that leaves
a reviewable path unaccounted is refused, and advise notes the gap in the verdict
(#520). The hub
records how each review turned out, per implementer, reviewer and class:
approved; caught (changes were requested and the owner's redo was approved);
contradicted (within a week, work on the same file or symbol failed its check
or review); escalated (after the reviewer asked for changes). A record counts
tasks, not verdicts. `ahub task show <id>` lists a task's outcomes and `ahub
route explain` shows each reviewer's record with the implementer. `ahub route explain <id>` also prints the planner walk (`planner candidate X: ...` lines, then `planner: X (rotation | named | kept)`): the same planner walk used when a new or pulled task records its planner (#525-2, #525-3). The task detail, dashboard and console show the recorded planner and selection reason; only that effective planner or the person may change its planning. A peer that accepted or finished a task never reviews it; when every eligible reviewer did, the person reviews and the trace says so. With
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
tasks are left out on both sides. Overlap is compared only between tasks in the
same repository (#476): a task's repository is its `refs.repo` (an `owner/name`
slug or a checkout path, accepted by `hub_task_propose` and `hub_task_accept`),
else the common git top-level (or common parent) of its absolute paths outside
the project, else the project. A board with one repository behaves as before. `refs.repo` is metadata
only: it grants no file access and changes no execution root.

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
changes_requested or by hand stays excluded on every later reroute. A decline
with `capacity: true` (`hub_task_decline`, "no room right now") is the
exception: it skips that owner for this move only, and a later reroute or
planner pull may offer the task to it again (#531). An owner
released as gone, or moved by the hub after a failed delivery or inference, is
excluded only from that move and may get the task again from its reservation
later. Your own `ahub task assign` is not blocked by those exclusions, and it
drops the agent's reservation. The PII constraint and capability limits
still apply, so a PII task goes to `local` or nobody whoever was reserved.
`ahub task assign` on a task that waits changes its reserved owner instead of
handing it over. On a task that does not wait, an assignment whose named owner cannot take
the task now (offline or not attached, excluded, a capability or PII limit, or
an enforce-mode SDLC gap) is refused with the reason and the task is unchanged;
assign again once the peer is attached (#601). When a proposal names an owner,
a self-claim included, and that owner did not get the task, the proposal's
result says why and names `hub_task_assign`. `ahub route explain <id>` names the reserved owner; once the
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
ahub report --dogfood [--since 7d|<iso>] [--json]   # read-only scorecard: flow, quality, cost, delivery, performance, adoption
```

`ahub report --dogfood` (#687) reads the event log, `hub.log`, the board and the delivery journal in `hub.db`, up to 16 recently merged
PRs through `gh`, and the feature table in `docs/dogfood.md`. It covers the last seven days by default, takes no `--by`, and prints the same
document as `--json` with `unknown` in place of null; missing or truncated evidence is unknown, never 0. It exports ids, timestamps and counts
only and runs no model. Its bounds and the weekly routine are in [dogfood](dogfood.md#weekly-scorecard).

Per peer and model route, `ahub report` also counts model changes between consecutive
decisions, how many of them landed inside tool loops and, with `stay_switch` on, sessions
and the planner's switches (#197). With `stay_switch = "off"` session boundaries are not
recorded; `shadow` routes exactly as `off` does, so it is the baseline to compare `enforce` with.
A route event records the decision, so a load-moved request that its MLX fallback served counts
as a change to `dgx/fast`; the relay's request journal records which backend served it.

The event log also keeps the history of limits (#683). Each Codex update that adds tokens writes a
`usage` event with source `codex_appserver` next to the existing `tokens` event, split into input, cached
input, output and reasoning, so re-sent cached context is visible. A budget pause writes `budget_pause`
and its end `budget_resume`, with the window, the reset time and who ended it (`hub`, or `person` for an
`ahub budget resume`). A window's reset writes `quota_reset` when its `resetsAt` moves forward or its `used`
falls by 0.5 or more inside one window id, once per peer, window and `resetsAt`. These events hold ids and
numbers only, add no protocol version and are ignored by a reader that does not know them. `ahub report`
does not show them: `ahub usage` and `ahub usage limits` read them (below), and the console's Usage tab shows each peer's last resets (#683 U3). A dashboard Usage view shows the same roll-up in the Agents view (#683 U4, see [Operator console and panels](#operator-console-and-panels)).

`ahub usage` reads the same events from an incremental roll-up in `hub.db` instead of rescanning the log (#683):

```bash
ahub usage [--since 7d|<iso>] [--by peer|task|issue|pr|release|day|model] [--json]
ahub usage limits [--peer <id>] [--limit <n>] [--json]   # current quota windows, plus the newest 200 (up to 5000) pauses, resumes and resets
ahub usage total [--json]                  # lifetime development tokens since the first event, per peer and overall
```

The daemon folds `events.jsonl` into `usage_rollup`, `token_rollup` and `limit_events` from a stored byte offset, at most 8 MiB per pass, with a 20 ms scheduling slice checked between whole records (one record is indivisible),
only whole lines, and each pass commits its rows and the new offset together, so a crash repeats a pass and never half-applies one. A rebuild
from byte 0 gives the same rows (tested). A log that was replaced by a shorter one is folded again from the start. Before time slicing, on this project's 47 MB,
238k-line log the first fold took about 170 ms and a `usage` command about 95 ms, against about 150 ms for `ahub report --by task`, which
rescans the whole file on each call.
`issue`, `pr` and `release` are the board's current links of each task, read when you ask, so a task linked later is counted under its issue
for the history it already spent. A task with no link, and a record with no task, are `unattributed`.

Every number names its source: `native` (the provider's own counter), `hub count` (the hub's own `tokens` increments, which cover peers that
report no usage record), or `unknown`. Jcode's rows are `native` from 0.99.1 on: the hub records the per-turn buckets of its ACP prompt result as `jcode_acp` usage records (#801). Kimi's rows are `native`: the hub reads Kimi's own per-request counters from its session wire log and records them as `kimi_wire` usage records (#285 phase 2). Unknown is never shown as 0. `TOTAL` includes cache reads and `WITHOUT CACHE`
removes them; Claude's total is the sum of its four reported counters because its transcript carries none (`ahub report` still shows it as unknown), and a source whose input already
contains the cached part (Codex, the gateway) gets no derived total. A lifetime total that mixes a native and a hub-counted peer is labelled
`hub count`. When a peer is unknown the overall figure is `partial, at least`: a lower bound that leaves the named peers out, never a sum that counts them
as 0 (it is `unknown` when no peer is known). The overall `WITHOUT CACHE` is unknown unless every peer's cache split is known.
`usage limits` shows the newest 200 events and says `N older events are not shown` when it cuts (`--limit <n>`, up to 5000, shows more). A pause that the events
never ended and the hub no longer holds (cleared by `ahub reset`, which keeps the log as it was) shows as `pause ended, end unknown`, not as open. A private task shows its id and `[pii]`, never
a title. The person and a configured planner may read usage, in the console, the dashboard control link or the CLI; every other agent is refused.

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

## Hub memory

The hub opens the selected amem memory profile under `memoryHome()` (default `~/.agenthub/memory/`), with no claude-mem worker dependency ([how it works](memory.md)): notes saved
against an open task are short-term; when the task is approved its decisions, contracts and fails become long-term.
Task briefs, session-start recall and `ahub ask` read it first, and the dashboard has a Memory section.

```bash
ahub memory                              # this project's entries, newest first
ahub memory search parser                # every word must match
ahub memory show 1a2b3c4d                # one entry, its provenance and edges
ahub memory forget 1a2b3c4d              # a person's; also promote, demote, supersede, rebuild
```

`"memory": { "native": false }` in `.agenthub/config.json` turns it off for a project.

The exact-pinned `@staix/agent-mem` 0.13.0 resolves `AMEM_HOME`, then `$AGENTHUB_HOME/memory`, then `~/.agenthub/memory`. An absent `M/profile.json` selects shared v1; an explicit generation selects `M/generations/G` with the package's readonly legacy bridge. All daemon memory consumers and the hub memory/goal CLI use that selected profile. Invalid metadata or a missing selected generation makes native memory unavailable while the bus and board continue; there is no fallback to legacy writes. Inspect the daemon's memory binding/availability before interpreting missing memory as an empty store.

The daemon checks its selector at hub operation entry and before candidate/counter writes. It does not hot-switch handles or provide an atomic fence against selection changes during an in-flight core call. Quiesce consumers and close their handles before migration or selection changes; reopen through the supported session-preserving lifecycle afterward. Candidate/counter storage remains `M/candidates.db`, independent of `G`; since agent-mem 0.7.0 `amem review` also lists and accepts candidates on a selected generation. Every running hub using this home needs an authenticated receipt: a matching ready binding, or a generation-capable unbound receipt (`disabled` when native memory is off, `unavailable` when opening failed) proving it holds no memory handle. An unbound daemon and zero running hubs are quiesced for memory; a stale bound handle, unreadable registry or unknown runtime is not ready. Existing JSON memory/goal results remain unchanged; the additive binding receipt belongs to daemon status, profile-check and the decay object. This source integration does not authorize installing a new runtime, migrating real memory, restarting sessions or claiming real-machine sync/capture receipts. Migration/deactivation and their limits belong to [agent-mem](https://github.com/STAIxBWLB/agent-mem); see [the hub profile contract](memory.md#selected-memory-profile).

Run `ahub memory profile-check [--json]` from the person's terminal for the read-only preflight. It identifies live registry owners by signed process identity and authenticated daemon replies, then reports their loaded memory package and bound home/profile. The receipt names the current `AGENTHUB_HOME` registry scope; zero results establish no live daemon in that inventory, not system-wide process absence. Inventory and check separate custom registries too when they share `AMEM_HOME`. A missing or unreadable runtime receipt never counts as a different home or permission to migrate.

Before real migration, first upgrade every hub sharing the home to 0.12.30 or later. Obtain positive ready or unbound/quiesced receipts in every relevant registry; then quiesce consumers and close bound handles before changing the selector. A matching ready handle proves compatibility but is still an open handle. Verify synthetic cross-writes before the separately approved real migration, then reopen through the supported session-preserving lifecycle afterward. Merely installing this release does not authorize migration or provide live capture/device-sync evidence.

A curated split (`amem migrate --shards`) writes `M/shards.json`; from 0.12.37 the hub then opens this project's shard, with the user shard as its overlay, under the alias-resolved project key the `amem` CLI binds (#534, #537). Before splitting, upgrade or stop every hub using the home: a hub on 0.12.36 or earlier does not detect the split and keeps writing the old layout, which reaches the shards only through `amem migrate --shards --resume`. A split that is not active (captured, malformed, or a dangling or unreadable `shards.json`) makes native memory unavailable with that resume command as the remedy. An `amem alias add` that remaps a running hub's key latches its memory unavailable until a restart. `ahub memory profile-check` is split-aware: each running hub is compared with the shard profile of its own project, and an inactive split reports that resume command (#536). See [the shard binding](memory.md#selected-memory-profile).

Managed agents read through `hub_memory_search`, `hub_memory_show` and `hub_memory_graph`, with the server's project identity, the `memory_read` capability and current privacy screening. They cannot supply another project; private turns are refused. The tools bound UTF-8 input/output, screen before counts and truncation, and exclude their arguments/results from hub-managed capture. `hub_memory_correct` has its own `memory_correct` capability and records a screened correction candidate, not a note change. See [the complete memory contract](memory.md) for caps and refusal semantics.

Review candidates and rendered/delivered/cited counters stay in machine-local `M/candidates.db`, outside sync, import, recall, briefs, ask and graph evidence. Public changes-requested reviews with unmet items may propose a fail candidate; missing cause/retry details stay unknown. Acceptance is a person's `amem review` action with its TTY/policy checks, on shared v1 and, since agent-mem 0.7.0, on a selected generation. Read-time `(stale?)` hints and plan-fail advice never change stored rows or task authority. Structured fail notes are validated against 4000 UTF-8 bytes before screening or writes, with no silent truncation.

Recall presentation omits generated task-approval outcome notes and shows only nonempty reasons from generated changes-requested notes; an ordinary decision that merely resembles a header stays visible. Contracts and fails remain eligible. Capped recall lines preserve memory headers and end at word boundaries, and one delivery deduplicates ids across restored/current prefaces and shared note lines. Stored notes and brief evidence are unchanged; platform recall retains its budget split.

Between your machines, through a private git remote, with long-term tasks that span them:

```bash
ahub memory sync --remote git@github.com:you/agent-hub-memory.git   # once per machine; then every 10 minutes
ahub goal new "native memory"                                        # a long-term task
ahub goal                                                            # open ones, who holds each and until when
ahub goal take 1a2b3c4d --force                                      # take one over from another machine
```

Without a remote the periodic sync stays quiet; any other sync failure writes `hub memory sync failed: <reason>` to `hub.log` (task 401).

## Benchmarks

In a git repository kept for benchmarks (`"bench": { "enabled": true }` in its `.agenthub/config.json`, a clean tree),
`ahub bench` runs a suite of tasks against the peers attached to its hub and compares configurations: pass rate, first
pass, tokens and wall time per attempt, with bootstrap intervals between arms. Each attempt resets the tree to the
task's commit, so never enable it in a project you work in. The project must be the root of its repository with
nothing tracked under `.agenthub/`, and the suite file lives outside its tree ([suite format and store](bench.md)).

```bash
ahub bench run ../suites/suite.json --arm baseline --repeat 5   # the person's or the conductor's: resets the tree, proposes the tasks
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
- When HEAD moves during a turn, the hub reads the appended HEAD reflog (bounded to 64 moves and 128 KiB). The turn's own commits, amends, cherry-picks and rebase picks still count as its changes. Files brought in by a pull, merge, rebase start, branch checkout or fast-forward reset are left out, unless they are still dirty at the turn's end. An unreadable or ambiguous reflog, a rewinding reset, or a file touched by both kinds of move makes the turn's files unknown (#576).
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
- A turn the hub stopped in the middle of shows the state `no end snapshot` and
  cannot be undone. So does a turn whose boundary evidence is unknown: snapshot
  Git calls made in one callback burst share a 250 ms budget, and a capture that
  runs past it, fails, or sees HEAD move while it is taken is unknown, never a
  stale baseline (hub.log says `snapshot unavailable` once per burst). A turn
  whose diff or HEAD-move evidence cannot be read is unknown as well (#576).
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
  opened without following links; larger ones are named without a diff, compared
  by size and modification time, or by their bytes while written in the last 2 s
  (4 MiB or less each, 16 MiB per store per event-loop turn), since a same-size
  rewrite within one filesystem timestamp tick keeps the stat. Facts never go through the bus or the delivery journal;
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

## Always-ask action policy foundation (#636)

The classifier, local configuration and session budget counter decide. The managed Claude PreToolUse hook (including the headless Claude implementer, #525-4), ACP permission requests with a host gate, received Codex command approval requests, and the hub-owned local/Pi tool boundary consume the same policy. Jcode still has no hub pre-tool approval path and remains listed as not enforceable. A default-on policy adds a pre-tool check only where the hub sees the call before it runs, and each peer's status row says whether it does.

What is enforced, and where it is not:

| Peer | Enforced | Not enforceable (the status row says why) |
| --- | --- | --- |
| Claude (`ahub claude`) | the managed PreToolUse hook returns `ask` for a classed call in `ask`, `ask-when-needed` and `never-ask` alike, and `ask` beats every allow the hook would add | a session with no hub permission hook, or one whose attached session has not yet run it (the launch record outlives the process, so it proves nothing alone: the status row says `no live Claude session has run the hub permission hook yet`); an `--unattended` launch (`--dangerously-skip-permissions` skips every permission check, hooks included); a hub that cannot answer the hook leaves Claude's own policy |
| Kimi and other hub-owned ACP peers with a host approval gate (headless) | `session/request_permission` for a classed call is never auto-approved (not even for a hub-owned tool title), carries `Action approval (<classes>): <command>`, withholds `allow_always`, and under `ahub --unattended` still waits for a person and expires as a denial | a peer in its native `ask-when-needed` (`yolo`) or `never-ask` (`auto`) mode: Kimi sends no request for a call that mode allows, so the hub cannot see it; the status row says `its native mode never-ask sends no request for a call it allows`. Switch the peer to `ask` to enforce. A request whose payload the agent did not report is not classed (unknown follows the mode) |
| Claude headless implementer | the managed hook asks for classed calls, and the current-child-bound prompt tool accepts only a person's allow-once or denial; ask and ask-when-needed retain their native requirements | an idle/offline implementer without a current child; never-ask and unattended are refused at startup |
| Codex app-server | received command approval RPCs (v2 command execution or legacy exec) are classed before reaching the TUI; a classed request offers only allow-once/deny and an explicit bounded class-budget choice | status conservatively says not enforceable: native policy can execute without emitting an approval request; never-ask sends approvalPolicy never. writeStdin, absent/unknown payloads, file-change and permission-profile requests retain native handling |
| Local worker and Pi | every model tool call is classed at the host permit boundary before never-ask, ask-when-needed or Pi's tool-wide grant; unattended never answers a classed request. Pi replayed call ids return the stored result without spending again | an offline local worker or Pi without a verified live bridge; Pi's verified person-authored idle shell remains the person's command, not a model tool call |
| Jcode | no hub pre-tool approval path | always-ask not enforceable; its unmanaged native policy remains authoritative |

Class budgets: the approval of a classed ACP, received Codex command, local or Pi call offers one extra choice, `Allow <class> xN for this session`, when the class budget is above one. Only that choice (never an ordinary allow) spends the ledger: it allows this call and the next N-1 of the same classes in the same native session, then asks again; several requests open at once share it, so a budget of N never lets more than N approved calls through. A new native session, a changed policy or a stopped, crashed or restarted peer starts from zero, even when it resumes the same session id. A budget of one is the single call the ordinary allow already covers. Claude's own permission dialog cannot carry that choice, so every classed Claude call asks. Local/Pi show the complete tool title plus its class on the person's console, including private turns. Other surfaces retain the screened public view. Any view that remains cut (`[cut, N chars]`) or withheld offers denial only, with no allow-once or class-budget choice.

Only ignored, untracked `.agenthub/config.local.json` can hold `action_policy`. Its optional keys are `enabled` (default true), `always_ask` (a distinct subset of publish, external-write, destroy, install; default all), and `budgets` (per-class integers 0..1000; defaults 1, 5, 3, 2 respectively). Shared `config.json` cannot set this policy and gets no confirmation offer. A tracked or unknown-trust local file is ignored. Use `ahub settings set action_policy.enabled <true|false>` or `ahub settings set action_policy.budgets.<class> <n>` for registered settings; change `always_ask` in the local file and use the existing confirmed terminal reload. Policy publication invalidates cached grants and pending approval challenges. Startup reads the untracked local policy without a retained confirmation. A policy that disables enforcement, omits a class or increases a class budget appends an attention notice to every status policy row. `ponytail:` this makes weakened startup policy visible, but the startup confirmation ceiling remains open; the upgrade is retained person-bound startup confirmation.

The ledger asks first and after the approved class budget is spent. Adapter integrations must request that class allowance explicitly; an ordinary one-time answer does not seed the cache, and a cached budget never suppresses a prompt required by the native mode. One approval includes its own invocation; budget zero asks for every invocation. A fresh native session resets counters, and status polls do not bind sessions. A command with no classed literal prefix retains native permission handling; around a shell expansion the literal words are classed, and where the opaque part could change the class the strictest reachable class applies (#756, #762; [security](security.md)). This foundation never changes a sandbox or bypasses a denied permission; per-adapter enforcement tests land with their integrations.

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
| Claude | Allow resolving project file tools outside .agenthub/.git/.claude/.codex/.qwen/.kimi/.kimi-code/.jcode/.pi/.mcp.json/.agents/.agent/_agents/_agent/.gemini/.grok/.claude.json | Hook allow for every tool | No hook decision |
| Pi and local | Grant write/edit outside native agent configuration paths and proven read-only shell calls; other shell/git writes ask | Grant each tool once within the existing sandbox/guard | Normal approval handling |

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
verified dead wrapper and native identities permit crash cleanup. Managed direct
binary launches record their native PID while running; crash cleanup also requires
that PID to be absent from the process table. Scripts/interpreters and unavailable
process evidence retain the settings file. Every launch atomically replaces
`claude-launch.json` with its current managed hook/session identity. Native PID
proof is separate in a private `claude-native-<binding-hash>.json` file, so an old
callback cannot overwrite a newer launch record. Only that native proof uses
`claude-launch.lock`, published with its signed owner already written. It waits
up to 250 ms for a verified live owner. An empty, unsigned or unverifiable lock
is retained and disables native identity/crash cleanup for this launch; the
warning names the path and what is off. Managed hooks and session observations
still use the newly published launch record. Inspect the named lock and verify
its owner has ended before removing it; a signed dead lock is recovered. Without
separate native identity proof, old settings remain for manual inspection. Settings carry
no inline caller values in argv. Status reports an unverified Claude hook as
unverified. Unattended native sessions cannot take a runtime mode; restart
without that native flag. Codex must be behind the hub proxy, and returning to
ask while attached requires a known native approval baseline. If unavailable,
close the TUI, then run `ahub permission codex ask` before starting `ahub codex`.
For a known baseline, a detached proxy keeps restoration owed per thread and sends
that policy once on the resumed thread's next accepted turn. Visiting another thread
does not clear the debt. The restoring turn uses that kept baseline even if the
TUI echoes the resume response's sticky override, whether ask was selected before
or after that resume. Rejected turns retain it. The protection covers that one
restoring turn. A later TUI turn that repeats the policy looks exactly like a
person's explicit native policy choice and is passed through; the proxy cannot
resolve that ambiguity. An explicit choice on the restoring turn is delayed
until the following turn. A baseline that was never reported
is explained in the CLI reply, and that old thread keeps its last policy.
An offline or absent peer accepts
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

## Change the participating peers while the hub runs

`ahub roster` lists every known peer, whether it participates, its start mode,
current state, queued messages and open tasks. `ahub roster --json` is the same
ordered catalog view for scripts. Status and the console keep their existing lazy
rows; an off-roster peer is shown only while it has retained messages, an uncertain
delivery or open work, with the words `off roster`.

```bash
ahub roster
ahub roster remove kimi --yes         # print the preview, confirm and remove
ahub roster remove kimi --yes --now   # stop a busy owned runtime before handing work over
ahub roster add kimi
ahub settings set roster.kimi false --preview
ahub settings set roster.kimi false --yes
```

These are person's commands and use the same settings preview, write and undo as
the dashboard's Roster settings. An ordinary dashboard session may remove a peer;
adding requires `ahub ui --settings` or a person's terminal. Removal requires the
peer id as confirmation. Without `--now`, a busy peer is refused. A conductor
holder cannot be removed until its role is moved.

Removal fences membership, stops hub-owned runtimes or detaches sessions in a
person's terminal, and then hands work over. The removal preview and result name
the peer whose existing work the person must stop in that retained terminal;
the preview names the roles offered and those with no eligible replacement; the
result lists the saved owner/reviewer moves and every assignment that stays. No stop notice is forced into
a detached session and nothing bypasses the journal. Codex 0.146.0
exits its TUI on the close-4000 disconnect and does not reconnect automatically.
Its app-server and proxy remain available; after `ahub roster add codex`, run
`ahub codex resume <thread-id>` (the full id is printed in the preview, removal
result and return) or `ahub codex resume` to select its previous native session. Removal never closes
the terminal window itself. The Claude channel retries and reconnects on return.
Pi return retains the verified owner's monotonic generation even after refused
native activity while detached; it shares no personal output and invalidates any
cached empty-session resume proof after that activity. Return also needs the
current hub extension, which fences prompt admission: a TUI still running an
older extension is refused (restart its retained terminal), and a return whose
snapshot raced native activity is refused until retried. When personal TUI
activity overtakes a hub prompt, Pi is detached: a prompt the extension proves it
never inserted returns to the queue, anything else is held as `needs_review`.
It leaves queued and held deliveries, and existing manual or budget pauses,
untouched. The queue listing names `off roster` as the membership hold. Returning
and starting the peer makes retained queued messages available again; held
uncertain work still needs the existing queue resolution command. A detached
personal Pi TUI with a live owner still blocks controlled recovery as `pi is not
settled`; end that retained TUI before restart/upgrade. The hub does not declare
a live native owner settled or close it implicitly during preparation. Open owner and
reviewer work, including ownership of `in_review` tasks, is offered through the
existing reassignment path; a transferred review keeps its review state. If nobody can
take it, its assignment stays and a notice names the person's next action. Task
text in a notice uses its public title, so a private task remains a stub. A stop
that is unconfirmed leaves the roster saved and reports that permission reset and
handoff were not attempted; reapply the removal after checking the runtime.

A hub task, verdict, review or budget message addressed to an off-roster peer
stays in its retained queue, with one public notice to the person. Task operations
use the current owner and reviewer after reassignment. A mixed addressed audience
receives the on-roster copies now and retains the off-roster copies; the sender
sees the existing notice field (or a decision note for native answers). Broadcasts
exclude off-roster peers; a person or agent addressing only removed peers is
refused before publishing. The dashboard roster undo has its own peer-id
confirmation and optional active-turn stop checkbox.

Without a roster setting, participation keeps the previous defaults. An explicit
`roster.pi` overrides `pi.enabled`; otherwise that legacy switch continues to
control Pi starts. External peer ids remain governed by their existing admission
rules. A runtime permission override is cleared on removal and the configured
default governs the next attachment. Config file edits outside the authorized
roster setting do not change running participation: they take effect at the next
hub start. The tracked config can provide defaults and config.local.json can
override them.

## Settings from the dashboard and the terminal

In `ahub console`, press `6` for Settings. Existing operational-tab arrow cycling
is unchanged; from Settings, Left returns to Events and Right to Peers. Select a
row and press `e` to edit: value, daemon preview, nonempty reason, then `y`. Press
`u` to preview and confirm undo. Undo binds the key and exact undo-record digest;
if another write replaces that record, preview again. For busy roster removal,
the panel names `ahub roster remove <peer> --now`, which explicitly stops an owned
runtime or detaches a native session during its active turn; the panel does not force it.
Esc cancels, and pasted confirmation text cannot
write. This panel uses the current authenticated daemon connection. `c` edits
structural configuration and `R` prefills `restart` while a restart is pending
(see [Structural configuration](#structural-configuration-from-the-console-and-the-dashboard-issue-689)).

The dashboard's Settings section and `ahub settings` show and change the same
closed list of settings (issue #269). Run them from a plain terminal:

```bash
ahub settings                      # every setting: value, source file, when it applies
ahub settings get permission.kimi
ahub settings set routing.classes.implement.peers codex,kimi,pi --preview
ahub settings set routing.classes.implement.peers codex,kimi,pi
ahub settings set permission_modes.kimi ask-when-needed
ahub settings set research.enabled inherit   # remove the machine-local value
ahub settings undo                 # put back the file the last write changed
ahub settings reload               # validate and apply the complete four-file candidate
ahub ui --settings                 # dashboard with a 15-minute settings session
```

A guarded file edit that the daemon keeps at its accepted value remains visible as `config retained: <keys>; run ahub settings reload` in status, the console and Settings. The entry clears when the file value is confirmed through the terminal reload or reverted. Starting a peer whose launch keys are retained first explains that it uses the running value; the pending file value is not applied merely by restarting that peer. Public status and notices show key names and reasons, never the retained setting values.

| Group | Keys | Stored in | Applies |
| --- | --- | --- | --- |
| Permissions | `permission.<peer>` (the mode now) | the running hub only | at once |
| Permissions | `permission_modes.<peer>` (the default mode) | `config.local.json` | next peer start |
| Start | `peers.pi.start_mode`, `peers.codex.start_mode`, `peers.kimi.start_mode`, `peers.jcode.start_mode` (`tui` or `headless`) | `config.local.json` | that peer's next start |
| Start | `pi.auto_start` | `config.local.json` | next startup/recovery auto-start decision; never starts a peer merely on reload |
| Routing | `routing.stay_switch`, `routing.classes.<class>.peers`, `.escalate_to`, `.route`, `.pi_backend` | `routing.local.toml` | at once |
| Switches | `research.enabled`, `approvals.notify`, `snapshots.enabled` | `config.local.json` | live, without disturbing an active turn |
| Switches | `coordination` | `config.local.json` | newly created tasks only |
| Switches | `task_sweep.enabled`, `.auto_reassign`, `.interval_s`, `.unaccepted_min`, `.idle_min`, `.review_min`, `.ready_min`, `.ladder_min`, `.no_writes_turns` | `config.local.json` | live; `.no_writes_turns` sets the turn threshold independently; other keys reschedule the sweep timer |
| Routing | `tasks.wip_limits.<peer>` | `config.local.json` | live |
| Routing | `tasks.escalate_after` (1-10, default 3: consecutive `changes_requested` before a task moves to the next `escalate_to` peer) | `config.local.json` | live; the next verdict uses it |
| Switches | `tasks.auto_pull` (default off: pull the top explicitly reserved ready card when a planner slot frees) | `config.local.json` | live; the next freed planner slot uses it |
| Roles | `planner` (one or up to eight planner holders) | `config.local.json` | at once |

- Writes go only to `.agenthub/config.local.json` and `.agenthub/routing.local.toml`,
  the machine-local files (`ahub init` ignores both in git). The shared
  `config.json` and the hand-written `routing.toml` are never rewritten, and a
  machine-local file that is committed to git is refused. Each write is read by
  the hub's own loader first and replaces the file atomically.
- `routing.local.toml` overrides `routing.toml` key by key and may hold only the
  routing keys in the table. `ahub route explain` and the Settings rows name the
  file each value comes from. `--preview`, and the dashboard's Preview button,
  show `ahub route explain` for the open tasks before and after, or what a
  permission mode grants, and save nothing.
- A row shows running and file values, source and apply class (`live`, `next use`,
  or `restart`). Pending restart keys and reasons also appear in status, console
  and dashboard, including startup-only blocks outside the editable registry.
- Settings writes and undo, the dashboard Reload configuration button and
  `ahub settings reload` use one complete validation/apply path. Debounced changes
  of config.json, config.local.json, routing.toml and routing.local.toml use it too,
  including atomic file replacement. Invalid candidates apply nothing and emit
  one bounded error notice. Valid but unauthorized keys retain their accepted value and are reported per key; other eligible changes still apply. Recovery/shutdown hold reloads.
- Individual writes and undo publish only the named setting. Other file edits remain unapplied.
- `ahub settings reload` lists guarded keys with complete before -> after values (including full argv) and any planner/conductor holder effect. It requires an interactive terminal and exact `y` within 30 seconds before adopting them. Oversized previews remain unapplied and must be split or reduced. Candidate bytes or accepted state changes invalidate that confirmation. Watchers and ordinary dashboard reloads never confirm a raise.
- Privacy tightening (local PII constraints/screening, added PII patterns, nonholder role reductions and explicit capability-list narrowing) is automatic, including tracked files. A planner/conductor holder change is guarded even when a role list shrinks; deleting a restricted capability entry restores all capabilities and is guarded. Reload checks the actual files' Git provenance. Changed machine-local or raising
  values from tracked/unverifiable files are refused; an ordinary dashboard or
  watcher cannot adopt unrelated raising local edits. A settings session cannot
  adopt routing fields outside its editable registry. Existing confirmation and
  roster lifecycle fences remain; use the confirmed roster setting for membership.
Pi relay model aliases (`pi.dgx_coding`, `pi.dgx_fast`) and `routing.pi` retain their running values until restart, because existing native sessions use the published relay catalogue and context contract. Routing policy changes apply to future decisions; local model changes apply at the next peer creation.

- Runtime/client ownership still requires restart for memory handles and sync,
  gateway/MLX, runner/check commands, profile/tool contracts, converters, existing
  session privacy/sandbox policies, the terminal provider and benchmark environment.
  The exhaustive reasons are in the issue #439 spec amendment. A pending file value
  is not applied to the running consumer. Coordination creation pins last for the daemon lifetime; a restart re-pins retained rows to its startup mode.
- `ahub settings undo` (the dashboard's "Undo last write") puts back the one
  previous version of the file the last write changed. It refuses when that
  file was edited since, and when it would put a stored never-ask back (set it
  again with its confirmation instead). A mode changed for the running hub is
  not a file: set it again instead. Setting a value it already has, or
  removing one that is not set, writes nothing. A project with no
  `.agenthub/config.json` gets no first config file from a settings write
  (any config file turns the project defaults on): run `ahub init` first.
- A project initialised before 0.12.23 has no `.gitignore` line for
  `.agenthub/routing.local.toml`: run `ahub init` again, or add it. A
  `permission_modes` value is read only from a file git confirms nobody
  committed (config trust); where the hub will not read what was written, the
  reload refuses the guarded candidate and the Settings row identifies the file.
- Authority: a dashboard opened with `ahub ui` reads settings, lowers a mode to
  `ask`, turns `pi.auto_start` off, sets a start mode back to `tui`, sets a WIP
  limit to 0, turns `task_sweep.enabled` or `.auto_reassign` off and changes
  the other Switches. Everything
  else needs `ahub ui --settings`, whose session may raise for 15 minutes, or
  `ahub settings` in a terminal. `never-ask` needs the peer id typed in the
  dashboard, or `--yes` in the terminal, and a stored never-ask default still
  waits for `y` in `ahub console` at each hub start. Tool approvals stay
  deny-only for Pi and local in every session.
- Commands and binaries, credential files, gateway URLs and the local worker's
  reach are never editable here: change them with `ahub settings edit` in a
  terminal, each confirmed by typing its name (tier 3 below), or edit
  `.agenthub/config.local.json` yourself.
- Every change is announced in `hub.log` and open consoles with its source and
  recorded as a `settings` event. `ahub settings` needs a running hub; an older
  hub answers the request as unknown and the CLI advises upgrading. The unified
  dashboard (`ahub ui --all`) acts as an ordinary session.

### Structural configuration from the console and the dashboard (issue #689)

Instances, the review and approval blocks and the lifecycle can be edited without an editor. The hub reads the candidate with the loaders it starts with (`readInstanceConfig` and `validateInstances`, `loadConfig` with its effective-config bounds, `checkJcodeInstanceHomes`, `sdlcConfig`), shows a diff and writes only after a person confirms. Three tiers:

1. **Registry settings** (everything above) are unchanged.
2. **Structural keys**, editable in the console and in a dashboard settings session:
   - `instances.<id>` with `kind`, `roles`, `start_mode`, `review_mode`, `readOnly`, `worktree` and `permission_mode`, in `config.local.json` (`review_scope` is tier 3 and not editable here);
   - `review.adaptive`, `review.min_reviews`, `review.pool`, `review.rerotate`, `review.same_family`, `snapshots.keep`, `approvals.timeout_s` and `context.gate`, in `config.local.json`;
   - `mode` and `required_checks` in `.agenthub/sdlc.toml`. Only those two lines change: comments and every other table stay as written, and a layout the editor cannot change faithfully (a key repeated, or one inside a multi-line string) is refused with its own reason.

   `roster.*`, `tasks.wip_limits.*`, `permission_modes`, `peers` and the rest of the registry keep their own `ahub settings set` path.
3. **Executable and secret-locating keys** are console only: the rest of `NEVER_EDITABLE` (`kimi_cmd`, `jcode_cmd`, `codex_bin`, `pi.cmd`, `checks`, `mlx`, `omniroute`, `terminal`, `adapters`, `adapter_modules` and the like) and the Jcode instance fields `jcode_home`, `provider`, `model` and `provider_profile`. The console shows "this runs code with the daemon's rights, or chooses where secrets are read from" and writes only when the key's exact name is typed, one key at a time; `--yes` never confirms one. The dashboard lists each of them with the console command that changes it and nothing else: no value, no path, no input. A forged dashboard request for one is refused by the hub.

In the console (`ahub console`, Settings tab `6`): `c` asks what to edit (`1` an instance, `2` the lifecycle, `3` another key), asks each field, shows the hub's diff or its loader reason, asks for a reason, then `y`. Esc cancels at any step, and pasted text never confirms. `R` appears while a restart is pending and prefills `restart`; the command still asks its own `y`. In the dashboard, open `ahub ui --settings`: the Structure group has the same forms; outside a settings session it is read only.

```bash
ahub settings edit config.local.json set instances.codex-review '{"kind":"codex","roles":["reviewer"],"start_mode":"headless","review_mode":"fresh"}' --reason "add the fresh reviewer"
ahub settings edit sdlc.toml set mode '"enforce"' --preview
ahub settings edit config.local.json remove review.pool --yes
ahub settings backups              # the newest backups of each file
```

Rules:
- A missing `start_mode` on the fresh `codex-review` reviewer shows the loader's reason (`fresh requires reviewer-only roles, headless mode ...`), names the field and writes nothing.
- The edit carries the revision (a sha256, or `absent`) of the file it was read from. The hub checks it when it plans the edit and again immediately before it writes, so a file changed on disk since is refused with a hint to reload and review again.
- The previous file is kept in `<state dir>/config-backups/` (the newest five of each file; `ahub settings backups` lists them) and the new one replaces it atomically. A `config.local.json` that git tracks is never written. Unknown fields and unknown keys are refused by name, never dropped.
- A whole instance that holds a native home, account or model (`jcode_home`, `provider`, `model`, `provider_profile`) is tier 3 to remove or replace, so a dashboard can neither see nor delete those values; an existing instance changes leaf by leaf (`instances.<id>.<field>`), and `clear` removes one field. A preview or write shows a tier 3 value only as `(set)`, and a write changes exactly one tier 3 key, counting the keys the file adds (removing two Jcode instances is two writes, each confirmed by its own typed name). The audit record gives a tier 3 key no value hash at all, because a model or provider name is easy to recover from an unsalted hash; the file revisions bind the change instead. An instance already in `config.local.json` is changed leaf by leaf even before a restart has started it. If `.agenthub` or `config.local.json` is a symlink, the Settings view reports its revision as `unavailable` and no edit is planned. An edit of `sdlc.toml` keeps the file's own line endings.
- Every write records a `config_edit` event: the file, each key path with a short hash of its value before and after (never a value), the file revisions before and after, the tier, the source (`dashboard` or `terminal`) and `by: person`. The notice and `hub.log` name key paths only.
- A changed instance declaration is restart-bound: it is listed as `pending restart` (`instances`) and takes effect at the next hub start. A changed `sdlc.toml` is read once at start and is listed as `sdlc.mode` or `sdlc.required_checks` until the running hub holds the same value. `review`, `snapshots`, `approvals` and `context.gate` publish through the one reload path, one key at a time.
- Person only: an agent shell or a hub tool is refused (`ahub settings` is a console command in the identity gate, and the three control requests answer only the console role). Recovery or shutdown holds every edit.
- The hub must run this release: an older hub answers `unknown message` and the command says to upgrade and restart it.

## Start modes: TUI by default, headless as opt-in

A peer that has a TUI the hub attaches to starts in it by default (issue #269).

| Peer | Default | Headless |
| --- | --- | --- |
| pi | `tui` | `ahub pi --headless` (or `--mode headless`), or `peers.pi.start_mode: headless` |
| codex | `tui` (`ahub codex`) | `peers.codex.start_mode: headless`: a hub-made start runs the app-server only |
| claude | `tui` (`ahub claude`) | none |
| kimi | `tui`, pull-only (`ahub kimi`) | `ahub kimi --mode headless`, or `peers.kimi.start_mode: headless` |
| jcode (optional) | `tui` on the hub-owned ACP session (`ahub jcode`) | `ahub jcode --mode headless`, or `peers.jcode.start_mode: headless` |
| local | headless (hub-native) | not applicable |

- **You type the command:** `ahub pi` opens Pi's TUI in that terminal.
  `--headless` and the start mode setting are the two ways to ask for the
  background peer. `ahub settings set peers.pi.start_mode headless` writes the
  setting; it applies at Pi's next start.
- **The hub starts the peer** (the dashboard's Start control, `pi` typed in
  `ahub console`, the conductor's `hub_peer_start`, `pi.auto_start`): it
  follows the peer's start mode. For `tui` it opens a terminal running the
  fixed command `ahub <peer>`, through a terminal provider:
  1. `terminal.open` in `.agenthub/config.local.json`, an argv in which one
     element holds `{command}` (the quoted command line to run); `{title}` and
     `{cwd}` are replaced too. Examples:
     `["tmux", "new-window", "-n", "{title}", "{command}"]`,
     `["wezterm", "start", "--cwd", "{cwd}", "--", "sh", "-c", "{command}"]`.
     Only a config file nobody committed may set it, and it is not a setting
     the dashboard or `ahub settings` can write. It is read at hub start.
     `{command}` is quoted for a POSIX shell; `{title}` and `{cwd}` are raw,
     so give each an argv element of its own.
  2. Orca, when the hub runs in an Orca worktree or an earlier `ahub <peer>`
     launch of this project recorded one (the path recovery uses).
- **No provider:** the start is refused with the command to run by hand. It is
  never downgraded to headless. `ahub settings` lists each start mode, and the
  dashboard's Start control says which mode a start will use and where its
  terminal comes from.
- **A headless start gets a watch pane** (#286 AC10): when the hub itself
  starts Kimi or Qwen headless (Kimi when its start mode is `headless`), it
  also opens `ahub watch <peer>` through the same provider, a fixed command
  with no caller text, at most once per 30 seconds per peer. The headless
  start has already succeeded, so with no provider, or one that fails, the
  start still stands and its result and the hub's notice give the command to
  run by hand. A start in TUI mode opens the peer's own terminal instead, as
  above; an already attached peer, a declared extra instance and a peer
  without the watch capability open no pane.
- **Dashboard Start:** the control is locked while its request is in flight. A confirmed answer unlocks it immediately, so a retry reaches the hub's own 30-second terminal reopen guard and shows any known refusal. The unified dashboard waits 35 seconds, covering a terminal provider's 30-second cap plus a 5-second response margin; a slower headless start can still end unconfirmed while the hub continues. Check the Peers panel before retrying. An unconfirmed unified-dashboard start holds that peer's control for the shared 30-second reopen bound, or until its `starts` snapshot confirms attachment, across redraws and project switches within the same hub instance; the row states the retry bound. The project-local dashboard keeps its usual confirmed-answer behavior. Other forwarded actions keep their 10-second wait; the manager opens no settings session.
- The conductor cannot choose the mode: `hub_peer_start` takes the peer's own.
- Recovery restores each peer in the mode its recorded session had. After an
  unplanned stop, a Pi that ran in a terminal is reported with its command and
  is not replaced by a headless one unless headless is its start mode.

### Kimi in its own TUI

`ahub kimi` runs Kimi in the person's terminal by default. The launcher atomically
merges only `mcpServers["agent-hub"]` in `.kimi-code/mcp.json`, keeping foreign
entries and fields. It contains machine paths and the peer identity, not a token.
`ahub init` ignores that file when it is untracked; a tracked file is still written
with a warning. `--print-command` shows the change and command without writing.
The configured `kimi_cmd` must be a single executable or end in exactly `acp`;
the TUI uses the executable or drops that final word. Other wrappers are refused
with the headless command rather than guessed. The launcher uses the running
hub's `kimi_cmd`; when that value has no TUI form, the refusal says so, since an
edited file value waits for `ahub settings reload`.

After three empty inbox reads within ten minutes by a pull-only peer with no assigned task or review, the hub adds polling advice and one console notice per streak (peer id and counts only); a delivery or assignment resets it, and restart clears the in-memory counters.

The TUI is pull-only. Its model reads `hub_inbox` at the start of work, between
steps of longer work and before reporting, and shares results, and mid-work
blockers or changed contracts, explicitly with `hub_send` addressed with `to`
(progress-only notes `[FYI]`). Status, the console and
the dashboard show `pull-only`, the waiting count and the last inbox read. Messages
and important markers do not push or interrupt it. There is no hub busy state,
watchdog, console approval, hub permission mode, context reading, automatic quota
pause/handoff, shared final answer or session resume. When important messages are
waiting, every other hub tool result ends with a line saying how many, so the model
reads `hub_inbox` before starting long local work (#398). One `hub_inbox` read drains the queue oldest first up to
64 KiB of rendered text and, when more waits, ends with `N more waiting: call hub_inbox again before you start work` (#713).
Read quota and approve tools
in Kimi's own TUI; a person can pause the hub queue by hand. End the native terminal
session there, not with `ahub stop kimi`.

Automatic routing never picks a pull-only owner or reviewer, even as the only
candidate. A proposer can name the owner or claim its own task; a person or the
conductor can name an owner or reviewer with
`ahub task assign <id> kimi --role owner|reviewer`. A waiting task reserves its
named owner; naming its reviewer is refused until dependencies are approved.
A named review waits in the same inbox. Queue holds and pauses refuse a pull with
the reason; an unaccepted assignment still follows the existing release deadline.

To switch to ACP, end the attached TUI and run `ahub kimi --mode headless`: the
person's command removes only the hub's project MCP entry before starting ACP.
A daemon-made headless start refuses a stale entry with that command and never
edits the project file. To switch back, stop the headless peer with `ahub stop kimi`
then run `ahub kimi --mode tui`. The peer id, queued messages and open tasks remain;
the ACP session is not resumed in the TUI. Agents cannot switch modes.

Projects with no explicit Kimi start mode also move to this default on upgrade.
The coordinating upgrade command announces it once; to keep ACP, run
`ahub settings set peers.kimi.start_mode headless`.

Source preflight checked Kimi Code 2.1.1 at
[f67e6398](https://github.com/MoonshotAI/kimi-code/tree/f67e6398fb3210ad8ace970e2dfd5bcc984ed61f):
trusted ACP workspaces read the user, repository-root and project MCP files, and a
passed session entry connects beside the project entry. Its model request path
uses tool definitions and managed AGENTS instructions, not MCP initialize
instructions. Folder trust, real TUI tool discovery and the model round trip are
still unverified live; see `docs/smoke.md`.

### Migration from 0.12.22 and earlier

Pi's default changes from headless to its TUI.

- `ahub pi` in a terminal now opens the TUI. For the background peer run
  `ahub pi --headless`.
- A project with `"pi": { "auto_start": true }` used to get a headless Pi at
  every hub start. To keep that, set the start mode once:
  `ahub settings set peers.pi.start_mode headless` (or add
  `"peers": { "pi": { "start_mode": "headless" } }` to
  `.agenthub/config.local.json`). Without it the hub opens Pi's TUI in a
  terminal at start, or, with no terminal provider, says
  `pi.auto_start did not start Pi` with the command to run.
- Scripts and the console's `pi` command: without a terminal, `ahub pi` asks
  the hub to open one. Add `--headless` where a headless Pi is meant.
- A conductor's `hub_peer_start` no longer takes a mode. A call that passes one
  is refused unless it repeats the peer's start mode.

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
notification that names the peer and, for Kimi, Pi and the local worker, the tool,
never what it would run. An unanswered request is cancelled after `approvals.timeout_s` (default
120, 30 to 3600) in `.agenthub/config.json`, and the console and log say so.
Pi and the local worker are told that nobody answered, and two such requests in
a row end their turn ([Pi/local unanswered approvals](#pilocal-unanswered-approvals)).
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

`ahub budget` (#285 phase 4) prints one row per window and a line for every attached peer that has no number. The KIND column says what the
number is, and SOURCE where it came from; MEASURED is its age.

| Kind | Meaning | Source examples |
| --- | --- | --- |
| `native` | the provider's own ratio and reset | `claude status line`, `codex rateLimits`, `kimi ACP usage-limit refusal` |
| `count` | tokens the hub counted, against a ceiling a person set | `hub count, kimi wire log, of kimi_tokens_5h 800000` (window `tokens`) |
| `manual` | a person fed it with `ahub budget set <peer> <0..1> [--window 5h\|week] [--resets-in 2h]` | `ahub budget set` |

A count never claims to be the provider's quota. For one window and peer a manual value replaces the provider's at the gate, and while any native
or manual reading is fresh the count is shown as `info only` and does not gate or feed routing headroom; when those go stale, or reset, the
count gates again. A provider's hard refusal clears the person's number for that window, so a pause is never outvoted. A peer without a number says
why instead: Pi and local print `no quota: on-prem ... has no provider quota` with the hub's own 5 h token count (information, never a meter);
Kimi without `budget.kimi_tokens_5h` says it reports context occupancy only; an unreadable Kimi wire log says so with a reason code; a peer whose
source has not reported yet says which. `--json` carries `kind`, `source`, `superseded` and a `peers` list of those notes; an older hub answers
without them and the CLI classifies a window by its source. `ahub doctor` adds the row `kimi usage source` (counting, no ceiling, or unreadable).
The console's peer detail (Enter on Peers) and the Usage detail, and the dashboard's Usage budgets row, show the same kind and source per window.

Kimi Code CLI 2.1.1's observed 5-hour usage-limit refusal creates a hard budget reading (`kimi ACP usage-limit refusal`). `ahub status` shows a budget pause and `ahub budget` shows its source and reset estimate. The refusal gives no reset timestamp, so the hub estimates the reset at five hours after it was observed and resumes on the next budget tick after the existing one-minute grace. With `budget.wait_max_min` below that estimate, the existing budget relay automatically hands open tasks to an attached eligible peer; routing skips Kimi while paused. No checkpoint is requested from an exhausted agent.
`ahub budget resume kimi` overrides the reading so the provider can be tried early. A new provider refusal ends that override and pauses it again; a pending soft checkpoint cannot postpone this hard pause.
During one hub run, an early override followed by the same window's refusal keeps its earlier future reset bound; a provider's explicit reset remains authoritative. A restored pause without a per-window reading cannot identify that earlier window, so its next refusal starts a new estimate.
Unread quota resume notices are coalesced without losing their public task moves; the next notice lists moves accumulated across those pauses. An older notice without structured move metadata is kept as public text inside that notice.

A refused prompt with no acceptance or activity is requeued without a review hold. At the estimated reset it is tried again; another quota refusal pauses it again without consuming the poison-envelope retry count. Work that already started remains held for review even while its open tasks move to other peers. After the quota reset its queue stays held: inspect `ahub queue show <delivery-id>` and the associated task, then choose `ahub queue resolve <delivery-id> --action completed|retry|discard --reason "<text>"`. Do not retry work that another owner already took over without inspecting it. If the hub cannot confirm the pause, the refusal is also held instead of spending retries. Other errors keep their ordinary review behavior. Only the observed Kimi 5-hour text is recognised; weekly/monthly limits and other ACP vendors, including Qwen, remain unverified. The recognised text and its provenance live in `src/adapters/acp-quota.ts`.

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

For an ACP peer (headless Kimi, Qwen, Jcode) a tool call that was announced and
has not completed or failed counts as running work, not silence: the inactivity
watchdog (`watchdog_ms`) keeps the turn alive up to a 30 min tool ceiling (never
below `watchdog_ms`) since the peer's last output, then cancels the turn as
before and logs which open tool call was silent (#542).

After the inactivity watchdog cancels a Codex turn, a late acceptance, answer or
completion from that turn is dropped and never reaches a later audience; its
delivery is held as `needs_review`. When the cancelled turn has no verified
native id, Codex goes offline and the hub logs `Codex cancelled turn has no
verified native id; reattach the native session before further hub delivery`:
end its TUI and relaunch it (`ahub codex resume <thread-id>`) before resolving
the held delivery.

### Claude sessions without channel pushes

Only `ahub claude` starts Claude Code with the development-channel flag. A
Claude session started another way (plain `claude`, an IDE) keeps the hub tools
but cannot show pushes, so it attaches tools-only (protocol 16, issue #205):

- Its messages stay queued. `ahub status` shows the queue count in `Q` and a `tools-only` detail:
  `messages wait for hub_inbox; for pushes restart Claude with ahub claude`; the
  console footer shows `tools-only: ahub claude` and the dashboard shows the
  status line.
- The session reads them with `hub_inbox`, which drains the queue oldest first (important messages marked, as ever) up to 64 KiB of rendered text plus
  the hub's recall note when one waits (#713; a push peer's digest is still ten items). When more is waiting the result ends
  `N more waiting: call hub_inbox again before you start work`. Each read is one `completed` delivery (`read through
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

When a hub reconnect changes the hub tools (names or schemas), the plugin asks
Claude Code to list them again (`tools/list_changed`), so a session that listed
them while the hub was down does not keep the short list (#490). A status probe
that is unavailable right after a restart is retried, then the list is
announced anyway.

### Replaced or ended Claude sessions (#551)

A replaced session says it is standing by. Its reconnect requests cannot reclaim
an attached or claiming peer, even if its status-file read missed that holder. A
channel-capable session may still replace a pull-only holder once its claim has
finished. Starting a new session intentionally keeps the newest-hello behavior.

A plugin carrying an older launch id than this daemon's current per-peer Claude
launch is refused with close 4430. It stops reconnecting, and hub tools report that
the launch ended. Start a new session with `ahub claude`, or use a plain session
with the tools and `hub_inbox`. A session with no launch id, or a hub with no
current launch record, keeps the existing behavior. The marker alone cannot
prove that a nested host loaded this specific MCP server as a channel; the
bridge currently receives no positive per-server activation signal.

### Claude channel sessions while busy (#493)

A Claude session started with `ahub claude` receives pushes when it is idle. While it is busy:

- Every hub tool result carries fresh counts, `(N queued hub message(s), M important hub message(s) waiting: call hub_inbox before starting long local work)`, when important work waits. A zero count clears an earlier hint. Under a delivery hold that refuses pulls, the counts and held rows stay but the `hub_inbox` advice is dropped.
- `hub_inbox` reads the daemon queue (and any local failed-push buffer) in a channel session too. A read is one `completed` delivery, like a tools-only read; holds refuse it the same way.
- An important message is pushed into the running turn (steered) instead of waiting for the turn to end. Mid-turn reading was verified on Claude Code 2.1.302; an older client that drops it leaves the delivery `accepted` until a person resolves it. Ordinary messages still wait for the idle push or `hub_inbox`.
- Do not use `[FYI]` for PR ready, done, submitted, ruling-needed, blocker or changed-contract messages: they need action. `hub_task_done` and `hub_review` already notify their recipients.
- Turn completion is read backwards in 4 MiB chunks, up to 64 MiB plus one row-boundary byte, whatever the transcript's size. A row crossing chunks is reconstructed whole; a row starting outside the bound stays unavailable. When no completed turn is found within that bound, the console says once per turn that the peer stays busy and its messages wait in its queue (#517).

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
uncertain. To stop one headless peer and keep the hub running, use
`ahub stop <peer>` ([Stop one headless peer](#stop-one-headless-peer)).

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

## The planner (#455)

Planner holders propose and split tasks and read project-wide grooming. Each
task's effective planner gets its backlog and sweep notices. `ahub status`
prints the holders with their source, the dashboard's Agents view shows a
Planner badge, and the console marks their rows.

- `setting`: `planner` in `.agenthub/config.json` or `config.local.json` (the
  machine's file wins), either one id or a list of up to eight distinct ids.
  Only those peers hold the role. Builtins are `claude`, `codex`, `kimi`, `qwen`
  and `jcode`; a declared planner-capable instance is also eligible. A singleton
  settings write stores a string for older configuration readers.
- `roles`: with no `planner` key, the `roles` planners stand. That is `claude`
  by default.
- `automatic`: when no rostered peer holds the role, the hub gives it to the
  first rostered peer of that list. It recomputes this at start and after
  each roster change, and writes nothing to disk.

Change it with `ahub settings set planner codex`, the dashboard Settings row
(a settings session, `ahub ui --settings`) or `l` in the console. Planning
holders and their backlog notices update at once. Use a comma list, for example
`ahub settings set planner claude,codex`, to select several holders and follow
any displayed holder-change confirmation. Role text updates at the next peer
start. `ahub settings undo` restores the previous designation. Agents cannot
change it.

New tasks record their planner through the same pure assignment walk shown by
`ahub route explain`. Only that effective planner or the person changes their
planning. A bound holder keeps authority while busy, offline or paused. If it
is removed or leaves the roster, authority falls back to the current holders;
the stored binding remains available for audit. Old tasks and releases with a
null planner retain the legacy holder-wide authority. PII tasks keep null.
The person names a different holder with
`ahub task assign <id> <peer> --role planner`; this leaves the owner, reviewer,
state and delivery offer intact. A planner-created release belongs to that
planner; a person-created release keeps null.

A plan review is the exception: another settled holder may review a plan even
when it is not that task's planner, without gaining its other planning powers.
An agent author cannot self-review while another rostered non-offline planner
exists. With no independent holder, the receipt says `selfReview: true`; it
also records `planAuthor` (null when unknown). A person's own-plan override is
marked self-review too. Independent requests contain ids only. Controlled
recovery requires `task_planners` once a list/instance planner is configured or
any task/release binding or plan-review authorship marker is stored, even after
that configuration is removed.

With the lifecycle on (an `.agenthub/sdlc.toml` mode other than off), a card's planners get a "The board
changed" notice (#758). The planner whose own write changed the board is skipped.
A planning revision, a dependency change or a new card is a task notice; state
moves, reviews and assignments are recorded at `fyi` weight (no turn), at most
once per planner per ten minutes. A newer notice replaces an unsettled copy, and
the hub's own bookkeeping tells nobody.

A task write also wakes the task's rostered planners when it frees capacity or
releases backlog work (#785): a lower WIP for the owner or reserved peer adds a
`capacity_released: <peer> WIP <n>; reserved ready #<id>|none` line, and an
approval that leaves a backlog card with no unresolved dependency adds
`backlog_ready: #<id>`. The lines go in one `Planner work ready:` task notice
per planner, ids only; a newer one merges and replaces the unsettled copy, which
survives a restart. By default nothing is pulled automatically: the planner reads the
board and decides. With `tasks.auto_pull` on (opt-in, see below) the hub itself pulls
the top card explicitly reserved for the peer whose slot just freed.

When `hub_task_done` leaves a review whose exact-head CI is not yet green (the
lifecycle must be on, the task linked to a PR and not private), the hub starts one watcher
for that head (#785): one `gh pr view` a minute, ended by the CI result, by a
45 minute deadline, by a newer head, a verdict or a cancellation, or by hub
shutdown; a restart does not restore it, and the next `hub_task_done` starts a new
one. On the result the owner and the reviewer each get one
`ci_completed: #<id> head <sha12> passed|failed|incomplete` task notice (ids only, the
head cut to 12 characters; a person reviewer gets a console line instead), and
unless CI failed, a review the hub held as premature for that head is offered
once more after a fresh readiness read. A deadline tells the console only. No peer turn waits for
CI, and nothing is polled outside a watcher.

`tasks.auto_pull` (default off, machine-local, live) lets the hub act on that
wake-up (#785). When a write frees a peer's planner slot, the hub pulls the one top
backlog card explicitly reserved for that peer, through the same planner pull a
planner makes: revision, dependency, reservation, pinned, frozen-release, P0 order
and WIP checks all apply unchanged, and a refusal becomes a console notice naming
why. Unreserved cards, cards reserved for another peer and private (PII) cards are
never pulled. One card per release, as the hub for the card's own planner of record:
the history entry reads `by: hub` with that planner and the reason
`auto_pull: capacity released for <peer>; hub acted for planner <planner>`. A hub that
is paused for recovery pulls nothing, also when the setting is turned off or recovery begins while a pull is already waiting on its screening: that pull writes nothing, and a recovery waits for pulls in flight. A committed `config.json` cannot turn it on: like
the other machine-local policies it is ignored there with a log line.

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
- discards hub notices a recovery hold kept back the same way, one entry per
  recipient, without delivering them; the dry run lists them as
  `q:<peer>:<id>`;
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
It never touches claude-mem or hub memory (`~/.agenthub/memory/`): notes saved with
`hub_remember` are shared memory, not hub state. Claude Code sessions attached to the hub lose their hub session;
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

## Agent CLI versions

Agent CLIs update themselves often, and a hub release cannot follow every one. One policy decides each gated CLI: the Codex and Kimi fresh reviewers, the headless Claude implementer, Jcode, agy, Qwen and Pi (#691, #847). Qwen has two entries: `qwen` for headless ACP and `qwen-dual` for the dual-output TUI (#286).

- `ahub agents [--json]` lists each gated CLI with its version, verdict and verified versions.
  - **verified:** a receipt exists.
  - **in-line:** untested, inside the compatible line that a contract gate (Jcode, agy) declares; it starts with a note.
  - **trusted:** you accepted this exact version on this machine.
  - **refused:** the reason names the installed and verified versions and the command that admits it.
  - **unknown:** the CLI is not on PATH, or its version could not be read.
- `ahub agents trust <id> <version>` accepts one untested version on this machine (`~/.agenthub/agent-compat.json`); `--revoke` undoes it. Only the person can run it; agent shells are refused.
  - For the reviewers, trust lifts only the version pin. The MCP inventory, Apps/plugins/hooks readback, sandbox denial fixtures and binary fence still run before every child, and a failed leg still refuses.
  - What trust cannot prove is printed when you trust.
- `ahub doctor` shows one line for each installed CLI that is not on a verified version.
- A daily workflow (`.github/workflows/agent-compat.yml`) runs `scripts/agent-compat-watch.ts`, which reads the latest published version of every gated CLI that has a public source: the npm packages `@anthropic-ai/claude-code`, `@openai/codex`, `@moonshot-ai/kimi-code`, `@qwen-code/qwen-code` (for both `qwen` and `qwen-dual`) and `@earendil-works/pi-coding-agent` (for `pi`, since #847 gave it a COMPAT entry), and the GitHub releases of Jcode. agy has no public source, so its row reads "no public source; local drift only" and is never a failure. Every COMPAT entry names the receipt to repeat (`receipt`), and a test requires that file to exist and the entry to have a watcher source. A version that cannot be read reads as unknown, not as a crash. The workflow keeps one `agent-compat` issue current while a source is ahead and closes it when none is.
  - **Maintenance loop (#843):** the daily upstream watch is the trigger; `ahub doctor` is the local drift notice for versions installed on a machine, and the hub itself tells the planner (below). The planner files one receipt task per (id, version): the implementer repeats the procedure in the entry's last `docs/verification/` receipt, writes a new one, and adds the version to `verified` in that same PR; the next release ships the bump. A person's `ahub agents trust` stays the stopgap that keeps a machine running meanwhile, and the person may revoke it once the bump lands.
  - **Local drift notice (#843 AC3):** at hub start and once a day the daemon reads each gated CLI's installed version with the probe `ahub agents` uses (no network, no install). For every installed CLI on a version that is not `verified` (in-line, trusted or refused) the effective planner gets one notice per (id, version): the id, the version, the state and the last receipt path, nothing the CLI printed. A CLI that is not installed, or whose version cannot be read, is not drift. The marker is kept per (id, version, planner) in `hub.db` (`agent_drift_notices`), so a restart repeats nothing, a planner whose notice could not be queued (or who joins later) is retried alone without telling the others again, and a new version is a new notice; with no rostered planner nothing is recorded. `ahub status` shows one `agent CLI drift` attention line per drifted id until the installed version is verified.

## Upgrade and crash recovery

On a terminal, one command reviews, applies and follows an upgrade:

```bash
ahub upgrade
```

Without `--to` the target is the registry's latest release. When that release is
newer than the installed CLI, the CLI names the release's own coordinator
(`bun x --package @staix/agent-hub@<version> ahub upgrade --to <version>`), asks,
and hands over to it, so the version is never typed twice and an older CLI never
coordinates. From an installed CLI older than 0.12.22, start it once by hand:
`bunx --package @staix/agent-hub@<version> ahub upgrade`. The screens are
described under [Interactive upgrade](#interactive-upgrade); the rest of this
section is what they run.

Upgrade running projects with the target release's own coordinator. It accepts
a running source on control protocol 9 (0.6.x), 10 (0.7.0 through 0.12.0),
11 (0.12.1 and 0.12.2), 12 (0.12.3), 13 (0.12.4 through 0.12.15), 14 (0.12.16), 15 (0.12.17 through 0.12.19) or 16 (0.12.20 through 0.20.0), and only
a target on its own protocol, so the target's coordinator fits every supported
source and carries every recovery fix released up to it. Protocol 8 and older
(0.5.x and earlier) are refused as `manual-bootstrap-required`. Run from the
project directory, without replacing the global CLI first:

```bash
bunx --package @staix/agent-hub@0.12.43 ahub upgrade --to 0.12.43 --dry-run
bunx --package @staix/agent-hub@0.12.43 ahub upgrade --to 0.12.43 --yes
```

| Running now | Coordinator to use |
| --- | --- |
| 0.6.x (protocol 9) | the target's, through `bunx` as above |
| 0.7.0 through 0.12.0 (protocol 10), 0.12.1 and 0.12.2 (protocol 11), 0.12.3 (protocol 12), 0.12.4 through 0.12.15 (protocol 13), 0.12.16 (protocol 14), 0.12.17 through 0.12.19 (protocol 15), 0.12.20 through 0.20.0 (protocol 16) | the target's, through `bunx` as above |
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
ahub upgrade --to 0.12.43 --dry-run
```

Apply only after reviewing the plan:

```bash
ahub restart --yes
ahub upgrade --to 0.12.43 --yes
ahub recovery status [<operation-id>]
ahub recovery resume [<operation-id>]
ahub recovery abort [<operation-id>]
ahub recovery reattach <operation-id> codex|claude|pi
ahub recovery dispose [<operation-id>] --fresh-session <peer> --reason <text>
ahub recovery dispose [<operation-id>] --stop-and-archive --reason <text>
```

`--yes` needs `--to`; a dry run without `--to` plans the latest release. A target
newer than the CLI is handed to that release's coordinator with the same flags,
and the command is printed on stderr first. The `recovery` commands take the
operation that holds the machine's lock when the id is left out, and say `no
recovery operation holds the lock` when none does.

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

From 0.12.33, while an operation holds a source of that release or later, and
while a restored target waits for release, the notices the hub writes itself
(other than `[FYI]` ones) are kept apart from the carried queues, durably in
the delivery journal and the restart snapshot, so the queue comparison still
matches exactly. Release queues them in order and saves each move before
anything is delivered. A target that does not advertise `recovery_deferred_hub`
gets them in its ordinary queues before commit instead. At most 2048 such
notices wait; a further one is refused, and none already kept is dropped.

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

0.12.22 closes the name `.git` to the local worker's and Pi's commands at any
depth: `git init`, `git clone` and `git worktree add` no longer run inside the
sandbox (the full list is under Install and start).

The 0.7.0 transition stages the verified package and runs a retained
coordinator from the source tree. It accepts a verified protocol-9 source and
moves to a protocol-10 target. The source journal, queued envelopes, tasks,
manual pauses, budget state, and native session identity are read back before
release. The global CLI is promoted last.

A lost commit or start reply is reconciled against the actual daemon identity,
package digest, terminal binding, and phase receipt. An uncertain terminal
creation is never repeated blindly. Recovery retains the exact-pinned first-party memory package with the preserved runtime, includes its identity and bytes in the digest, and refuses missing, symlinked or changed retained dependencies instead of resolving a mutable ancestor/global installation. It does not copy the full dependency tree.

After creating a managed terminal, the coordinator saves its exact handle, incarnation and worktree before waiting up to 600 seconds (10 minutes) for authenticated attachment to the expected target hub and conversation. A pending or failed creation receipt also waits when the current target has a verified live launcher; its saved binding retains the pending/failed origin across interruption. An idle terminal alone is not attachment proof: after idle, the coordinator re-reads the launch record and Orca's identity every second within the same bound, until the terminal maps to the expected session or contradicts it (#599). Without a current launch record, a confirmed-ended row for another terminal and an attached session still reporting no id keep the chosen terminal waiting within the same bound; a late matching record continues that wait. Live replacement and unreadable records still block. Only non-offline session ids count, and older-instance launchers are checked before declaring a launch gone. Timeout retains the binding and diagnostic receipt; resume waits on that same binding rather than opening a duplicate.

The wait checks the selected launcher's signed identity on each poll. When that exact launcher exits and the target confirms no session or other live launcher, a pending-origin wait (including a new terminal) records failure and offers the failed-restoration choices, including fresh-session for Codex or Claude. A failed-origin wait returns to its existing retry path. A replacement terminal, missing or unreadable launcher identity, unreadable target or different attached conversation blocks without treating unknown as gone. Success clears the waiting origin and preserves exact terminal/session revalidation. A launcher from an older target instance still blocks without another terminal. The 10-minute limit matches terminal creation readiness; terminal idle can precede native resume and MCP handshake completion. The zero-turn Claude exception still applies only when no original transcript exists. If Claude shows its development-channel confirmation screen, confirm it in
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

### Interactive upgrade

`ahub upgrade` and `ahub restart` are interactive when standard input and output
are a terminal and neither `--dry-run` nor `--yes` is given. With either flag, or
through a pipe, the plan is printed as readable text (#814) and `--json` keeps the JSON plan and the `ahub: blocker:` lines; the exit codes are unchanged. The screens add no way to change an operation: every choice runs one
of the commands in this section for you, so that command's refusals decide.

The screens use the console palette and `--color=auto|always|never`, with the
same `NO_COLOR` and `TERM=dumb` precedence. Auto colours a suitable TTY; explicit
always has the console's override behaviour. Raw JSON bypasses colour and width
handling. Default and never print the same readable pipe, dry-run, status and
dispose text, and `--json` keeps the previous documents byte for byte. Presentation flags go after the command, for
example `ahub recovery --color=never` or
`ahub recovery status <operation-id> --json`. An explicit `--json` returns only
the raw document, without a human suffix. `upgrade --json` reviews a JSON plan;
`--yes` is still needed to apply it without the interactive review.

The plan screen lists each project with its hub version and, per attached peer,
its state, how it runs (`TUI` in a terminal the plan bound to its session,
`headless` as the hub's own process, `own` for a session the hub did not
launch or whose terminal the plan could not bind) and what happens to it: resumed in a new terminal (the old one is
named), reconnecting by itself, restarted as a new session, restarted headless,
or left offline. `in progress:` repeats what the running hub says keeps it from
being quiet (busy peers, pending approvals, a peer starting, a budget
transition; a hub of 0.12.22 or newer also names a task command, completion
checks or Pi tool calls in flight, ready tasks being released and a Pi that has
not settled); apply waits up to 10 minutes for it. Blockers follow, each with its
next action. The choices are `[a] apply` (absent while a blocker stands), `[r]
refresh`, `[k] end agents` (shown when an attached agent can be ended), `[j]`
the plan as JSON, `[x] reset a project's hub` (shown when the plan has a running
project) and `[q] quit`.

`[k] end agents` ends attached agents before the upgrade, so they are neither
waited for nor restored: `t` for the TUI agents, `h` for the headless ones
(Kimi, Pi in headless mode, the local worker), or their names, written
`<project id>/<name>` when the plan covers more than one project. After a
confirmation a TUI agent's terminal is closed, which cuts a turn in progress,
and a headless agent is stopped by its hub through the `peer_stop` request
(#278). A delivery that a busy agent had not settled is then held as
`needs_review`, and its queue stays held until `ahub queue resolve` settles it. Each agent is ended only
if the lock is free and its hub, its session and its terminal are still the
ones the plan read; otherwise the screen says why it was left. A hub that does
not know `peer_stop` (0.12.21 and older) cannot end a headless agent: the
screen says so, the agent stops with the old hub at the upgrade, and the new
hub starts it again. A session marked `own` is ended where it runs. The next
plan shows the ended agents as offline.

After apply the command stays attached and prints each step as the receipt
records it, and while a source is being prepared, what it still waits for.
Each reported step has a status mark and elapsed observation time. Resume lists
only steps observed on that attempt and says `resuming from ...` once. Its stage
step really runs again and is labelled `checking retained release`. Waits use
the coordinator's actual recorded start and deadline, for example
`[waiting] alpha: restoring Codex and Pi sessions (waiting 2m10s of 10m)`.
Older receipts without timing metadata say `timing unknown`; updatedAt is never
used as a substitute. Timing-only save failures log a warning and do not fail
the operation. Stable waits print only on change and at most once per minute.
Approval waits point to `ahub console`; native attachment waits point to the
recorded launch and conversation. Korean text and
long paths wrap to the measured width on plan, progress and menu screens.
Enter opens the operation's screen while the runner works on. Ctrl+C leaves the
command, at any prompt and while following, and never stops the runner: the
`left:` line names `ahub recovery status <operation-id>`. Use `--verbose` for
the internal command with the operation's retained coordinator, because the
installed `ahub` may still be the older release until the upgrade ends. A Ctrl+C between `a` and the start of the operation
starts nothing. A prompt for a reason that is answered with
Ctrl+C or the end of input ends nothing.

The operation's screen also opens first whenever an operation holds the lock,
and for bare `ahub recovery`. It shows the phase and step, each project's phase
and human outcome labels, then What happened / Why / What to do and the choices that `status` lists under
`next` for the same receipt and live state:

| Key | Runs | Offered when |
| --- | --- | --- |
| `r` | `recovery resume`, then follows | resume can get past what is live |
| `c` | `recovery abort` | no runtime was stopped and no terminal effect or commit request is recorded |
| `a` | `recovery reattach <id> <peer>` | the recorded detached session is eligible for reattachment |
| `f` | `recovery dispose --fresh-session <peer>`, after a reason | a Codex or Claude restoration failed |
| `e` | `recovery dispose --stop-and-archive`, after a confirmation and a reason | every unverified project reads as running, stopped or missing |
| `x` | `e`, then the reset below | as `e` |
| `w` | follows the runner | a runner holds the operation |

When more than one restoration failed, the second and later peers get
`f-<peer>`. `s` refreshes the screen, `j` prints the receipt as JSON and `q`
leaves the operation as it is.

The marked recommendation is a read-only Enter default: refresh the plan, follow
an active runner, read the receipt or refresh the operation. Apply, resume and
reattach require their explicit keys; buffered Enter never starts them. Unknown failures recommend
reading `j` before retrying effects. A wait whose runner cannot be verified is
shown disabled with its reason, and cannot run a command. Stop, archive, reset
and fresh-session choices carry a warning and name the consequence before the
person confirms. Raw receipt keys and the original recorded error are available
with `j` or `--verbose`. The four preservation failures name the actual failed
queue, manual-pause, board or budget comparison; an older untyped cause remains
unknown rather than being guessed from its text. When nothing more specific
applies (no typed cause, reattachment or `database_busy`), Why shows the first
line of the recorded error, with control characters removed and cut at 512
characters, marked `typed cause unknown`. What to do then says to resolve that
error, then resume or choose an offered action. Nothing is classified from that
text, and JSON and piped output are unchanged.

Completion and stop-and-archive use a human summary on a TTY. It separates the
outcome, recorded plugin/global installation effects, remaining work and the
per-peer session commands. An optional fresh read-only inspection names the
current hub version; a failed reading says `runtime unknown`, never a guessed
version from the plan. The summary performs no lifecycle action. Use `j` or
`--json` for the full receipt; JSON is intentionally exempt from human wrapping.
For a long command, copy the exact single-line value from `j` or the status JSON;
the width-wrapped human preview is for reading.

While a runner is only waiting for its source to get quiet (step `prepare`, no
effect recorded), `c` stops that runner and then aborts. It is offered only for
a runner whose claim carries a process signature that still matches; a claim
from a coordinator of 0.12.20 or older has none, so its pid is never signalled,
and such a runner gives up its wait after 10 minutes. The receipt is read again
when the key is pressed, and a runner that has moved on is left alone. If it
records an effect in the instant between that read and the signal, the abort is
refused and resume is offered instead. Past that step a running operation
offers only `w`.

A reset is offered from the plan screen for a project whose hub is running, and
with one question right after an operation was cancelled or ended from its
screen: it asks for the project (when there are several) and the scope, prints
the dry run of `ahub reset` or `ahub reset --all`, and applies it with `--yes`
only after a second confirmation. While an operation holds the lock it refuses,
as `ahub reset` does.

Ending a peer's running turn is not part of these screens: finish or interrupt
it in that peer's terminal, answer approvals with `ahub permit` or the console,
or cancel and upgrade later.

Terminal recovery records a launch only after that native session owns the peer
(#482). Capturing an Orca terminal or receiving `start: ok` creates only a pending
candidate; a second launcher that exits or is refused cannot replace the live
owner's row. A running hub without `terminal_owner` support leaves the new launch
unrecorded and prints an upgrade remedy. The plan names an attached native TUI
without a live launcher or exact Orca session proof as `attached, launcher
unrecorded`: end it in its terminal or use its native resume flow in an Orca
terminal, then refresh the plan. Plain Claude's same-protocol reconnect-only
session still reconnects by itself without a terminal restart.

Background Orca identity reads are limited to 30 seconds and 1 MiB of output.
Shutdown cancels their owned query process groups and waits for reconciliation.
A query whose termination cannot be confirmed is logged as incomplete; the
remaining peer and daemon teardown still runs. Native terminal execution keeps
its foreground TTY behavior. Unknown terminal evidence is shown as unverified
ownership, with end or native resume guidance.

An Orca pane that is orphaned but still connected needs reattachment, not turn
cancellation: run `orca terminal switch --terminal <handle>` yourself, then refresh.
The coordinator never switches panes. Such a pane is not evidence that its native
process ended and never authorizes a duplicate restore. Disconnected terminals
keep their existing guidance.

The ledger retains historical and invalid rows; it does not prune them on launch.
Only this project, current daemon instance and peer can supply ownership evidence,
and a successful publication replaces only its matching valid row. Old-instance
rows cannot claim the current terminal. Older binaries that directly write
`terminal-recovery.json` are outside the new writer guarantee.

### A partial operation

`ahub recovery status <operation-id>` reads the receipt without changing it:
its phase, step and error; `runner`, which says whether a runner process holds
the operation now (`running` with its pid, or `none`; `stale` marks a receipt
that says running with no runner behind it); each project's phase and effect
receipts (`closed:<peer>` as `done` or `pending`; `restored:<peer>` as
`pending`, `waiting:pending`, `waiting:failed`, `done` or `failed`);
whether the shared plugin and the global CLI were installed; and `next`, the
commands that apply now, read from every source the operation has not stopped
yet (every error of `resume` ends with the same list). `resume` is left out
when it can never get past: a source replaced by another instance, or a
prepared source that stopped before any commit request. It shows no task or
message text. `resume` does not
start a second runner while one is alive. Every `next` entry and error names the
operation's own coordinator, `bun <preserved source>/src/cli/main.js recovery
...`: in the middle of an upgrade the global `ahub` may still be the older
release, whose `recovery` lacks these commands. The published 0.12.30 CLI also
mislabels tagged waiting receipts as done and can hide the fresh-session choice,
even when its status command exists. Use the printed preserved-source
coordinator for status, resume and disposition; do not decide from that older
CLI's receipt display. Copy that command line. When
an older coordinator started the operation, `dispose` is named from the running
release, which has it. What
each receipt allows, given what is live, is tabulated in the recovery spec
(`docs/specs/2026-09-20-upgrade-recovery-design.md`, "Receipts, evidence and
next actions").

- The source hold lapses after 10 minutes. If releasing it fails because the
  source's delivery storage fails, the hold stays and the expiry is retried
  every second until storage recovers; restore the storage before `abort`.
  A later `resume` prepares the same
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
- If a restart stops with `database_busy`, the receipt stays `blocked` and
  carries `failure: { code: "database_busy", retryable: true, site: [...] }`.
  Let the other connection settle, inspect `ahub recovery status <id>` and
  use its offered `ahub recovery resume <id>`. Resume rechecks the source and
  reconciles a commit that may already have been requested. A busy read while
  that committed source is stopping stays inside the existing shutdown wait.
  A resumed prepared receipt with `commitSent` also polls an unavailable source
  within the 30-second shutdown bound, including initial database contention,
  without sending another commit, re-preparing or closing terminals again. Only
  confirmed `stopped` permits target startup; a replacement instance refuses, and
  expiry retains the prepared receipt and the same operation for another resume.
  A stop-and-archive that meets contention instead says to retry that
  disposition; resume remains refused while abandonment is partway. Successful
  abort, fresh-session choice and disposal clear the earlier failure annotation.
  Do not delete database files or start a second operation to bypass the lock.
  A failed installed-layout CI restart retains bounded, redacted fixture logs,
  receipt fields (including `commitSent` and failure frames) and file-mode
  metadata as a per-OS artifact.

  The historical CI receipt (38061057253, attempt 1) kept no throw site or
  hub log. At its main, status/inspect RPC failures were swallowed and the
  synchronous catch sent a fixed sentence, so its raw SQLite text could only
  have come from the commit rejection or the runner's own `registry.db` read.
  "Resume | wait until the hub settles", without stop-and-archive, means its
  next inspection saw neither running nor stopped/missing. Which of the two
  paths, which statement and which holder remain unknown. The controlled
  rollback-copy reproduction is separate evidence, not that historical cause.
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
  the way out is stop-and-archive. A snapshot whose kept hub notices fail
  validation blocks that restart with `restart snapshot deferred hub notices
  are invalid; restore is blocked`. The hub still reads as stopped, so
  stop-and-archive (and abort, where it applies) stays offered; nothing
  repairs the snapshot or offers to resume from it.
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
  re-reads the terminal's mapping every second (#599) and stops at once only when
  Orca names another peer or session; otherwise it stops with "original session
  restoration needs manual verification" (the terminal cannot be mapped to the
  session) when the 10-minute wait ends. If it does not, it stops with the same
  error after the 10-minute wait. Either way the receipt stays
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
- `ahub recovery reattach <operation-id> codex|claude|pi` is person-only, including during live verification: an agent shell cannot delegate it. Name the operation and exactly one peer; session, backend, model and terminal overrides are not accepted. Use the exact operation-coordinator command printed by status or its blocked guidance. It repairs only that peer and leaves the operation blocked; run the offered `recovery resume` command to continue the remaining steps.
  The CLI delegates only when the retained coordinator supports reattach. An existing older coordinator without that action uses this release's implementation instead; a missing receipt, retained coordinator path or coordinator file prints inspection/recovery guidance and starts no session.
  A peer that attached and later went offline can be re-restored once when its saved terminal is positively orphaned or missing and no current or older operation launcher may still run. The recorded session id and Pi session file stay fixed; the new terminal binding is saved before waiting for authenticated attachment. A second detach blocks. An unreadable terminal, changed incarnation or worktree, disconnected-only evidence, truncated inventory or live/unknown launcher does not authorize another terminal.
  Recovery status names the saved Codex thread, Pi session file and Claude session, the terminal evidence, and the applicable reattach command. A different attached conversation remains a strict refusal.
- `ahub recovery dispose <operation-id> --fresh-session <peer> --reason <text>`
  applies to a Codex or Claude peer whose restoration failed (Pi is refused: a
  restored hub resumes Pi's recorded session). It records the lost session or
  thread id (status shows it under `lostContinuity`) and resumes: the peer
  starts without its old conversation, and the rest is verified as usual.
  A session the operation already reattached keeps that repaired provenance
  across target restarts and is never replaced automatically. Its
  loss can be accepted only after the restoration reported the recorded Claude
  transcript or Codex rollout as positively missing, naming the checked path;
  dispose checks that path again before saving the choice and otherwise refuses
  with "recorded conversation is not positively missing". Under `--live-test`
  this repaired-session choice is refused even where an ordinary fresh session
  may be delegated.
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
  there). It records its decision before it acts; that audit entry keeps the
  operation's error at that moment as `cause`, because disposal clears the
  error itself (#776). It releases a source hold of
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
  database. The global CLI was not promoted. The archive summary distinguishes completed target startup and plugin installation from remaining global CLI installation, and prints recorded-session commands: `ahub codex resume <thread-id>`, `ahub pi --session-file <path>`, and the Claude reconnect command. On the next `ahub up`, `pi.auto_start` resumes the archived operation's recorded Pi session rather than choosing a fresh conversation. Unknown or conflicting archived identity refuses that automatic resume.
  That session is kept as a bookmark, `.agenthub/state/recovery-continuity.json`. When its session file can no longer be resumed or does not match it, the hub archives the bookmark and starts no fresh session in that start; the error names `ahub pi --mode <mode> --session-file <managed-file>` for choosing one. An invalid or unreadable bookmark, or session storage that cannot be verified, starts nothing, keeps the bookmark and prints the `mv -n` command that archives it after inspection. The bookmark is retired once Pi attaches with a different authenticated session.
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
  recorded session by the hub; the report gives the command. With
  `pi.auto_start` a fresh headless Pi starts instead only when Pi's start mode
  is headless; with the default (tui) nothing is started in its place.
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

`routing.toml` supports in-process `[hub_routes."hub/<id>"]`.
A task uses a hub route when `[local] route` or its class's `route` names one.
A new `routing.toml` from `ahub init` sets `[local]` and `implement` to `hub/stage`
(fixed model `coding` as the fallback) and gives the lighter classes
`fixed_model = "fast"`. The shipped examples use OmniRoute `fast` and `coding`; `fixed_model` remains the fallback.
`--model` pins the worker and bypasses route selection. A class with `fixed_model`
and no `route` also calls that alias directly, even when `[local]` names a route.

The Switchyard sidecar is retired (#553). No binary or generated model-router
config is used, and its reserved port offset remains unused. Existing `[targets]`
and `[routes]` tables are ignored and listed as retired settings in startup logs
and doctor. Every route without the `hub/` prefix, including named legacy routes
and `sy/` selections, uses the fixed alias with one warning. Loading or reloading
never rewrites the operator's routing files.

Migrate the retired settings as follows:

| Retired setting or route | In-process replacement |
| --- | --- |
| `stage_router` | `[hub_routes."hub/<id>"]` with `type = "stage"`; select it with `route = "hub/<id>"` |
| `efficient_target` / `capable_target` | Put the targets' model aliases in `efficient` / `capable` |
| `confidence_threshold` | Keep the same value on the hub stage route |
| Passthrough class route | Put its target model alias in the class's `fixed_model` and remove the class's `route` |
| Former unshipped classifier escalation | Use the existing hub `escalation` policy |
| `[targets]` / `[routes]` | Remove these retired tables after migrating their selections |

Doctor inventories all local/class fixed aliases and effective efficient/capable/judge aliases, reporting
each missing alias once or aggregate success when all are served. A
`routing.toml` or `routing.local.toml` that does not parse gets its own `routing`
row naming the file and the parse error, without the file's contents, and the
alias check is skipped (#563). Hub summaries
and triage use their fixed model directly.

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
a `dispatch held` detail with a relative time and `no load moves until then`). No load move or pin happens while the request
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
cooldown. `ahub status` shows a `cooling` detail with a relative time and failure count and `events.jsonl`
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

## Task stalls and cancellation

A ready task with an ineligible reservation, no eligible peer or a cancelled dependency shows an ids-only stall cause in status and the Tasks panel. The hub reports a cause once, repeating only when the cause changes or the task is re-planned. It directs ownerless advice to the designated planner's next bounded preface and the configured supervision stream, otherwise the person's attention list; it does not create an extra ordinary turn beside backlog batching. Configure the missing capability, assign another eligible peer, re-plan or cancel the task as appropriate; a reservation never bypasses routing guards.

An offer to a pull-only peer adds an advisory "open <peer>: task #N is waiting for it" attention item. It clears when that exact offer is accepted, declined, superseded or genuinely delivered and settled to the addressed peer. Another inbox read, an accepted-only receipt or a person's queue completion does not prove it was read. The attention item survives peer detach and daemon restart using the saved offer's pull-only flag; it does not alter delivery state.

The person can retain superseded work as closed history:

```sh
ahub task cancel <id> --reason <text> [--superseded-by <ref>] [--revision N]
```

The console also offers cancellation with the selected task's flow revision. Approved tasks cannot be cancelled. The planner's `hub_task_cancel` tool is limited to work it proposed that is in backlog or proposed with no execution evidence: never started, or accepted by an owner and then declined or returned untouched (no branch, commit, PR, local check, done, verdict or reopen, the same test as `hub_backlog_return_untouched`, #812). Work with any such evidence requires the person. Cancellation sends the former owner/reviewer a stop notice, releases overlap/reservation participation and keeps dependents blocked with a cancelled-dependency notice. It does not stop a native turn, delete a worktree or write an outcome memory note. Cancelled work is closed history, counted separately from approved work; it does not satisfy an approval dependency. A still-running private turn keeps its privacy fence after cancellation. Use the displayed revision to avoid acting on a task that changed while it was selected.

The daemon advertises `task_cancel`; a current CLI refuses cancellation against older daemons. Recovery retains verified target features beside its immutable root/digest, reuses them on resume and on each lease renewal before a terminal is closed, and checks only sources not yet past commit; a legacy receipt without that evidence needs a target probe only before commit. Upgrade/restart refuses a target without this feature while cancelled rows exist and names their ids. No cancelled row is rewritten as approved. An old binary launched by hand remains unsupported: it can count cancelled work as open or fail to move it. Use a compatible coordinator instead. Live task cancellation and sweep enablement are separate post-release operations.

## Task idle sweep

Writing-owner no-op detection (#498) is independent of the time sweep: `task_sweep.no_writes_turns` defaults to 2, and 0 disables its notices. Known file changes, HEAD/shared-branch ref movement and task-tool effects reset the streak. A canonical snapshot with recorded branch, worktree-path or PR/head evidence is unknown. Negative canonical evidence also needs exclusive worktree scope and no `.worktrees` directory, so uncommitted work in a separate checkout is not reported as empty. Done advisories use the first acceptance in the current ownership span; plan updates do not discard earlier touches.

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
    "ready_min": 60,
    "ladder_min": 30,
    "auto_reassign": false
  }
}
```

Booleans must be actual booleans. Each time setting must be a finite number of
at least 1; timeouts are bounded to the platform timer limit. Each threshold
measures time since the last real task history event. A ladder record does not
refresh that activity; a new event resets the ladder even at the same timestamp.

Ready proposed tasks without an owner use `ready_min` and the `ready-unassigned` ladder; unresolved or cancelled dependencies do not become ready. A person's unassignment suppresses this automatic ladder until a later explicit assignment or reservation. Planner-pulled work keeps its reserved peer and current WIP/hold admission; an unavailable or full reservation never selects another worker.

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
specific unverified claims in the release verification report before tagging. Deferred
pages must still be source-reviewed and current; a deferral is not a stale-stamp waiver.
The tag gate runs `node scripts/check-docs.mjs --require-fresh` with full history
before publishing. Stale or nonancestor stamps refuse publication, with the
release merge-commit instruction; an identical tree and green CI cannot waive this.

Do not advance a stamp solely to clear a notice. Source stamps can name an
ancestor: the manifest-only follow-up commit need not hash or stamp itself.

## Seeded guard verification

`bun scripts/seeded-check.ts` runs every guard pair in `scripts/seeds.json`
sequentially, starting with header quoting, Origin refusal, control-token
authentication, the hop cap, PII public views and uncertain-delivery receipts.
A guard needs a test that runs on Linux, where the CI job runs; a macOS-only
protection (sandbox, text projection) is covered by its regression test. Each named test first passes on current tracked
checkout bytes, then must fail an assertion with the corresponding guard weakened.
Seed rot (anything other than one exact replacement), a surviving seed and an
invalid detection have distinct errors. Compiler, setup, unrelated-test and timeout
failures never count as detection. When the anchor text is missing, the seed-rot
error also names the base commit, the symbol that held the anchor there and that
symbol's current file and line, or says which part is unknown (#778). This is
evidence only: the exact-match rule still fails the pair. `--base <commit>` names
the base; without it the runner uses the merge base with `origin/main`.

Each seed has a private temporary checkout without Git metadata, state, output
directories or user untracked files. Installed dependency packages are linked,
never copied or installed by the runner. Child tests use private home, temp and
registry directories and a scrubbed environment. The normal 20-second test timeout,
60-second hang watchdog and current-invocation process ledger/leak scan apply to
both legs. Successful fixtures are removed; a failed pair prints its preserved
fixture location with test and leak evidence for inspection.

CI runs the pairs as four Linux shards (`bun scripts/seeded-check.ts --shard i/4 --base <ref>`,
every fourth pair, still sequential within a shard; the base is the PR's base commit
or the push's previous one, on a full-history checkout) beside the ordinary checks; the
required job `seeded guards` passes only when all four shards passed (#457). The pairs
do not repeat on macOS or run recursively inside `bun test`. The runner reports every
pair's elapsed seconds and the total runtime. A green ordinary check alone does
not prove these pairs.

The full CI gate tests the PR head tree on Linux and macOS, with the seeded-guard
shards running at the same time. Main and release jobs reuse only a successful full
PR or push check with the identical Git tree and all three successful jobs. An absent or
unreadable result runs the main gate again and refuses release. A manual
`prepare_bundle` dispatch builds reviewable plugin assets without publishing;
it is never accepted as full-gate evidence. A `timing_runs=20` dispatch runs only the daemon, PII screen and ACP
test files twenty times on macOS, in its own concurrency group; it does not replace the full gate. Each PR has its own CI concurrency group, so PRs run side by side; within a PR a newer pending run replaces the older pending one and an admitted run is never cancelled; main pushes and dispatches keep queueing every run. Two groups admitting the same tree at once may run it twice, never a false green (#609). `scripts/check.sh --changed [<base>]` runs every non-test step but only the affected test files, and the full suite when it cannot tell; the full gate stays CI's (#610).
`scripts/check.sh` runs the suite under `scripts/hang-watch.sh`, which stops it when
no test result line (`(pass)`, `(fail)`, `(skip)` or `(todo)`) and no test file header
has appeared for `AHUB_CHECK_QUIET_S` seconds (300 by default, set to 300 in CI), so a
slow suite that is still passing tests is never cut. `scripts/progress-tee.sh` passes bun's
output through unchanged and appends one byte to a progress file for each of those lines;
the watchdog polls that file's size. On a stop it prints where the run is and the process
table below it first. `AHUB_CHECK_HANG_S` (960 by default) is only the backstop for a run
that keeps printing results while hung; hosted CI sets 1500 on Linux inside a 35-minute
job limit (#378, #593, #752, task 516). The macOS leg runs as four shards (#548): `AHUB_CHECK_SHARD=i/n`
makes `scripts/check.sh` run slice `i` of the full suite through `bun test --shard=i/n --timings=scripts/test-timings.json`, which puts
every test file in exactly one shard and balances them by the recorded per-file times; shard 1 also runs the docs check, typecheck, role check, bundle freshness and
package contents, so each of those runs once per gate, and the others install and test. Each shard runs under the same 1500 s backstop as Linux inside a 25-minute job
limit, and its last line is `check: OK (shard i/n)`. The required check `check (macos-latest)` is an aggregator job that passes only when every shard passed (or an
identical-tree full proof was reused), so branch protection and the reuse proof read the same names as before. `AHUB_CHECK_SHARD` is the full suite only: it cannot be
combined with `--changed`. A shard execs the system git once before its tests (`AHUB_CHECK_WARM_GIT`, default `/usr/bin/git`; a failure of it is ignored), because the first execs of `/usr/bin/git` on a fresh hosted macOS runner outlast the 1000 ms some tests give it. `scripts/test-timings.json` is advice for balance, never a list of tests: a file missing from it still runs (Bun gives it the median time).
Regenerate it from a green macOS leg when the shards drift apart: `gh api --allow-escape-sequences repos/<owner>/<repo>/actions/jobs/<macOS shard job id>/logs`
for each shard, or from one unsharded leg's log, then `bun scripts/make-test-timings.ts <log>`.
The `closing-refs` workflow fails a PR whose title, body or commit messages would make
GitHub close an issue the text only mentions (`Refs #N`, a negated or qualified keyword);
an issue linked only in the sidebar passes (#760).
The gate holds `<git common dir>/ahub-heavy.lock` across every worktree of a
repository. A second gate waits up to `AHUB_CHECK_LOCK_WAIT_S` (1800 seconds by
default; 0 fails immediately) and names the holder. A holder whose PID is gone
is reaped. This filesystem slot works without a running hub; it covers this
gate, not arbitrary build commands. PID reuse can retain a stale slot, and two
waiters reaping the same dead owner can race; broader scheduling remains an
operator responsibility (#398).

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
native token-usage updates. Kimi's context occupancy comes from its ACP `usage_update`
(`{used, size}`, source `acp_usage_update`), not consumption, so no token total is counted from it. Its consumption is counted from its
session wire log (`<kimi home>/sessions/.../agents/*/wire.jsonl`, #285 phase 2) and reported as the `tokens` window of
`budget.kimi_tokens_5h` (source `hub count, kimi wire log, of kimi_tokens_5h N`; cache reads are not counted); an unreadable log shows
unknown with one notice, never a short count. Until the OAuth probe or `ahub budget set kimi ...` feeds the plan quota, the provider's
own 5 h and weekly ratios stay unknown. Not yet verified live against Kimi's `/usage` (#285 AC11); the adapter accepts the
update whenever it names the current session, because 2.1.1's source text
emits it after the turn settles (read from the source, not yet observed live
through the hub; docs/smoke.md), so the peer may already be idle.
Jcode's context occupancy comes from its ACP `usage_update` (`{used, size}`, source `jcode_usage_update`, bound to the adapter's own session id) on the verified 0.99.1 shape; its consumption is one `usage` event per prompt (source `jcode_acp`: the prompt result's `inputTokens`, `outputTokens`, `cachedReadTokens` and `cachedWriteTokens` as the hub's buckets, never Jcode's `totalTokens`, which counts the cached read twice for OpenAI-style providers) and never a `tokens` event or a window. Jcode has no native quota reader: `jcode usage --json` carries a free-text limit name and no window length, so `ahub budget` keeps `no reading` for it and `ahub budget set` stays the way in (receipt: `docs/verification/2026-10-28-jcode-0.99.1-usage.md`).
Pi, Qwen (until a native source is verified, #625) and other unsupported surfaces show unknown.
A stale or disconnected reading is unknown, not 0%. Codex's accumulated session
usage is never used as context occupancy. In the tail (`ahub tail` and the
console's stream) a reading prints once and repeats only when the line changes
apart from its time: the printed percentage, the freshness, the source, or known
against unknown. Status, the Peers panel and the dashboard always read the
latest reading with its time.

Context-triggered checkpoints are disabled by default. To enable them, add
this to `.agenthub/config.json` and restart the daemon deliberately:

```json
{"context":{"gate":0.85,"stale_min":30}}
```

`gate` is a fraction between 0 and 1; 0 disables checkpoint requests.
`stale_min` must be positive. A reading at or above the threshold records a metadata-only
event and console notice, then asks an attached Claude/Codex with active work
for a checkpoint when no checkpoint request is already outstanding (an ACP peer
such as Kimi gets the event and notice only; no checkpoint request is sent to it
yet). The request supplies a `request_id`; include that id with
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
terminal exits, a requested stop (`ahub stop pi`), requested shutdown and
recovery operations suppress this restart. Crash recovery's #66
recorded-session/fresh-start choices are unchanged.

### Explicit Pi history replacement

If an offline Pi owner has no verified persisted resume state, inspect the old
session and any partial work, then select a preserved file explicitly:

```sh
ahub pi --replace-session --session-file <managed-file>
```

The file must be inside this project's `.agenthub/state/pi-sessions/` and its
session header must identify the same project. The selected session keeps its
existing identity. This is a person-only recovery action; default restart never
selects another session or infers that missing history was empty. A session id
alone is insufficient. Add `--headless` to run the selected history in background.
`--print-command` validates flags without checking the live owner or changing it.

Replacement requires an existing offline owner whose native process is proven
gone, with settled tools, receipts and approvals, outside a recovery operation.
An unclaimed pending TUI launch uses the ordinary restart path instead. Before
revoking the old owner, the hub durably saves private previous/selected session
metadata in `pi-session-replacements/` beside `pi-sessions/`. Failed validation or
record storage leaves the old owner intact. All session files, queued work and
journal records remain. Uncertain effects are never retried by this selection;
inspect and reconcile them before continuing.

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

### Stop one headless peer

`ahub stop kimi`, `ahub stop pi` (headless mode), or `ahub stop local` stops
that hub-owned runtime through its adapter and prints `<peer>: offline`.
The hub and its other peers keep running. The command is human-only;
agent shells and tools-role connections cannot use the `peer_stop` request.
An older hub that does not know the request needs an upgrade before this
command is available.

Claude, Codex and Pi in TUI mode belong to their native terminals: end them
in those terminals. The upgrade plan's end-agents action closes a TUI through
its verified terminal binding and uses `peer_stop` for a headless runtime.
Unknown and already-offline peers are refused with a next action. A recovery
operation or shutdown holds stop mutations; finish that operation first.
A peer's concurrent start, stop or permission-mode change must also finish
before another lifecycle change is admitted, and an upgrade or restart does not
prepare the hub while a stop is in progress.

A requested stop does not automatically restart a peer. A person or an authorized
conductor can explicitly start it again; conductor starts remain permitted. Start it with
`ahub kimi`, `ahub pi` or `ahub local`. Pending approvals are withdrawn before
teardown. An in-flight delivery becomes `needs_review`, with a reason naming
the requested stop; it is neither completed nor automatically replayed.
Inspect partial effects with `ahub queue list --peer <peer>` and
`ahub queue show <delivery-id>`, then explicitly choose `completed`, `retry`
or `discard` with `ahub queue resolve`. Restarting alone does not release
that held delivery. Work queued behind an idle stopped peer is retained and
runs when it is started again, subject to its existing pauses and holds. New work
arriving during teardown stays queued too, even if a console resume runs meanwhile.
An idle Pi with no message/file yet records its live empty-session proof before
stopping, so its next start resumes that identity. A Pi stopped after its first
prompt was accepted but before history was persisted is not treated as empty:
its delivery is held, and another start refuses until resume history is verified.
Inspect and settle the held delivery before selecting preserved history through
[explicit Pi history replacement](#explicit-pi-history-replacement). The stop
never silently chooses a fresh session; replacement requires an offline, settled
owner and a validated managed session file.

A pull-only Kimi TUI has no controlled restore or resume. While it is attached,
upgrade/restart planning stops before effects and asks the person to end Kimi in
that terminal and make a new plan. Headless Kimi restoration stays headless even
though the unset launch mode now means TUI; older targets keep their legacy
command without a mode flag. Native recovery remains unverified.

Changing a reviewer on a task in review withdraws unread requests and tells the
former reviewer its request is withdrawn. A delivered request cannot be recalled,
but a later verdict from that former reviewer is refused by current authority.

Legacy Claude pull-only sessions retain their existing automatic owner/reviewer
selection; the watched-Kimi exclusion does not disable that review path. After
first creating the Kimi MCP file, run `ahub init` to ignore the untracked file.
Init leaves existing ignore bytes alone when no Kimi MCP file exists.
## Scoped grants for instruction files

`ahub settings set scoped_grants.protect_instructions true` asks a person before
Pi/local scoped writes and edits to `AGENTS.md`, `CLAUDE.md` and `QWEN.md`, and
withholds automatic permission from the managed Claude hook. Case, compatibility
forms and both symlink spellings are checked. The default is false: these project
documents remain editable under scoped grants. Reads, explicit approval and
never-ask keep their existing behavior.

Use `ahub settings preview scoped_grants.protect_instructions true` before a
change and `ahub settings undo` to restore it. It is in the Permissions registry,
writes only machine-local `protect_instruction_files`, and applies immediately
in the running hub. A dashboard settings session may change it; an ordinary
session may turn protection on but cannot weaken it. No agent surface changes it.
Like other machine-local security defaults, loading it requires git to establish
that the file is untracked; a dropped value is reported by the settings result.

## SDLC artifact receipts and gates

The playbook lifecycle (#257, #481) is off without `.agenthub/sdlc.toml`. When enabled its stages are intent, spec, plan, build, test, review, merge, release and maintain, grouped as Plan, Design, Build, Test, Deploy and Maintain. Advise shows blockers; enforce checks implemented head-bound review and approval gates. Stored implement/verify receipts read as build/test; new enabled receipts use canonical ids. See [the SDLC contract](sdlc.md) for gates, required check names, local receipts, console-only readbacks and the S0-S8 delivery table. A person accepts a spec issue with `ahub sdlc accept <task> --issue <n>` (S1). The planner records plan reviews with review and CI scope (`hub_plan_review`, `ahub sdlc plan-review`) and grooms with `ahub backlog groom`; `ahub backlog return <task> <revision> <reason>` returns accepted, untouched work (S9). `ahub sdlc costs [owner/repo]` reports review rounds and CI runs of merged PRs without writing the board (S10). `ahub sdlc metrics [--since <YYYY-MM-DD|ISO time>]` (the planner tool `hub_sdlc_metrics`, planner or person, read-only) reports lead times, first-pass approval and check rates, rework rounds, stale-head re-reviews and open stalls from board history, with `unknown` counted and never 0; optional `[bands.<metric>]` in `sdlc.toml` add control bands that the daemon checks every five minutes in advise or enforce, writing a hub notice (`log`), a read-only `triage` backlog task (`diagnose`) or a `plan` backlog card (`propose`), one per breach episode and never a GitHub issue (S7, see [metrics](sdlc.md#sdlc-metrics-and-control-bands-481-s7)). With the lifecycle on, a task's issue identity is linked when it is proposed or accepted, from the one issue it names (an imported GitHub issue, or a `#N`, `owner/repo#N` or issue URL in its title); a title that names a sibling repository (`agent-mem#13`) links only when `refs.repo` names it, and without `refs.repo` the propose result says to set it. `ahub backlog groom` also backfills up to 32 links per call, within 1 s (#723). S11 release trains ship in 0.12.37 (see [release scheduling](#planner-release-scheduling)). S3 structured review findings (an open Important finding blocks approval in enforce; `max_nits` in `sdlc.toml` caps nits) and S2 literal-path plan conformance with the person-only `ahub sdlc accept-departure <task> <head> <reason...>` are in source; see [findings](sdlc.md#structured-review-findings-481-s3) and [plan conformance](sdlc.md#plan-conformance-481-s2). S4 [test integrity](sdlc.md#test-integrity-481-s4) and S6 [release authorization](#release-approval-and-optional-tag-guard) are in source too. S5 continuous evals, release metrics and bands, and a full live advise/release cycle remain pending. Owners/reviewers record bounded identities through `hub_sdlc_record`; these grant no additional authority. Off output, receipt and schema shapes stay unchanged.
## Optional Qwen Code peer

Select Qwen per project with `ahub roster add qwen`; it defaults off and is absent
from default class preferences. `ahub qwen [--mode headless|tui] [--model <alias>]`
starts its ACP peer (headless) or Qwen's own TUI in your terminal (below).
`--print-command` previews either. `ahub stop qwen` stops the owned process group
of a headless Qwen. A conductor may start the headless form only through the
selected roster and existing capabilities; the TUI is always a person's start.

### Qwen's own TUI, driven through dual output (#286 Part 3)

`ahub qwen --mode tui` runs `qwen --input-file <in> --json-file <out> --mcp-config <hub server> --approval-mode default` in the terminal you ran it from. The daemon prepares the two files (mode 0600, under `<state dir>/qwen/qwen-dual/`) and returns the launch; the hub then appends one `submit` line per delivery and tails the event file from a saved offset. It needs a Qwen the dual-output compat entry verifies (`ahub agents` shows `qwen-dual`, verified 0.26.1 only; the headless `qwen` entry is separate and unchanged) and refuses another version before it creates a file. The TUI is explicit only: `ahub qwen` without `--mode` is still headless, Qwen is not a start-mode peer, and the hub never opens this terminal by itself. The TUI start is refused for an extra Qwen instance, off roster, outside a terminal, and while a headless Qwen runs (`ahub stop qwen` first); a headless start is refused while the TUI holds its terminal.

- What the hub does: a delivery becomes a `submit`; the last assistant message of the turn (an `assistant` event whose `stop_reason` is not `tool_use`, then `message_stop`) is shared as the answer; busy and idle follow the events. A `can_use_tool` request goes to the console approval path (`ahub permit`, the dashboard), and the hub's own tools are approved only by their exact `mcp__agent-hub__<tool>` name. If you answer a prompt in the Qwen terminal first, the hub's pending approval is withdrawn.
- **Limit 1, a deny ends the turn without an answer.** Qwen emits nothing when the hub denies: it cancels the whole turn. The hub ends the turn itself, shares no answer, settles the delivery as `completed` (a deny is a known outcome, and a `needs_review` would hold every later message to Qwen until a person resolved it) and says so in a notice. A turn whose outcome is not known (Qwen exited, an Esc followed by a new prompt, an event file that became unreadable) is the one that settles `needs_review`. Qwen's own notice that a background shell finished (a `user` event that is wholly one or more `<task-notification>` envelopes) is not a new prompt: it ends no hub turn and leaves an idle peer idle (task 517).
- **Limit 2, the hub cannot stop a Qwen turn.** The input protocol has only `submit` and `confirmation_response`, and a signal does not stop a running turn. The inactivity watchdog therefore never cancels: after `watchdog_ms` of silence it marks the turn stalled (`ahub status`, the console and the dashboard say "press Esc in the Qwen terminal") and keeps the peer busy. The hub never types into your terminal and never signals Qwen to stop a turn.
- A Qwen write or shell command that names the hub state directory is refused (see [security](security.md): the input file is a prompt channel).
- If the hub cannot read the event file the peer is `detached`, shown as offline with a notice, never idle: Qwen itself keeps working, and the hub reattaches when the file is readable again.
- Restart: if the hub restarts while your Qwen keeps running, it reads on from its saved offset (no event twice, no launch). If Qwen is gone, `ahub qwen --mode tui` starts `qwen -r <session id>` on the same two files; the earlier submits are not replayed and the recorded answers are not shared again. Recovery never restores this terminal as a headless worker, and `ahub stop qwen` refuses: end Qwen in its own terminal.

Receipt-verified native ACP identities are qwen-code 0.25.0 and 0.26.0 ([dated receipt](verification/2026-10-22-kimi-qwen-compat.md)) and 0.26.1 ([0.26.1 receipt](verification/2026-10-26-qwen-0261-acp.md)). A CLI version label alone
is insufficient: startup verifies its native identity/version and advertised mode
ids before any prompt. The earlier local installation reported CLI 0.25.0 while
its package/ACP source said 0.24.1; that was not a ready identity. The 0.26.0 receipt
used a private prefix and did not upgrade PATH. Configure `qwen_cmd` only in
untracked config.local.json with a receipt-verified executable.
The provider's tunnel/relay, if needed, must already be available. Startup cannot
prove network readiness from a version command.

Modes: ask maps to default, scoped frequency maps to auto-edit, never-ask maps to
yolo. Qwen yolo approves every tool outside any hub sandbox; its own vendor bounds
apply. Auto and plan are not hub mode mappings. Unknown quota refusals are not
classified as authoritative quota; until a real pinned refusal is recorded, pause
by hand. Context occupancy shows unknown until a native source is verified; it no longer uses Kimi's usage parser (#625). Roles
do not establish that Qwen can reliably replace Kimi before the live leg.

Qwen controlled recovery and automatic crash resume load the recorded conversation with ACP session/load. The emitted launcher passes --session-id; a controlled plan with a missing or unsafe identity refuses before effects. Preview redacts the id. A custom executable argv keeps its wrapper arguments before appended model flags. Native recovery remains unverified.

## Optional Jcode peer

Use `ahub roster add jcode`, then `ahub jcode [--model <alias>] [--provider-profile <name>]`. It opens the native TUI attached to the hub-owned ACP session by default. Use `--mode headless` or `ahub settings set peers.jcode.start_mode headless` to keep headless startup. The launcher reads roster membership from the hub's status reply; a hub older than 0.12.35 does not send it, so the launcher stops with an upgrade-or-restart remedy and starts nothing (#484). The person launcher configures only agent-hub-jcode in .jcode/mcp.json; run ahub init afterwards to ignore the untracked machine-path file. It writes the plugin bundle the running hub reports in `status`, so a CLI from another install no longer leaves a stale entry; `ahub kimi` does the same for Kimi's TUI entry (#502). Conductor/dashboard starts read that entry without editing it. Preview starts nothing, and ahub stop jcode stops only the owned private daemon/ACP groups. jcode_cmd, jcode_home and jcode_provider_profile are machine-local and never editable from settings.

The native TUI opens only after Jcode has saved the selected session. On 0.98.1, `session/new` does not save it; the first real hub turn does. The launcher prints `jcode's TUI opens after its first hub turn; send it work, or Ctrl-C` once and waits for the same owned launch's saved session. Send Jcode work from the hub, or press Ctrl-C to end only the wait. No artificial prompt is sent. A console `peer_start` uses a terminal provider to run the same launcher, even while ACP is running; a conductor or dashboard start of an attached Jcode answers `already` and opens nothing (#559). Without a provider, run its displayed command in your own terminal. Options with no terminal need that manual path.

`ahub jcode --dry-run` stays pure and redacted. A person's `--print-command` can show the actual top-level native argv and closed native environment for an already-saved running session; it starts nothing, and like the launch it names a `--model`, `--provider-profile` or `--session-id` that differs from the running session (#574). The private socket/session tuple is not returned to hub tools or status. Native saved-session evidence is read-only and capped at 32 MiB; unsafe, mismatched or larger evidence refuses the TUI launch.

A busy jcode takes an `important` message into its running turn (#572): the hub sends it as a soft interrupt through jcode's own private server socket, which jcode injects at its next tool boundary, so the message no longer waits for the turn to end. The hub never cancels a turn to deliver. Headless Kimi and Qwen have no such path: an `important` message waits, and `ahub status` and the console show `important messages waiting on a busy ACP peer for N min` once it has waited past `budget.stale_min`, so you can decide to stop the peer.

jcode has no switch to choose which MCP servers its `serve` and `acp` load, so the hub-owned jcode starts every server named in `<JCODE_HOME>/mcp.json` and the project's `.jcode/mcp.json`, `.mcp.json` and `.claude/mcp.json`, besides the hub's own (#572). `ahub doctor` lists their names in its `jcode MCP servers` row (names only, from those four files only). To keep a server out, remove it from those files, or point `jcode_home` at a separate home.

Known ceiling (#559): jcode 0.98.1's top-level TUI spawns a shared server, without `--temporary-server` or `--owner-pid`, when nothing answers on the dialed socket at startup or on its reload-handoff reconnect, and no native flag prevents it. A hub stop or an owned-server crash between the launcher's confirm and the TUI's check can leave an unowned jcode server on the private socket under the person's `JCODE_HOME`; stop it by hand. Revisit if upstream adds an owner flag. An option that differs from the running session (`--model`, `--provider-profile`, `--session-id`) is refused by name.

TUI input may interleave with an ACP turn; there is no single-writer guard. Closing the TUI leaves the owned ACP session running, and native policy remains unmanaged. The isolated 0.98.1 transport receipt is [recorded separately](verification/2026-10-20-jcode-tui-0.98.1.md); it is not personal account or real provider verification.

After upgrading to the recipient-retry release, a Jcode project MCP entry written before `AGENTHUB_DELIVERY_ONLY` was added is intentionally stale. Once per project, the person runs `ahub jcode --mode headless` before using conductor/dashboard starts. The launcher rewrites only the owned entry with the delivery-only marker, preserving foreign entries and refusing collisions; recovery relaunches already use this CLI path. Readiness checks never rewrite the file, and an explicit false marker or any other drift remains refused. Until that rewrite, daemon starts keep their actionable stale-entry refusal rather than advertising a retry tool Jcode cannot use.


Native policy is unmanaged and has NO hub sandbox; no permission_modes.jcode or runtime mode mapping is invented. Quota and consumption remain unknown. Supported versions run from 0.98.0 up to, not including, 1.0.0 (#529); another version is refused before the owned daemon starts, with the version named and the trust command (#691). Every owned jcode process (version probe, daemon, ACP and TUI) runs with `JCODE_NO_TELEMETRY=1`. Native session/load (verified on 0.94.0, 0.98.1 and 0.99.1) cannot prove identity, so attached Jcode blocks controlled recovery before effects and crash recovery asks for deliberate native reopening. A requested load without an echoed identity refuses; no fresh session is presented as restored. Provider/tool/native teardown receipts remain unverified in the pinned contract report.

## Optional Antigravity (agy) peer

Antigravity is optional and off roster by default. Use `ahub roster add agy`, then run `ahub agy` in a terminal: it runs the Antigravity CLI as a fresh pull-only TUI in that terminal. It accepts the 1.4.x line: 1.4.2 and 1.4.7 are the verified versions ([1.4.7 receipt](verification/2026-10-26-agy-1.4.7.md)), any other 1.4.x launches with a stderr warning (agy updates itself), and other versions are refused (#589) unless the person trusts that exact version with `ahub agents trust agy <version>` (#691). The running hub must advertise `native_hook_launch`; an older hub refuses before any write with an upgrade-or-restart remedy. Only the person's launcher starts it: conductor starts are refused, there is no controlled restore or resume, and a declared agy extra instance is refused when the config loads (#625). Headless/print, resume (`--conversation`, `--continue`, `--new`), `--mode`, `--dangerously-skip-permissions` and `--unattended` are refused until their native mapping is verified; `--print-command` previews without writing.

The launcher writes exactly `plugin.json`, `mcp_config.json` and `hooks.json` in `.agents/plugins/agent-hub/`, refusing linked or foreign entries before any write, and removes only its own matching files when the TUI ends. It never writes project-level `.agents/hooks.json` or the person's `~/.gemini` settings. Run `ahub init` afterwards to ignore the untracked plugin directory; a tracked plugin is written with a warning. The native model sees the hub tools under the server name `agent-hub_agent-hub`.

Like Kimi's TUI, agy is pull-only: it reads `hub_inbox` and shares results with `hub_send`, messages do not interrupt it, and automatic routing never picks it. Its roles are capped at implementer and verifier; a plan or review assignment and PII work are refused. Native permissions are unmanaged, with no hub sandbox, hub permission mode, quota source or session resume. Plugin hooks bound to that launch carry the hub's turn facts and report each completed native turn. A native read is recorded as a peer `Read` fact: `view_file` (`AbsolutePath`) in 1.4.2 and `read_file` (`Path`) in 1.4.3; a `StartLine`/`EndLine` range counts as a partial read, never a whole-file view (#555). The live TUI/account leg is unverified ([T0 receipt](verification/2026-10-19-agy-p1-t0.md)). The 1.4.3 T0 re-run keeps 1.4.3 unverified: its `call_mcp_tool` schema and native tool names changed, and the TUI attaches the hub tools only from the second model turn ([1.4.3 receipt](verification/2026-10-21-agy-1.4.3-t0.md), #607).

## Configured ACP adapters (#451 A3)

A tool that speaks standard ACP over stdio can join a project without a code change. The declaration is machine-local authority: put it only in an untracked `.agenthub/config.local.json` (in `config.json` or a tracked file it is ignored with a notice), then restart the hub. The hub compiles its adapter catalog once at startup, so adding, changing or removing a declaration needs a restart; settings list the change as pending restart and never edit `adapters`.

    {
      "adapters": {
        "myagent": {
          "transport": "acp",
          "command": "/opt/myagent/bin/myagent",
          "args": ["acp"],
          "displayName": "My Agent",
          "roles": ["implementer", "verifier"],
          "identity": { "name": "<initialize agentInfo.name>", "version": "<agentInfo.version>" },
          "permission": { "ask": "<native mode id>", "ask-when-needed": "<native mode id>", "never-ask": "<native mode id>" },
          "readOnly": "<native read-only mode id>"
        }
      }
    }

- The kind matches `[a-z][a-z0-9-]`, has at most 32 characters, and may not collide with a builtin peer, an `ahub` command or a reserved id. A project can declare at most 64 kinds. Unknown fields refuse the config.
- `roles` is a non-empty subset of `planner`, `implementer`, `verifier` and `reviewer`. `conductor` is refused here; only explicit project role policy can appoint one.
- `identity` is the name and version that ACP `initialize` reports. A start without it, or with a mismatch, refuses before any prompt.
- `args` may not select a leader, attach, connect or remote mode (`--leader*`, `--attach*`, `--connect*`, `--remote*`): only a foreground process the hub owns is supported. A Grok declaration (kind `grok`, a `grok` executable or identity name `grok`) must also pass a standalone `--no-leader` before any `--`. Grok 1.0.62 itself is not supported ([T0 receipt](verification/2026-10-21-grok-config-acp-t0.md)).
- `permission` maps hub modes to native ACP mode ids. Only mapped modes can be selected, and the session must advertise and acknowledge each one. Without a map (or with an empty one) native policy is unmanaged: `ahub permission <kind> <mode>` and `permission_modes.<kind>` are refused. No hub sandbox applies either way.
- `readOnly` names the native mode that read-only instances use (below). It is not applied to the kind itself.

    ahub roster add myagent          # configured kinds are off roster by default
    ahub myagent                     # headless; asks the running hub to start it
    ahub myagent --session-id <id>   # load a recorded native session; the agent must echo the id
    ahub myagent --print-command     # preview: executable, argv and session id are withheld
    ahub stop myagent

`ahub <kind>` accepts only `--mode headless`, `--as <instance>`, `--session-id <id>` and one of `--print-command`/`--dry-run`; model, route, unattended and other launch overrides are refused. The running hub must advertise `configured_acp` and list the kind as loaded; otherwise the command tells you to upgrade or restart. If the file changed since the hub started, the start warns and uses the running definition. A conductor may start the kind with `hub_peer_start` (headless, with no session override). There is no TUI form: `peers.<kind>.start_mode` accepts only `headless`, and `ahub watch` is not available. Default routing never picks a configured kind; it gets work through its roles, an explicit owner or reviewer, or a reservation.

Before admission the hub verifies the native identity, a valid session id, the requested native mode and positive ownership of the spawned process and its process group. A failure refuses the start with a generic reason; the agent's stderr and error text are withheld from the log. `ahub stop` signals only that original verified group. If teardown cannot be confirmed, the peer stays offline but held, and new starts are refused until `ahub stop <kind>` succeeds.

Extra instances use the existing `instances` block. For example, `"myagent-review": { "kind": "myagent", "roles": ["reviewer"], "readOnly": true }` is started with `ahub myagent --as myagent-review`. Unlike the kind, a declared instance is on the roster by default. `readOnly: true` requires the kind's `readOnly` mode, and the session must advertise and acknowledge that mode before a prompt. Native permission requests other than read, search and think are rejected. The instance is offered only `hub_send`, `hub_inbox`, `hub_delivery_done`, `hub_review`, `hub_task_show`, `hub_task_list`, `hub_memory_search|show|graph` and `hub_status`; the hub refuses every other hub tool. Its permission mode is locked: settings show it as read-only, no write, undo or `ahub permission` changes it, and `permission_mode` next to `readOnly` is refused.

Configured kinds are cloud peers and never receive PII work. Quota and context are unknown, and a kind with no budget source is exempt from quota accounting, so pause it by hand if its provider refuses. After a crash the hub resumes a recorded session through `session/load` only when the agent echoes the same id, and it never reuses a recorded model. Controlled recovery (`ahub upgrade`, `restart`, `recovery`) refuses a running configured kind: stop it, then start it again with its session id. While the project declares adapters, the upgrade or restart target must advertise `configured_acp`.

## External adapter modules (#451 A4)

A bundled adapter module is authorized by the person with `adapter_modules` (at most 16 rows of `path` and `sha256`) in an untracked `.agenthub/config.local.json`; in `config.json` or a tracked file it is ignored with a notice, and settings never edit it. Only daemon startup imports a module: settings, reload, previews and CLI reads never do, so a change needs a restart. The module must be a single self-contained ESM file inside the project (no symlinked, world-writable or oversized file) whose bytes match the pin, and it may import only Node/Bun builtins and `@staix/agent-hub/adapter`; the scanner also refuses any `require`, `eval` or `Function` word token. Each import must settle within 2 s. A module that fails any check is refused on its own, with a bounded reason in the status reply, while startup and the other adapters continue; its roster row stays inert. A loaded kind is headless, cloud (never PII), off roster until `ahub roster add <kind>`, and has no controlled recovery: stop it and start it again with its recorded session id. While modules are declared, the upgrade or restart source and target must advertise `external_adapter_modules`. Bundling, the accepted definition subset and the conformance kit (`@staix/agent-hub/conformance`, for module CI only) are in [Adding an AI tool](adding-an-ai-tool.md#5-external-adapter-modules-451-a4). A pin authorizes code that runs with the daemon's rights; it is not a sandbox ([security](security.md)).

# Headless ACP watch (#286)

- A person opens `ahub watch kimi` or `ahub watch qwen` in a second terminal. `--no-thoughts` hides thought items; `--color=auto|always|never` controls colour. `q` or Ctrl+C leaves the view, keeping the peer running. Answer approvals in `ahub console` or with `ahub permit`.
- Watch replays bounded memory history from this daemon, then displays live updates. It is the hub's read-only view, with no prompt input. It does not read native session files.
- Kimi's default is its own pull-only TUI (#316). Watch requires `ahub kimi --mode headless`; its own TUI remains visible in its native terminal. Qwen requires roster participation and a receipt-verified ACP identity. Watch is for headless Qwen; `ahub qwen --mode tui` is Qwen's own terminal (see Optional Qwen Code peer) and has no watch view.
- Protocol stays 16; a same-protocol older daemon answers the new request as unknown, which the CLI reports. Since 0.12.44 a headless start that the hub itself makes for Kimi or Qwen opens this view automatically through the terminal provider (see Start modes; #286).
- Native T0 limits: [ACP watch verification](verification/2026-10-11-acp-watch-t0.md).

# Acceptance-criteria checklist (#481)

- The task reviewer/person records a head-bound `criteria` receipt with criterion ids matching the issue's AC ids, required/result fields and hashed evidence refs. This checklist belongs to the Compliance review pass. Use `ahub sdlc record <id> '<receipt JSON>'`; [schema and example](sdlc.md#acceptance-criteria-checklist).
- Deliverables (#509a, docs/sdlc.md, Deliverable records): `hub_task_done` and `hub_sdlc_record` take `deliverables: [{path, format, version?}]`; the hub hashes the files itself (a claimed hash is refused), in a plain folder with no git or PR, under the owner's execution root (its own worktree for a declared worktree instance; an unproven root refuses and reads `unknown`), and a reviewer's approval is refused with `deliverable changed since it was delivered` when a file changed since delivery (the owner calls `hub_task_done` again, or the person approves the current bytes). `ahub task show <id>` shows each file's state (`unchanged`, `changed`, `missing`, `unknown`) and `changedSinceReview`; a PII task or `pii.paths` file shows id, hash and size only. The person lists every task's delivered and approved files with `ahub deliverables [--task <id>] [--approved] [--check] [--json]`: without `--check` it reads the board's records and opens no file; `--check` measures them now and marks a row `changed since review`, `a file is missing` or `could not be measured`. The dashboard card shows a `Deliverables n` chip and the task sheet a Deliverables group from the same records; it shows a change only after a live check. An agent's shell gets only the tasks `hub_task_show` would show it (#933).
- The review request lists the recorded criteria with their ids and results, and a `hub_review` unmet item that starts with a recorded id (`AC2: ...`) is recorded on the verdict as `unmetCriteria` (#507b); `ahub task show` lists those ids in the history. A task with no checklist, and a PII task, are unchanged.
- Advise shows incomplete/stale checklist blockers; enforce checks them at approval. The `criteria` gate does not need a workflow selector. Dependencies stay with `ahub task propose --after`; checklist task import is removed.
- `status <id>`, `explain <id>` and `export <id>` use the same current board/config projection. Export keeps sanitized state and source hashes, with no external text, extra authority or verification claim.
- Migration from the retired workflow and its compatibility window (until hub 0.13.0) are described in [Retired workflow compatibility](sdlc.md#retired-workflow-compatibility-252-481-s8). Stored checklist task lists are ignored with a visible note; they never change board dependencies.

# Catalog session guidance (#295)

- Read available guidance with `ahub role list [--group dev|research]` and `ahub role show <id>`. Each definition identifies its layer and content hash. Doctor reports invalid files/selections without printing their contents.
- Select up to two ids per peer in `catalog_roles` in the shared/local config, with at least one flow base already held by that peer. Empty local lists clear shared selections. This initial slice applies selections at a new daemon/MCP/adapter start; live assignment/settings and task roles follow separately.
- Defaults preserve the existing flow. Catalog guidance adds no authority or routing preference. Native ingestion/retention and measured benefit remain unverified. Schema, bounds and source notice: [roles](roles.md).

# Project profiles (#259)

- Initialize new projects with `ahub init --profile research|writing|general`; default dev retains its existing templates and contracts. Profile aliases map to the existing base flow and are displayed beside it.
- Non-dev plans declare paths, section anchors, source ids and claims. Configure completion checks explicitly in machine-local config; selecting a profile never starts a check or study. Schema, examples and pending converter/policy slices: [profiles](profiles.md).

# Private and read-only data paths (#259)

- Optional pii.paths forces matching declared refs/plans/section files to the on-prem flow before triage and memory, including when ordinary pattern routing is off. Optional data.readonly protects managed local/Pi writes and makes managed commands filesystem read-only.
- Both lists are empty by default and apply at daemon start. Reads/stdout remain available; command-created files/caches are blocked in read-only mode. Exact path rules, alias handling and evidence: [data policy](data-policy.md).

# Rich-document text projections (#259)

- Configure text_projection only in an untracked machine-local file, with a separate {input} argv argument. Facts uses bounded read-only/no-network conversion from a scratch directory, where the converter reads only its input snapshot and its own program and script files (no other project file, even under `local.read_allow`), and a content/config cache; failure keeps the prior file view and logs a bounded notice, and a conversion that failed with its full deadline is not retried for the same bytes and command while its entry lives in the failure record, which is in memory, bounded at 1024 entries, and cleared when full or at restart (#382).
- Raw change identity and projected presentation stay separate; private paths never enter conversion. Schema, limits and current surface scope: [text projections](text-projection.md).

# Task catalog guidance (#295)

- A proposal may name `role` from `ahub role list`. The allowed class list is checked in Tasks, and assignment/review notices carry bounded guidance. The role grants no authority and changes no routing decision. Scope and pending person-assignment surfaces: [roles](roles.md).

# Person catalog-role assignment (#295)

- Use `ahub role assign <peer> <id>` or `ahub role clear <peer> [<id>]`, or the dashboard Roles settings group. The selection is bounded to two compatible catalog ids, writes only machine-local settings and applies at the next peer start. Inherit and explicit no roles are distinct.
- Change an open task's guidance with `ahub task role <id> <role|none>`. Agent shells and peer/tools control clients cannot use these mutation commands. Details and unconfirmed native consumption: [roles](roles.md).

# Document projection review and undo

- Machine-local text_projection also supplies bounded review and reverse undo previews from stored raw snapshots. Task-proposal baselines survive restart and reviewer changes; missing/private/pruned evidence is unavailable. See [text projections](text-projection.md) for caps and converter requirements.
- Undo remains a raw-file operation: projected text cannot bypass later-edit, concurrency or unknown-turn refusals. Native model/account ingestion remains unverified.

# Opt-in shadow repository

- `ahub init --profile research|writing|general --shadow [--dry-run --json]` supplies hub-owned snapshot/facts/undo storage for a non-git folder. It creates no `.git` entry and never switches an existing Git project.
- Maintain `.agenthub/ignore` for large/raw data. Snapshot and facts operations leave the shadow index/HEAD alone; raw undo refusal rules remain authoritative. Shadow metadata stays protected from managed worker writes. See [profiles](profiles.md).

# Per-project profile data

- Use `profile_overrides` for class aliases, supported plan selection, role guidance, catalog defaults, managed AGENTS content and advisory example checks. Shared/local maps merge by key; selections/text replace. See [profiles](profiles.md).
- Refresh instructions with init and restart the daemon/MCP clients to apply their resolved contracts. Existing flow-role and executable-check authority remains in `roles`/trusted `checks`. Native model/account evidence remains unverified.


## Staging work in Backlog (#263)

Use `ahub task propose implement "Later work" --backlog --owner codex` to stage
work without routing it. The owner is a reservation, including when an agent
names itself. Normal proposal behavior is unchanged without `--backlog`.

The person inspects `ahub board backlog` and `ahub task show <id>`, then runs
`ahub backlog pull <id>` to put it in To Do. Dependencies still block assignment.
Ready work uses the existing assignment and delivery-recovery contract; if no
peer can take it, a later attachment or restart can offer it. Return ownerless
To Do work with `ahub backlog return <id>`. Owned or started work cannot return.

Ordinary agent task lists and conductor task reads exclude Backlog. Staged work
is never claimed, accepted, completed, swept, escalated or relayed. PII cards and
notices use the existing public stub. Planner grooming, five-column views, releases and dates are described below.
The native planner/two-release smoke remains unverified; board release actions
never tag or publish software.


Pulling Backlog establishes its first execution-proposal boundary for projected
review snapshots and research records. An initial Backlog row is not an offered
proposal. Research uses the first pull time and preserves identity across later
unstarted return/pull cycles; a new backlogged id after reset starts a new record
generation. Partial work with acceptance/check/review evidence cannot return to
Backlog even after decline or reassignment leaves it ownerless.


## Dashboard project board (#263)

The board displays Backlog, To Do, In Progress, Review / QA and Done from task
states. To Do separates ready work from dependency, reservation, delivery-hold
and unavailable-owner waits. Review and Done offer no flow dragging. Owner and
reviewer names remain readable beside their filled/outlined color markers.
Urgent tasks display P0 and a star; ordinary legacy tasks display P2.

The legend reads the same live peer status as `ahub status`, with a derived
owned-work count, active board ids and explicit permission display. Use the agent
filter or By agent lanes to inspect work. Done shows recent rows first, with
older rows expandable. At phone width columns stack and controls remain usable.

Drag eligible work onto a peer to assign it, or use its labelled select and
Assign button. Drag Backlog into To Do to pull it; return only ownerless To Do
work to Backlog. Each move has a button/keyboard equivalent and reaches `Tasks`
through the existing authenticated console/dashboard action path. Cards carry
origin, project, instance and view-generation fences; stale or foreign drags
are refused. Review/verdict/approval transitions stay with their flow actors.

A hub advertises Backlog support explicitly. Older or unknown snapshots cannot
silently turn Add to Backlog into an immediate offer. PII cards retain their
public stub; legend entries contain ids/counts, never task prose. Planning priority/rank, releases, dates, planner grooming/undo and GitHub import
are described below. Native planner-cycle evidence remains unverified.


## Planning and phased releases (#263)

Use `ahub backlog list` to read public staged work (a table by rank with the reserved owner, dependencies and cut titles, then a count by reserved owner; `--full` and piped output keep whole titles and `--json` prints the raw listing), then `ahub backlog plan <id>
<revision> <fields-json> <reason>` to set rank, priority (0-3), release id, planned
start/due UTC milliseconds or pin. `pin` accepts true/false; `undo` needs the
current revision and latest eligible edit. The dashboard provides local-time
date fields, task/release filters and lanes, and Reload current values when an
edit is stale. A person's order, pins and frozen scopes protect planner changes.

Create a phase with `ahub release new <name> <goal> <order>`, inspect `list` or
`show`, and set planned start/cut/ship with `plan <name> <revision> <dates-json>`.
`activate`, `freeze`, `ship` and `drop` need its current revision. Only a person
freezes, ships, drops or edits frozen scope. Ship records the first ship time
only after every member is approved, cancelled or moved out; it runs no tag or publish.
The dashboard shows phase progress, blocking dependencies, dates and remaining
work. Actual task dates come from execution/review/approval history, never input.

Configured planners read `hub_backlog_list` and `hub_release_list`, edit the
cards they plan (see "The planner") with `hub_backlog_plan`, and undo their own latest eligible change with
`hub_backlog_undo`. Catalog guidance or a caller-supplied role grants no authority.
PII cards stay stubs, reasons are screened/withheld in public history, and planning
telemetry records ids/changed fields without prose. #247 task records carry
optional release, priority, plannedStart and due, retaining unknown legacy data.

Dependency/reservation planning, split/pull WIP limits, batched incoming notices
and one-way GitHub import are described below. Source checks are recorded in the
release verification report. Native planner work across two releases remains
unverified; source and fixture checks do not establish installed live behavior.

Office merge corrections retain the header's view selector when Off hides the
scene. Activating a card reveals its task if a state filter excluded it; Work
includes rework. Stable desk slots determine bounds after peers disconnect.
Reduced motion removes departures immediately and the existing snapshot poll
prunes transient deadlines without new timers. Explicit unattributed turns have
no guessed task bubble. Warning caps retain conflicts first and parallel warning
kinds have separate segments/labels. Physical visual validation remains pending.


Planner backlog plans also accept `deps` (at most 64 unique task ids) and
`reserved` (rostered peer id or null). Dependency/reservation edits require
unstarted, unowned backlog work even for the person; cycles and missing ids
are refused before persistence. Planning undo restores previous dependency and
reservation values at the same revision fence. Editing never routes work.


Release date editors invalidate stale revisions and offer Reload current release
without overwriting unsaved dates. Project changes clear release creation drafts.
Dashboard release actions use public numeric ids even when labels are withheld;
`ahub release show <name>` looks up the stored identity on the console and returns
the screened public projection. Exact-head source verification is recorded in the release report.


## Planner WIP pull (#263)

`hub_backlog_pull` takes id, current planning revision and a bounded reason. A
configured planner with assignment capability reserves a ready To Do slot using
current routing, roster, class, quota and health constraints. It refuses pins,
unapproved dependencies, frozen scope and overriding person P0 order/reservations.
The person uses `ahub backlog pull-ready <id> <revision> <reason>` or Pull within
WIP on a card. Explicit manual pull/assignment retain their existing authority.

A pull of a reserved backlog task (#718) assigns it to exactly that reserved peer
in the same write and sends it a fresh owner offer, so it can accept at once. A
reserved peer that cannot take it (offline, paused, excluded, at its WIP limit)
refuses the pull before any change, naming the peer and its reason; it is not
passed over to another peer. `ahub route explain` previews the same reserved-only
choice. An unreserved pull keeps reserving a slot as above. A reserved offer that
was never started can return untouched and keeps its reservation.

Capacity defaults to one per peer. Each declared instance has its own `tasks.wip_limits.<instance>` key. `ahub settings set tasks.wip_limits.codex 2`
uses the existing machine-local registry path; integers 0..32 apply live (the next
admission reads the current value), with 0 disabling planner admission for that
peer. Status and the agent legend count
owned unfinished work plus unowned planner-pull reservations, and show how that
count splits (#784): `ahub status` prints `<peer> planner WIP 3/3 (active 2, review-wait 1, reserved 0)`,
the console Peers detail (Enter) has a `planner WIP` line, and the dashboard legend shows the same split.
`active` is owned work that is not waiting for review, `review-wait` is owned work in review (it still
holds its slot), `reserved` is a planner-pull reservation nobody owns yet; the three add up to the count
admission reads, and the split changes no admission decision. An older hub shows the plain count. The same limit gates
acceptance and self-claim in every lifecycle mode, so 0 refuses new acceptances; a
current owner's redo of sent-back work keeps its slot (#481 S9).

Pending unowned, unstarted pull can be undone at its latest owned revision via
`hub_backlog_undo` or the existing planning undo control, restoring its earlier
reservation. An ordinary return to Backlog also restores the pre-pull reservation unless a later explicit reservation edit superseded it. Normal release routing offers work only while that reserved peer
still has capacity; no other peer inherits its slot. Split and one-way import are described below. Native verification remains
outstanding; exact-head source checks are recorded separately.


Planned-date editors preserve loaded UTC milliseconds until their displayed
value changes, including repeated local wall times during a clock change. Local
inputs retain seconds/milliseconds and support HTML date years without truncating
fields; see https://html.spec.whatwg.org/multipage/common-microsyntaxes.html#local-dates-and-times.
Date-editor source proof is recorded with the exact-head checks.


## Backlog split (#263)

Use `hub_backlog_split` with parent id/revision, reason and two to eight part
objects, or `ahub backlog split <id> <revision> <parts-json> <reason>`. Each part
has a title and optional detail/class/refs/plan; `after` names existing ids and
`afterParts` names earlier zero-based parts. The selected task's dashboard Split
form accepts one title per line and optional sequential dependencies.

The original card remains integration/acceptance work and waits for every part.
Children retain prerequisite, privacy and phase planning. A person's P0 order
permits that goal's required predecessors, preventing dependency deadlock.
Unused unchanged backlog children can be removed by latest split undo; later
edits, execution, ownership or outside references refuse it. All writes roll
back together and observers receive changes only after commit. Exact-head source checks are recorded separately; native verification remains
unverified.


The manager allows split screening, the bounded database wait and forwarding margin before declaring a missing reply unconfirmed. Reload the task before retrying an unconfirmed split. Stored role ids survive unavailable catalog guidance. Task memory-reference markers do not supersede assignment or check results, and dependency recovery ignores them.

## One-way GitHub intake (#263)

`ahub board import github --label <label> [--milestone <milestone>]
[--repo <owner/repo>]` is person-only. Omitted repo is resolved by gh in the
project directory. The command reads open issues with fixed bounded argv and
stages up to 32 into unoffered Backlog, retaining canonical repo/issue identity
across restarts. Repeating intake does not refresh or overwrite existing cards.

The response lists confirmed imported/existing task ids and explicit partial,
complete and unconfirmed state. A truncated page, time budget or interrupted
staging is incomplete; repeat safely to reconcile the persisted identity.
Public cards link to their source; PII cards expose no external identity.
GitHub comments/labels/assignment/closure are never written. Exact-head source checks are recorded separately. Native verification remains
unverified; no live account import was performed.


`ahub board --columns` groups the same state-derived columns and ready/waiting
reasons as the dashboard; `--release <name> | --release-id <id>` filters public rows on the hub.
`--columns --json` returns filtered tasks and column metadata together. Ordinary
peer reads retain the existing backlog prohibition. Phase views flag public ids
approved after a known cut outside that release, and separately list unknown
approval times without inventing dates. Exact-head source verification is recorded in the release report.
## Global attention and prompt output (#280, phase 3)

`ahub pet` reads the selected project's status file without a control token or
network connection. It accepts only structural counts/state/first metadata from
a confirmed daemon owner. Missing, malformed, legacy or unconfirmed data is
reported as unavailable; it is not an empty live hub. `ahub pet --short` writes
`ahub!N` when a known action count is positive, otherwise no bytes, including no
newline. Explicit `pet` reads remain available when the presentation is off;
normal `ahub status` appends the line only while the project's pet is enabled.

An open recovery lock is read without coordinating the operation. Only the
shared runner check's observed absence adds an action; unknown remains watch and
is labelled unknown. A matching daemon recovery watch is replaced once, without
double counting. A missing hub status is labelled unavailable even when a known
recovery action can be shown. The output never resumes, aborts or disposes a run.

Person-reviewed tasks contribute review actions; an offline peer holding
unfinished work contributes one watch item with its lowest task id. The console
receives those structural facts through its existing authenticated status reply.
Outside the Tasks table, `n` selects an exact visible review task, or prints the task/review guidance if
that row is unavailable. Offline guidance names status/task reads and an explicit
assignment command. No command is executed by navigation. There is no extra
console poll, timer or task-list request for stream mode.

Intentionally person-owned work is not an offline agent. Neither user nor hub
creates an offline watch item, while person-reviewed tasks remain actionable.
Status reads only the board's structural id/state/owner/reviewer projection and
reuses it for retained peer ids, avoiding task body/plan/history decoding.

Planner reservations normalize the same lowercase peer syntax as owner arguments,
reject reserved pseudo-peers and unknown unconfigured ids, and still enforce the
roster. Returning unstarted ownerless work to Backlog joins the next planner
notice batch without waiting for a restart.

Queued planner batches retain bounded ids-only backlog references and recheck
the board at actual delivery. A batch containing pulled/removed work is discarded
before reaching the planner; its remaining backlog ids join the next batch. This
floor also applies during the legacy stale-notice delivery experiment. No task
text is copied and no routing/ownership state changes.

## Console character choices (#280)

`pet.character` selects stai (default), gyul, lantern, cursor-cat or boxbot.
`pet.size` selects line (default), mini or full. Mini needs 100 columns; full also
needs 40 rows, and smaller terminals fall back automatically. `P` cycles the
built-ins and off for the current console only. `?` lists this under Pet, even
while drawing is off. The command prompt keeps its original row and width.

`pet.glyphs` selects auto/ascii/blocks; unsupported locales and dumb/linux
terminals retain the ASCII floor. `pet.blink:false` is static. `pet.palette`
selects blue, teal (default), violet or ochre (`a`/`b`/`c`/`d`), and `pet.window`
controls standalone window opt-in; both `pet` (`false` or an option block) and its
fields validate identically at startup and reload in `.agenthub/config.json` and
`.agenthub/config.local.json`, apply live as console-local presentation (including
an open console's next refresh and the standalone pet window), and grant no
authority (#483). Neither
choosing nor drawing a character changes authority, config files, task state or
polling. Explicit `ahub pet` and text status use the configured line face; prompt
tokens remain character-independent. Native glyph width and tmux are unverified.

## Dashboard views and attention (#391, replaces the #280 in-page character)

Top buttons select Board, Office, Stream, Agents, Message, Memory or Settings
within the same page. The selected view and board column focus use the shared
host-scoped cookie helper; the URL fragment remains reserved for the session
ticket. Sections are hidden rather than fetched separately. Projects and
Benchmarks live under Agents alongside peers, approvals and usage budgets.
Office mode stays an explicit Off/Flat/Isometric preference inside Office.

Board cards show id/title, priority, owner dot and overdue/check markers.
Click or Enter opens a native detail dialog with the full stage/dependency,
release/date, SDLC, detail and GitHub content plus existing Pull/Return/Assign
controls. Snapshot changes refresh the dialog; project reset or a task leaving
the snapshot closes it. Expand on a column shows one wide list of full details;
Back returns to compact cards. State/agent/release filters still apply.

The shared pure needs model now drives the nav attention badge and existing
action-count tab title. Agents has a live pending-approval count even when
attention metadata is unavailable. Activation switches to the matching view
and focuses only the exact visible approval/task id; missing or filtered rows
receive fixed structural guidance, with no peer or first-row fallback. No
workflow action is issued and no filter is changed by attention navigation.
Invalid/legacy attention hides its badge and restores the base title.

The in-page pet, its SVG and character/pixel payload are removed. The standalone
macOS window owns character presentation. Existing snapshot poll, session,
request types and CSP hashes remain; no route, request or timer is added.
Browser screenshots/CSP-console verification are separate manual evidence on
the implementation PR; VM/HTTP fixtures do not establish human visual results.

With mini/full characters, active console notices remain visible away from the
character: panel body rows show the bounded wrapped notice, and stream mode
prints each fresh notice once through the existing local stream. Footer prose
exclusion and fixed prompt/footer geometry remain. No new request or timer.

Automatic reroutes of planner-pulled work retain WIP and delivery-hold admission
during offline, budget, roster and idle recovery. Explicit manual assignments
retain their existing override authority.


GitHub intake refuses comma-containing labels rather than allowing gh to split
one literal label into several filters. WIP capacity excludes owner candidates
only; eligible reviewers retain normal review routing. An auto-reassigning
planner idle sweep waits without consuming its final step while no owner has
capacity. Parent-only memory notes do not prevent unused child undo; child
reference markers remain protected. Split-part plan schemas follow the selected
project profile. Terminal tables preserve the visible read for stages and use
a fresh peer status read on the same authenticated connection.

Integer WIP editors save a value, including zero and inheritance; it applies at the next admission. GitHub intake accepts dot-prefixed repository names within the existing bounded owner/repository identity. Split undo also refuses children referenced by another task's persisted phase checklist.

Declining rework returns changes_requested to To Do before rerouting. When a planner-pulled task has no eligible destination capacity, it remains ownerless in To Do and is retried after capacity clears, preserving the declined-owner exclusion. A planner pull that finds no owner names the cause by peer id: a lasting exclusion, WIP full (with wip/limit), a held queue or needs_review deliveries; a capacity-only decline is not an exclusion (#531).

With no release cut, outside approved tasks are reported under unknown cut evidence, including tasks with a known approval time. A child task execution budget also prevents split undo until the person disables that budget.

Split children retain their initial deterministic and inherited privacy signals across awaited screening. A routing-pattern reload cannot remove those captured signals from an unscreened child at final validation.

If a routing pattern adds deterministic privacy during screening, split history and telemetry use regex-private provenance rather than an earlier clear model result. The same captured final signals determine both the child and its provenance.

Dashboard backlog splits receive a dedicated outer HTTP request bound above manager forwarding, using the shared screening/database bounds and margin. Ordinary action policy remains unchanged. At phone widths, split form grids use one column so native date controls remain inside their panels.

An acknowledged ACP permission-mode change awaits queued cancellation cleanup only when the cancelled prompt response has already been observed. A still-unreported cancelled prompt stays busy under its existing deadline, while mode acknowledgements remain available. A successful mode acknowledgement alone does not prove the peer is idle.

Task idle sweeps ignore body-free memory-reference bookkeeping when finding the last real activity. Saving a task note or goal link does not postpone an idle notice or restart its escalation ladder.

Split reasons preserve deterministic privacy from both initial and final policy checks, including parent privacy. Once withheld, a reason stays withheld in public history even if routing patterns are later removed.

GitHub import rejects labels containing commas or double quotes before invoking gh, since its CSV-style label parser could otherwise select a different literal label.

Ask evidence skips body-free memory-reference markers when selecting the latest task transition and note. The selected note retains the existing withheld and on-campus privacy checks.

GitHub intake checks its staging deadline after every awaited proposal, including the final issue. A confirmed late save returns its task ID with partial=true and complete=false so the operator can read back and resume.

If GitHub intake saves a row but later bookkeeping fails, canonical identity readback preserves the confirmed ID and queues its Backlog notice. The response remains partial; unreadable or missing readback remains unconfirmed.

A later issue lookup or profile-preparation failure also returns the IDs confirmed earlier in the import as partial progress.

Release cut audits return exact counts with at most 32 example IDs per category; the dashboard states how many IDs are shown when truncated. Scope grouping and indexed approval dates avoid scanning each task history for every release. Full audit pagination remains a future extension.

Release cards include task states in their refresh key, so completion of an outside prerequisite updates blocked counts even when the release and audit preview are unchanged.

## Standalone macOS pet window (#391)

From a person's terminal, `ahub pet --window` starts one floating, transparent
JXA panel per project; `ahub pet --window --close` closes it. Other platforms
print unsupported and retain `ahub pet` / `ahub pet --short`. An agent-marked
shell may read the terminal pet but cannot start or close the window.

Set `pet.window: true` in `.agenthub/config.json` or `config.local.json` to start
it with `ahub up`. A window-only local opt-in preserves inherited `pet:false`
for terminal/status/dashboard presentation; explicit local character options
retain their existing presentation override behavior. The
window uses the configured built-in character, full pixel frame and blink
choice. Its body opens `ahub ui`; the pencil opens an inline console message
box (Enter sends through `ahub say`, Esc cancels). Drag the body to move it;
`pet-window-pos.json` remembers the position, with an on-screen fallback if a
saved display has disappeared. The panel joins all Spaces without a Dock icon.
The 150x150 panel keeps the status pill and message composer hidden until the
pointer is over the character. Deep state colors and a dark rim shadow keep the
pixel silhouette readable on light backgrounds. `pet.palette` selects the base
color: teal (default, b), blue (a), violet (c) or ochre (d), each with its own
rim line; the waiting/blocked/review/offline colors stay fixed. While the
window is key, 1/2/3/4 switch blue/teal/violet/ochre and save the choice.
From a terminal, `ahub pet --palette <blue|teal|violet|ochre>` writes the
choice to `pet.palette` in `.agenthub/config.local.json`.
While working, the pixel art bobs in a 0.7-second stepped CSS loop; reduced-motion preferences keep it still.

A detached Bun host refreshes `pet-view.json` once per second using `readPet`
and `loadPetConfig`. The file contains only state/counts/character/blink and
built-in pixels. It uses no dashboard session or HTTP listener. An unavailable
hub displays Offline for two seconds, then the panel and host exit. Closing
JXA exits the host too. `pet-window.pid` holds the host's process signature;
an uncertain owner is retained rather than signalled. A stale owner requires
an explicit `--close` before restarting; a malformed pidfile requires operator
inspection. A send failure is unconfirmed: check the stream before retrying.

Native transparency/floating and the bridge were verified in the macOS spike.
Real keystrokes, dragging and persistence, Spaces, message delivery and body
click need the manual PR checklist before merge; automated fixtures do not
establish those native results.

## Additional headless peer instances

Declare extra instances only in an untracked `.agenthub/config.local.json`, then
restart the hub. For example, a reviewer can use:

```json
{
  "instances": {
    "codex-review": { "kind": "codex", "roles": ["reviewer"] },
    "kimi-review": { "kind": "kimi", "roles": ["reviewer"] }
  }
}
```

Start them with `ahub codex --as codex-review` and
`ahub kimi --as kimi-review`. Codex keeps its native TUI and its own hub-owned
app-server proxy; extra Kimi, Qwen, Jcode, Pi and local instances use headless starts.

An extra instance of any kind that holds the `implementer` role needs its own
registered worktree on an attached branch, at exactly `.worktrees/<id>`
(`"worktree": ".worktrees/<id>"`). Configuration validation refuses a missing one
only for Claude channel instances and headless writers. For other kinds, Codex and
Jcode included, the hub accepts the declaration at startup and then refuses the start
with `an extra implementer requires an explicit managed worktree`. Create and
register the worktree before the start; the hub never creates it.

Extra Jcode instances are supported (#685), in `.agenthub/config.local.json` only:

```json
{
  "instances": {
    "jcode-claude": { "kind": "jcode", "roles": ["verifier"], "jcode_home": "/Users/you/.agenthub/jcode/claude",
                      "provider": "claude", "model": "claude-sonnet-5-5" },
    "jcode-local":  { "kind": "jcode", "roles": ["verifier"], "jcode_home": "/Users/you/.agenthub/jcode/local",
                      "provider_profile": "onprem" }
  }
}
```

`jcode_home` is required, absolute, and must differ from the base `jcode_home`, from
every other instance's and from any directory inside or around them, however it is
spelled: a symlink, a system alias such as `/tmp` and `/private/tmp`, or a case-only
alias is the same home (the hub refuses the configuration at startup otherwise). At most 8 Jcode instances are accepted per
project. `provider`, `model` and `provider_profile` are optional and passed to Jcode
as `-p`, `--model` and `--provider-profile` exactly as written; any other field is
refused, and these fields are never editable from settings.

You authenticate inside Jcode, never in the hub. Run Jcode's own setup against each
home (provider login, API key, an OpenAI-compatible base URL such as the on-prem
gateway, a provider profile), and initialize that home's MCP store with Jcode's own
client, as for the base peer. The hub never reads, writes, copies or injects a model
credential, a key, a token or a provider URL, and never creates the home. Its only
start preflight is read-only: the home must exist as a directory you own, otherwise
the start is refused and nothing runs. A Jcode sign-in failure appears as the start
or turn error, with bounded text. An instance reports tokens only if Jcode itself
does; until then they show `unknown`, never 0.

Each instance owns its private `jcode serve` and `jcode acp` pair, socket, roster row
and launch record, and acts as its own peer id (for example `jcode-local`), never as
`jcode`. Start it with `ahub jcode --as jcode-local` (headless; an instance has no
TUI) and stop it with `ahub stop jcode-local`: the base Jcode and every other instance
keep running. An extra implementer needs the same managed worktree as every extra
implementer (`worktree: ".worktrees/jcode-local"`). Every instance is a cloud peer
(`trust.onPrem` is false), whatever provider you configured: it never receives PII
work. `ahub status` and the dashboard show the provider, model and profile as
declared, and `ahub doctor` lists the MCP servers each rostered instance's home would
load.

Upgrade note (task 368): the project's `.jcode/mcp.json` entry for Jcode no longer names
`AGENTHUB_PEER_ID`, because the file is shared by every Jcode in the project and Jcode
gives an entry's own env precedence over the process env. Each hub-started Jcode now
supplies its own peer id and a launch id, and the hub admits a hub-tools connection
for Jcode only with the launch id of that peer's current owned launch. After
upgrading, `ahub status` and `ahub doctor` report the Jcode MCP entry as not ready
once (`jcodeMcpReady` is false for the old entry): run `ahub jcode` once and it
rewrites its own entry, or follow the remedy text the start refusal shows. A Jcode you
run yourself in this project outside the hub has no peer id: its hub tools refuse
every call with that reason and never default to `jcode`, and a process that only
sets `AGENTHUB_PEER_ID` without an owned launch is refused by the hub.

An extra Claude instance is one you start yourself: declare it with `roles` (for example
`"claude-review": { "kind": "claude", "roles": ["reviewer"] }`) and run `ahub claude --as claude-review` in a
terminal. It keeps its own `claude-*.claude-review.json` state files. A planner or reviewer instance reads the
project checkout and refuses `worktree`. From #525-1 an `implementer` or `verifier` instance is accepted and
requires its own `worktree` (for example `"claude-impl": { "kind": "claude", "roles": ["implementer"],
"worktree": ".worktrees/claude-impl" }`). `ahub claude --as claude-impl` validates that registered branch worktree and starts Claude there while keeping its canonical hub connection. Its private launch record stores the execution root. The channel reports its own canonical cwd (verified model-free with Claude 2.1.309); the daemon grants owner isolation only when that root, the current launch id, the recorded root and its own worktree validation all agree. Missing, legacy or mismatched evidence still permits a channel attachment, but write-owner routing is refused with `owner admission: declared write owner requires a verified isolated execution root`. Status shows the isolation refusal. A detach, replacement claim or launch-record change invalidates the proof. Facts and permission grants use the verified execution root; an unverified implementer gets no automatic grant. Recovery records retain that execution root, checked against the current declaration, separately from the Orca grouping root. This is same-user launch evidence, not kernel filesystem isolation. A Claude instance holding only planner or reviewer roles still uses the canonical checkout. A headless Claude reviewer retains its reviewer-only declaration. A headless implementer is available with the separate declaration below (#525-4).

A headless Claude implementer (#525-4) is declared separately:

```json
"claude-impl": { "kind": "claude", "roles": ["implementer"], "start_mode": "headless", "worktree": ".worktrees/claude-impl", "permission_mode": "ask" }
```

A headless Claude implementer may name its model (#844): `"model": "claude-sonnet-5-5"` on its declaration passes `--model <value>` on every native turn, resumed ones included. It is one bounded word (letters, digits and `._:/@+-`, up to 128 bytes, no spaces and no leading dash) and is accepted only on a headless implementer, only from the untracked `config.local.json`. A tracked-file declaration is ignored with a reason, and the key is tier 3: the dashboard and a settings session cannot read or change it, only the console or your editor. Unset, the argv is unchanged and Claude uses its own default. `ahub status` shows the model on the instance row as `model source`. Declarations are captured once when the hub daemon starts, so a changed or newly added `model` takes effect after a hub daemon restart (`ahub restart`); restarting only the instance keeps the old model.

Create and register the attached-branch worktree first; the hub never creates it implicitly. `ahub claude --as claude-impl` asks the hub to start the instance and returns. Idle holds no native child. Task deliveries use a persisted UUID per task: first `--session-id`, later `--resume`. Unscoped chat reuses a session only when exactly one task is in progress for the instance; otherwise it is ephemeral. Positive missing-transcript evidence starts fresh with a notice; unknown read evidence retains the id. Reset includes the per-peer session map. A child inbox read refuses a queued batch attributed to another task and leaves it queued for that task's own session.

Both permission modes use native `default`, managed settings/hooks and the instance's strict tools-mode MCP binding. `ask` routes writes and shell calls to the person's approval. `ask-when-needed` may explicitly allow safe project file tools through the facts hook in the execution root. For Bash, #845 also permits proven read-only commands and the closed task command forms below, through a host-owned execution wrapper. Protected configuration, paths outside that worktree and unproven shell commands still ask. There is no `acceptEdits` or `never-ask` bypass. A failed hook decides nothing and may be followed by a valid person allow. Prompt failure, timeout, disconnect and a stale child binding never grant permission. Approvals use the existing console and `approvals.timeout_s`; no answer returns deny. A stop holds uncertain delivery until the owned process group is confirmed gone; a failed cleanup keeps the peer busy.

Under #845, automatic Bash grants require a current public task and the instance's registered worktree. The exact task forms are `scripts/check.sh --changed`, `bun run build`, `bun test <explicit test/*.test.ts paths>`, `git add <named paths>`, `git commit -m <message>`, `git push origin <bound branch>` or `git push -u origin <bound branch>`, and `gh pr view|checks <bound branch>`. `gh pr create` requires `--base <default> --head <bound branch> --title <title>` and exactly one `--body <text>` or `--body-file <relative path>`. Operators, expansion, extra flags, force/refspec/delete pushes, another remote/branch, background execution or a model-supplied cwd ask. Enabled publish/destroy/install/external-write policy classes still ask. Unknown default-branch evidence also asks.

The task's `refs.branch` is authoritative. Otherwise the first eligible task-command request records the current non-default/non-main/master attached branch through `Tasks`, provided no other open task uses it. A host history entry binds the worktree too; restarting preserves it, and a changed branch or root asks rather than rebinding. Each automatic allow contains only the fixed wrapper and one short-lived single-use ticket. The host rechecks the task, child, root, branch and command proof before executing with its fixed environment and absolute executable; native shell cwd/PATH/config variables do not carry over. Unknown, expired, reused or stale tickets run nothing. Read-only and executable code commands (check/test/build) use the existing local-worker Seatbelt profile: writes only in the worktree and own temp, with all project Git metadata read-only, credential/hub-state denial and the configured network policy. These commands ask if macOS sandbox-exec is unavailable. Only closed host Git add/commit/push and gh operations run outside that profile. Push execution pins both source and destination as refs/heads/<bound>:refs/heads/<bound>; configured remote.origin.push/mirror asks. PATH excludes project/worktree directories, gh child Git uses the core hardening config, and body-file uploads use bounded screened snapshots. An older plugin without the wrapper protocol keeps person approval. [The native context receipt](verification/2026-10-26-headless-claude-shell-context.md) records which native legs have actually been observed.

Check/test/build cannot write the project Git common/current directory at all, including objects, HEAD/index, refs/logs, other worktrees and either submodule tree. Closed host add/commit reuse core Git hardening, ask with configured filters/external drivers/textconv, and force signing/automatic maintenance off. A global Git LFS installation does not disable push/gh grants; only add/commit keep person approval so LFS conversions are not silently bypassed. Automatic push still does not run pre-push hooks. Config includes and partial clones refuse privileged Git/gh. Their command/paths/current task/branch are re-proved before execution. The host pins the default branch from the remote at startup, using a bounded isolated-config Git symref probe against the captured GitHub repository. Local origin/HEAD changes cannot redefine it. No credentials are supplied to that probe; unavailable/private-remote evidence or an unsupported Git layout asks. local.bash_network "direct" gives code direct network access. A setsid-detached code child can outlive owned-group cleanup while retaining its sandbox and permitted worktree writes.

Default-branch capture runs only at daemon startup when a Claude implementer is declared. If the first implementer is added through config reload, automatic task-command grants remain unavailable and those commands ask. Restart the daemon with that implementer declared to capture the remote default branch. Reload does not retry a failed startup probe or refresh the captured default branch.

Project Git retains the core policy that clears credential.helper and core.askpass; an HTTPS push needing those helpers may fail, rather than importing credentials or relaxing that policy. Task branch/config proof reads are bounded synchronous reads (1.5 seconds per reader); slow or unknown evidence asks. The existing sandbox profile discovery is also synchronous; moving it to an asynchronous inventory proof with a shared deadline remains a follow-up. The nonce is visible in a permission response, so it proves a bounded grant rather than native-dispatch provenance.

The [native permission receipt](verification/2026-10-23-headless-claude-permissions.md) covers Claude Code 2.1.309, and the [2.1.310 receipt](verification/2026-10-26-claude-implementer-2.1.310.md) repeats it on 2.1.310 (with 2.1.309 as a control), each with a deterministic loopback fixture and no real account/model call. It is not sandbox proof or a runtime receipt gate. The real account/model/person interaction remains a separate live leg.

A headless Claude reviewer is run by the hub instead (task 223): declare
`"claude-review": { "kind": "claude", "roles": ["reviewer"], "start_mode": "headless" }`
and start it with `ahub claude --as claude-review`, which asks the running hub to start it (nothing runs in that terminal); `ahub stop claude-review` stops it. It holds no process while idle; each
review request runs one new `claude -p` session (never resumed) that may only read
the checkout and call `hub_review` and `hub_task_show`, with no user settings,
hooks or plugins. It gets the review facts and a bounded diff of the head, never
the builder's summary or agent chat, and the board records its verdicts as
`reviewContext: fresh`. Review requests go to it first; while it is not started,
the planner reviews and the task's assignment note says `reviewer=planner (fallback)`.
A missing
`peer_instances` feature on an old daemon or upgrade target requires a supporting
version before launching or restoring extras. An older recovery source without it
is refused only while a declared instance is live or unreadable; a source whose
status shows every declared id offline proceeds.

### Fresh reviewer pool (#519)

From 0.12.37 reviews can rotate across fresh headless Claude and Codex reviewers, and from 0.12.38 Kimi reviewers too. Declare reviewer-only instances with explicit headless mode and the Codex or Kimi fresh opt-in in `.agenthub/config.local.json`:

```json
{
  "instances": {
    "claude-review": { "kind": "claude", "roles": ["reviewer"], "start_mode": "headless" },
    "codex-review": { "kind": "codex", "roles": ["reviewer"], "start_mode": "headless", "review_mode": "fresh" },
    "kimi-review": { "kind": "kimi", "roles": ["reviewer"], "start_mode": "headless", "review_mode": "fresh" }
  },
  "review": { "pool": ["claude", "codex", "kimi"], "rerotate": false, "same_family": "fallback" }
}
```

`review.same_family` (#820) is `"fallback"` (the default) or `"never"`. With `"fallback"` a reviewer of the owner's family is chosen only when no other family is eligible, and the board records a same-family fallback. With `"never"` routing never selects one, in the pool and in the legacy path: the planner reviews when it holds the reviewer role, is not the owner, is of another family and is not blocked, otherwise the person does (`reviewer = "user"`, recorded as blocked), including when every reviewer is offline: an approval without review never happens under `"never"`. A manual `ahub task assign <id> <peer> --role reviewer` of a same-family peer is refused with `same family as <owner>; review.same_family is never`. `ahub route explain <id>` names the rule in its trace. Use `"never"` when the workspace review gate needs the reviewer to be a different AI than the implementer; a Jcode running a Claude model is still family `jcode`.

A reviewer has a review scope (#852): `full` (reads the code, runs the affected tests, reads CI) or `code` (reads the code only). The fresh Codex and Kimi reviewers run in a sandbox that cannot run `bun test` or read CI, so they default to `code`; every other reviewer is `full`. A `code` reviewer's review request replaces the check and exact-head CI lines with one: its sandbox cannot run tests or read CI, review the code against the plan, and the merger gates on exact-head CI. Findings are only defects in the reviewed code, docs or tests; a missing check result, CI result, test run or PR/branch identity belongs in `unmet`, never in `findings`. A `code` reviewer's approval and verdicts record `reviewScope: "code"` in the task history. Its `changes_requested` is always recorded and never refused: with at least one structured finding whose disposition is `open` it counts as a rejection as usual; without one it is recorded as evidence-only, which does not count toward `rejections` or escalation, still returns the task to its owner, and sends the conductor one task notice with ids only. The review request therefore asks a `code` reviewer to report every code defect as a structured finding with an id. A person's verdict is never evidence-only. The scope is a fixed property of the definition. To change it for one instance, set `"review_scope": "full"` or `"code"` on that fresh-reviewer instance in the untracked `config.local.json` (a tracked declaration is ignored with a reason; the key is tier 3, so the dashboard and settings sessions cannot read or change it, and a hub daemon restart applies it). `ahub status` shows `review scope` on each reviewer row. A task approved by a `code` reviewer is merged only after exact-head CI is green and no review thread is unresolved, and the merge note names the CI run.

Start them with `ahub claude --as claude-review`, `ahub codex --as codex-review` and `ahub kimi --as kimi-review`; stop with `ahub stop <id>`. For the Claude and Codex reviewers the command asks the running hub to start the reviewer and returns: nothing runs in that terminal, it takes no launch arguments, and `--print-command` or `--dry-run` prints a hub-start note instead of a launch (#720). Fresh Claude and Codex variants share the project checkout; the Kimi variant runs in a clean temporary working directory and reviews only the screened brief and host facts. All fresh variants refuse a custom worktree or permission mode. Codex and Kimi require `review_mode: "fresh"`; without it, an existing headless instance with the reviewer role keeps its native app-server/ACP behavior, worktree and permission options and does not join this pool. Claude retains its task 223 automatic headless-reviewer declaration. The agy reviewer slot remains automatically unavailable (`agy is an implementer peer (#485)`). A failed or unsupported fresh start never downgrades to a native continuing session. Ordinary implementer instances retain their own adapters. The default logical pool order is Claude, Codex, Kimi. Only configured kinds with at least one declared reviewer count as slots, including declared ones that are offline, paused, quota-limited or failing, so availability never renumbers them; configured kinds with no declaration are listed after the walk as `no declared reviewer`. `review.rerotate` defaults to false. Pool selection starts at PR number modulo the number of declared kind slots, or task id when there is no PR, then skips the implementer's family and unavailable candidates. Delta review prefers the preceding eligible independent family in a fresh child. A preceding same-family fallback does not outrank a newly available independent family. `ahub route explain` shows the same pure walk.

Codex requires a verified `codex-cli` (0.146.0, 0.163.0 or 0.164.0) or one the person trusts on this machine, and a passing bounded runtime receipt before its model child starts. 0.146.0 and 0.163.0 passed the [2026-10-22 model-free production admission](verification/2026-10-22-codex-reviewer-isolation.md) and 0.164.0 the [2026-10-24 one](verification/2026-10-24-codex-0164-reviewer-isolation.md). A refusal names the installed and verified versions. Either set `codex_bin` to a verified executable, or run `ahub agents trust codex-review <version>`: trust lifts only the version pin, and every proof below still runs before each child (#691). Each launch approves exactly `hub_review` and `hub_task_show` per tool (`approval_mode = "approve"`), never through a server-wide default: without it Codex 0.164.0 listed the tools but refused the call, so reviews ended with no verdict (#783). A model-free receipt proves the inventory, not that a verdict reaches the hub; a [model-backed 0.164.0 run](verification/2026-10-25-codex-0164-reviewer-tool-call.md) recorded one verdict through that path. The producer checks native binary/config stability, configured MCP inventory with only the two hub tools, effective Apps/plugins/hooks disablement, an explicit empty legacy `notify` command and a named filesystem profile. Apps needs separate feature readback because configured inventory omits runtime connectors. Web search is requested disabled; its effective turn mode is not read back and managed requirements can select Cached (see the verification ceiling). Each launch proves public-read, exact/glob/symlink private-denial, standard host credential denial and write-denial in temporary fixtures. Standard credential and configured tool-home/XDG subtrees are denied independently of project `local.deny`. Its sandboxed shell is filesystem read-only with private paths denied and network configured disabled; it is not Claude's Read/Grep/Glob-only tool whitelist. No credential home is copied.

Kimi requires a compat-admitted Kimi Code on the hub's PATH (receipt-verified 2.2.0, 2.3.0, 2.3.1 and 2.3.2), signed in through its managed OAuth provider, and a passing runtime preparation before each child; an unverified/untrusted version or a failed preparation is unavailable with its reason. The [2.3.0](verification/2026-10-22-kimi-qwen-compat.md), [2.3.1](verification/2026-10-25-kimi-231-reviewer-compat.md) and [2.3.2](verification/2026-10-26-kimi-232-reviewer-compat.md) receipts are model-free and do not verify real login/provider readiness. Each review runs a new `kimi -p` child without Seatbelt, in a private `KIMI_CODE_HOME` with managed-provider-only config, a clean temporary working directory and an empty skills directory. Its agent may call only `hub_review` and `hub_task_show`, through a task-bound loopback MCP session that never carries the hub's control token, and has no native read, file or shell tool: it reviews the screened brief and host facts only. Its `credentials/`, `oauth/` and `device_id` link to the person's native Kimi files, so it shares the native login, refresh lock and the Kimi account's budget; no token is copied. A stop revokes its verdict authority first, then waits briefly while an OAuth refresh holds the lock; a forced stop mid-refresh may require a native re-login. The Kimi backend records no measured token counts here, so its usage stays unknown; the 2.3.0 receipt makes no usage claim. This is a native tool-authority boundary, not filesystem or network isolation.

A dangling or unreadable standard/configured credential root makes the Codex reviewer unavailable with only its path class in the reason (for example `~/.docker` or `$DOCKER_CONFIG`, never an expanded path or contents); repair the root and start the reviewer again.

agy is not a reviewer (person decision, 2026-10-19): it is an optional implementer peer (see [Optional Antigravity peer](#optional-antigravity-agy-peer)), and its retained reviewer slot is outside the default pool and always unavailable with `agy is an implementer peer (#485)`. A manual pool accepts only registered reviewer kinds (Claude, Codex, Kimi, agy), so local/Pi are refused. An explicit pool without declared candidates blocks for person action; an omitted pool retains legacy routing without declarations and falls back to an eligible planner when fresh candidates are exhausted. The exhausted pool walk remains recorded; without an eligible planner, the person reviews. A manual pool may name agy, or a Kimi reviewer whose preparation fails; the reason appears as an unavailable skip, and they never run or count as approval. Do not substitute plan mode for isolation.

A failed start or any child ending without a saved verdict advances to the remaining eligible candidates; no quota meaning is guessed from text. A request that went stale before its child started (a new head, review revision or reviewer) is skipped with one `hub.log` line; a still-current request whose review policy changed moves on as `no_verdict`. Neither marks the reviewer unavailable (#781). A child that ends without a verdict leaves one bounded `hub.log` line: its exit code and the hub tools it called, screened like any refusal, never tool arguments or model text. Its delivery completes only once the re-offer is confirmed; an unconfirmed re-offer stays `needs_review`. A manually named reviewer's no-verdict, and one with no declared pool, goes to the person, never to an agent the person did not choose (task 453). A same-family fallback is a distinct fresh reviewer session. Exhaustion records `blocked: no reviewer can run`; with no explicit pool the eligible planner fallback is retained, while an explicit pool or absent eligible planner leaves person action. It never auto-approves. A per-review isolation preparation failure excludes that peer from later tasks until a verified restart. Its reason names one cause from a closed list (`version`, `binary`, `mcp_inventory`, `plugins_hooks_apps`, `sandbox_proof`, `credential_root`, `timeout`, `unknown`) with a fixed hint, on the peer's `reviewer` line in `ahub status` and in a `hub.log` line, and never a path, native CLI text or token (#722). Only the Codex preparation classifies its failures; other reviewers report `unknown`. Recovery targets must advertise `reviewer_pool` when a pool is explicitly configured or fresh reviewer instances are declared. Verdict history retains `reviewContext` and adds `reviewerFamily` and `reviewerReason` from the host.

Fake-CLI tests and CI cover these host contracts. [Offline isolation evidence](verification/2026-10-19-reviewer-isolation.md) and fake-CLI tests do not prove an account/model review or observed network denial. Native acceptance remains a separate [manual smoke leg](smoke.md#reviewer-pool-native-legs-519-2026-10-19); existing task 223 Claude behavior has no new live proof here. Kimi's authenticated fresh-verdict receipts, and its still-open interactive-TUI coexistence and usage checks, are tracked in [Kimi smoke legs](smoke.md#kimi-reviewer-and-task-bound-mcp-533).

An additional implementer must have an existing registered Git worktree and
attached branch at `.worktrees/<instance-id>`, named explicitly by `worktree` in
its declaration. The hub validates it and does not create it in this phase.
Reviewer instances may share the checkout, or name their own validated worktree.
The execution directory is separate from the canonical hub project. Resolving it
(at an extra-instance start and for a turn undo) makes up to four git calls that
share one 5 s allowance; when it runs out the start refuses with `Git workspace
evidence unavailable`. An Orca
terminal may belong to either that canonical project or the instance's execution
worktree; recovery preserves its exact recorded grouping and live launcher.
Changing or removing the declaration invalidates its saved extra-instance
binding; the recovery screen and `--verbose` receipt still show what was recorded
for it. A roster key left by an undeclared instance (`codex-2`) loads as inert and
`ahub roster remove codex-2` deletes it from `.agenthub/config.local.json`; a key
held only in the shared `config.json` is refused with a request to edit that file.
Any other unknown roster key is still an unsupported peer. Do not infer ownership
from a native-kind label alone.

A routing preference for a kind chooses among its instances using current load
and WIP. A manual instance id remains exact. Reviewers from the same kind share
a family; the board records a same-family fallback when no other eligible family
exists. Native context is per conversation, while quota windows and quota pauses
are shared by kind/account. A quota reset does not lift a manual pause.

Facts and turn snapshots follow the instance's execution checkout. Use a CLI
that supports instances to undo those turns: older readers see their snapshot
fields as unknown and cannot restore them into the main checkout. The supporting
CLI checks the saved workspace against the current declaration again before any
context change or file restoration. Removing the declaration intentionally
blocks that undo until the identity and workspace can be reviewed.

## Release approval and optional tag guard

Run `ahub sdlc authorize-release <version>` from the running daemon's release-candidate checkout in a person's terminal after committed documentation is fresh. The receipt binds commit, package version, remote identity and the docs verdict. Agents and delegated live-test calls cannot authorize. The daemon keeps approval only in memory and logs metadata for audit; restart requires a new approval. The read-only `ahub sdlc release <owner/repo>` report shows its receipt, retaining native-verification blockers.

`ahub init --release-guard` installs a managed Git pre-push guard and release instructions (`--dry-run --json` previews them). It preserves an existing default hook as `pre-push.agent-hub-original` and passes original argv/stdin to it only after approval matches. Unknown or mismatched `v*` tag pushes fail closed, including when the daemon is down. Non-version branch pushes remain independent of the daemon. Custom `core.hooksPath` and linked/hardlinked hook files require manual integration. Re-run init after changing the Bun/package location. The person's `git push --no-verify` remains an explicit bypass; agents are instructed never to use it.

For `gh release create` and `npm publish`, use the exact literal command after `ahub sdlc release-guard --`. This preflight reads evidence and never executes the command. New GitHub tags require an explicit full commit target; alternate-repository, workspace/archive and bulk target forms refuse. GitHub/npm adapter enforcement is deferred to tasks 312/313. This consent record does not certify a tarball, native acceptance or live publication. Detailed limits: [S6 authorization](sdlc.md#person-release-authorization-481-s6).

## Planner release scheduling

Use `ahub sdlc train report <release-id>` for scope readiness and recorded release metrics. The planner creates future release rows, activates one train, and assigns tasks through the release-only hub tools. A due date requests a cut review; it never clears unfinished work. Move missed tasks to the next row with a reason, then use `ahub sdlc train cut <release-id> <revision>` from the person's terminal or `hub_release_cut` as the planner. The cut retains a short host admission lease through freeze and defers on held gate slots or unknown/quota-limited peer windows with a real quota source. Accounts without a quota reader (Kimi included when `kimi_tokens_5h` is zero) report `no quota source`; manual and budget-record pauses still defer. It does not run release preparation or publish anything. Schedule bundle/check/docs work under separate heavy admission and retain the person's native verification, authorization and upgrade window. A hotfix records its enumerated cause and keeps every gate.

The per-release "gates run" record is not built: it needs gate-execution evidence the S6 authorization path would supply, and a cut record is not that evidence. Release interval, approval-to-release lead time and hotfix rate are shown by the release report (#442). Person ruling 2026-10-19 supersedes the earlier S11 upgrade-admission ruling: upgrades use pre-S11 recovery readiness (no busy peers, pending approvals resolved, completion checks settled) and retain the existing operation checks. S11 adds no host-admission, quota or all-idle requirement to upgrade. An active/frozen configured train still requires recovery-target `release_trains` compatibility. Release-cut admission remains unchanged: follow its refusal's applicable exit by stopping or resuming the paused peer, adjusting `ahub budget set`, or using `ahub release drop`. Missing/shadowed `dot` requires the resource controller or a PATH correction for the cut; nested admission requires retrying the cut outside the outer lease.


## Codex cancellation identity notice

If Codex is offline with `statusNotice.code = unidentified-cancellation`, the hub
could not identify a cancelled native turn. Reattach the native session before
further hub delivery. A late completion keeps this hold; verified native
reattachment or TUI detachment clears it. The notice contains fixed guidance, without native ids.

## Roles per SDLC stage (#525)

The design for planner, implementer and reviewer instances per stage is in the spec section "Amendment: roles per SDLC stage (#525)". Slice 525-1 is available: role capability per kind and form, Claude channel instances as implementer or verifier in their own worktree, and `planner` refused on builtin kinds that cannot plan (pi, local and agy): an instance declaring it is refused with `this kind cannot plan`, and a `roles` entry keeps its other roles with the notice `roles.<peer>: ignored roles outside the adapter ceiling`. A configured ACP agent (`adapters`) is different: it may hold `planner` in its `roles` or in a `roles` entry and then plans like any peer, but it can never be pinned with the `planner` setting or chosen as the automatic planner, because it has no host projection (#735). Slices 525-3, 525-4 and 525-5 are available too:

- 525-3: `assign()` walks the planner holders (rotation by task id over every holder, never renumbered by availability; a named planner exact; a recorded planner kept; none for a PII task) and `ahub route explain <id>` prints that walk. Task planner bindings are recorded by 525-2. A peer that accepted or finished a task never reviews it, a named reviewer and the declared reviewer pool included; when no other candidate is left the person reviews.
- 525-4: a headless Claude implementer runs one owned child per turn in its declared worktree, with a separate persisted session per task (`start_mode: "headless"`, permission `ask` or `ask-when-needed`; `never-ask` refused).
- 525-5: terminal Claude implementer instances own write-class tasks once the daemon has verified their execution root.

For a Codex planner, put a declaration such as the following in the untracked `.agenthub/config.local.json`, then restart the daemon. A planner instance holds `planner` and neither `implementer` nor `verifier`; adding `reviewer` does not grant code-write ownership. It uses the project checkout, so `worktree` is refused.

```json
{
  "instances": {
    "codex-plan": { "kind": "codex", "roles": ["planner"], "start_mode": "headless" }
  },
  "planner": ["claude", "codex-plan"]
}
```

Run `ahub codex --as codex-plan` from the person's terminal. The hub opens the app-server proxy without creating a synthetic host thread. Each native `thread/start` or `thread/resume` is requested read-only. The host rechecks the current settled roles when each thread is admitted and before hub injection, so changing a running instance from a continuing reviewer to a planner cannot reuse an unconfirmed writable thread. A live planner transition with a declared writing worktree is refused until the declaration is corrected and the daemon restarted. A reply that does not positively confirm read-only refuses that RPC and closes the unconfirmed link before the hub adopts the thread or delivers work; missing or malformed evidence is not read-only. The attached TUI belongs to the person and can change its native sandbox later: this is an initial thread ceiling, not a claim that the hub confines the person's TUI. A planner can own `plan` work but cannot become the code owner without the implementer role.

A planner-only Claude instance stays a channel instance on the project checkout, with no `worktree` or headless form. Its facts hook gives no automatic grant for mutating file tools or shell, whatever the hub permission mode. The daemon also returns `ask` for those calls in the existing grant reply field, protecting older hooks that do not recognize the added ceiling flag; the person's runtime mode itself is unchanged. A native choice in that person's terminal remains the person's; the builtin `claude` keeps its existing behavior.

Inspect the running holders with `ahub status` and the dashboard's Agents view. Each peer's `roleInfo` includes its running `form`, `capableRoles` and effective `flowRoles`; a planner holder also names its planner source. `form` distinguishes a channel, headless variant, terminal implementer or builtin form. Capability describes the allowed ceiling, not an extra assigned role. Each declared extra shows owner isolation as `isolated` or `not isolated: <reason>`; a planner using the canonical checkout is not an isolated write owner by design. Missing proof never counts as isolation.

Use `ahub task show <id>`, the console Tasks panel and the dashboard task detail to inspect planner, owner and reviewer with their recorded reasons. `ahub task show <id> --json` and `ui_snapshot` carry `planner` and `plannerReason` as additive fields; a legacy null planner stays unbound. Compare the holder walk with `ahub route explain <id>`. Use `ahub task assign <id> <peer> --role planner` from the person's terminal to name another eligible holder without moving owner or reviewer. Planner settings, bindings, independent plan review and the recovery floor are described in "The planner" above; implementer/reviewer setup is in "Additional headless peer instances". The [six-instance person smoke leg](smoke.md#six-role-instances-525-6) remains unverified until it is actually run.

## Daemon responsiveness and launch connects (#719)

Periodic peer-roster and delivery-supervision reads select pending journal metadata/rows, excluding completed payload history. Queue revision reads do not construct a recovery snapshot. Explicit queue/history commands retain terminal history. The pending-state index supports these reads without sorting historical payloads.

Native launcher connections retry transport timeouts/unclean closes with bounded backoff for at most 15 seconds, printing `hub busy, retrying` once. The ordinary control-connect timeout remains 3 seconds. An immediately unreachable listener, authentication refusals, wire mismatch and project/instance mismatch are terminal. Every retry rereads the descriptor and preserves the invocation's delegated-audit instance pin. Usage queries retain their existing catch-up budgets and report `behind` until complete; time slicing never advances beyond the last atomically folded record.

## amem runtime (agent-mem#13 P4)

The hub exact-pins @staix/agent-mem 0.13.0 for recall, curated evidence and local deterministic capture. No runtime call reaches a claude-mem worker; `memory.worker_url` is ignored. The person's `ahub memory import claude-mem` remains explicit and off by default. Existing profile, alias, PII and private-turn fences still apply. `ask --remember` and context checkpoints propose machine-local candidates, never automatic curated evidence. See [memory integration](memory.md#in-process-recall-and-capture-agent-mem13-p4) for changed behavior and bounded-view ceilings.

## Backlog issue identity and notes

The card's effective planner or the person can relink an unstarted backlog card through `hub_backlog_plan`, using `fields: {sdlc: {repo: "owner/repo", issue: 525}}`. The change is one planning revision and clears the old spec acceptance. Stage, reviewed heads, checklists and other lifecycle evidence cannot be supplied through this path; `hub_sdlc_record` still refuses backlog work.

Omit tool `fields`, or use `{}`, to record only the bounded reason as a new revision. The person CLI retains its JSON argument: `ahub backlog plan <id> <revision> '{}' '<reason>'`. Existing planner scope, pins, frozen releases and stale-revision checks still apply. Undo restores identity members without restoring old consent; null members represent an absent previous repo or issue.

The grooming digest no longer calls ordered dependency phases duplicate merely because they share a design issue. It still reports path/symbol overlap, unrelated same-issue cards and references requiring attention. It uses dependency edges only, including bounded public context for approved intermediate phases.

## Inspecting memory symbol anchors

`ahub doctor --stale-anchors [--json]` (#684 phase 3) checks a bounded set of this project's screened symbol anchors through the optional code-facts boundary. Stale means positively absent at the reported head; unavailable or ambiguous evidence stays unknown. Read the coverage/truncation fields before treating the report as complete. This command performs no note mutation or automatic repair.

A task completion note stores actually observed, existing symbol nodes instead of plan guesses. Earlier notes remain connected through the same reset-safe task node. Related-memory retrieval reaches those earlier notes at memory hop two; the graph's literal two-edge view shows the completion note and task node. Unknown observations are labelled and never substituted with the plan. See [canonical symbol anchors](memory.md#canonical-symbol-anchors-684-phase-3) for bounds.

## Code-facts inspection cleanup and lookup coverage

`doctor --stale-anchors` may create transient detached Git worktrees for exact-head analysis. A Ctrl-C or interrupted cleanup can leave a prunable registration. Inspect `git worktree list --porcelain`; remove or prune only an entry confirmed abandoned, through the person's normal Git maintenance. The report performs no automatic prune. Repeated optional cleanup failure is reported as unknown rather than escaping as a second error.

An absence row says "absent from indexed definitions". Imported package APIs/types and unsupported host qualification are not proof of removed source. Names containing `#`, `->` or `:` remain unknown. Existing raw-signature and normalized note associations are queried together without changing stored entries. See [symbol preparation and query compatibility](memory.md#symbol-preparation-and-historical-query-compatibility-684-follow-ups).

## Inspecting memory code neighbours

In the dashboard Memory view (#684 phase 4), select a symbol and enable Code neighbours. Dashed calls are read-time caller/callee evidence at the displayed commit SHA; solid note associations still come from authored metadata. Unknown, lower-bound and truncated coverage are advisory, never a proof of no callers. The accessible edge list carries the same SHA and direction. Toggle off to view the stored graph alone.

`hub_memory_graph` includes the same bounded derived context for symbol starts within its existing 6 KB output budget. Task briefs prioritize attached fails and decisions within `brief_items`; the console related-note count refers to that bounded selection. Code facts remain optional: no index is copied into memory, no graph edges are persisted and no PII task/turn starts a query.

Optional code work runs only while Memory is open and visible. A cold console count reports unknown immediately; it does not prepare code facts. Direct task memory remains available when optional code facts are ineligible, interrupted or unavailable. Review/completion queries pre-empt optional native work after its owned process/tree cleanup. Unknown lookups have a five-second retry floor; topology caches are commit-bound and note bodies are refreshed under current policy. These are advisory coverage bounds, not empty-result proofs.

## Authority by command

### Conductor operations (#812 T2, #535)

The selected project's configured conductor may run the commands below through its ordinary peer identity. Other peers retain the guidance "the person runs it in ahub console or a terminal". A missing or dead descriptor refuses promptly. For a live descriptor the connect and local authorization handshakes each keep a 3-second bound; connection unavailability is not presented as proof that the peer lacks the conductor role. Actual authority refusals are audited as refused, while ordinary operation failures retain their original cause. The daemon checks the authenticated connection, current role and project membership before effects and after asynchronous boundaries. Roster handoffs carry that same authority check through plan admission, owner delivery and each later task; a saved assignment is never rolled back when delivery is interrupted. Effectful operations and operational history reads retain an `agent_cli` admission with the initiating peer; audit failure refuses those operations. Authorization negotiation, `settings_preview` and `queue show` still check current authority but emit no extra admission record or conductor notice. Admission records are not a unique invocation counter.

| Command | Conductor scope |
| --- | --- |
| roster add/remove | Existing roster lifecycle and confirmations; no role or permission-mode grant |
| stop peer | Existing hub-owned peer stop, ownership and recovery guards |
| queue show/resolve/discard | Public queue projection and existing revision/confirmation guards |
| task cancel | Existing hub_task_cancel with the real peer; eligibility follows the task-board policy |
| doctor --orphans --kill | Selected project's positively identified hub-owned process only; no cross-project registrations or unsigned process files. Prints the stopped pids for a person; `--json` prints the hub's reply |
| logs / export | Bounded daemon projections, with unsupported/private records withheld; logs -f ends when authority ends |
| settings set | Only the twelve existing live registry keys listed below |

The exact settings keys are `task_sweep.enabled`, `task_sweep.auto_reassign`, `task_sweep.no_writes_turns`, `task_sweep.interval_s`, `task_sweep.unaccepted_min`, `task_sweep.idle_min`, `task_sweep.review_min`, `task_sweep.ready_min`, `task_sweep.ladder_min`, `snapshots.enabled`, `research.enabled` and `approvals.notify`. New keys receive no authority by prefix. Generic roster setting writes still use the dedicated roster lifecycle. Conductor setting records name the initiating peer, and conductor writes preserve the person's pending undo record. An intervening write can still invalidate that undo through the existing file-digest guard; preserving the record does not bypass that guard. Permission modes, roles, `pet.window`, arbitrary configuration reload and undo remain person commands.

Log history is limited to the last 100 retained lines and export to the last 1000 retained events, each within a 128 KiB read. Truncation is explicit. An incomplete public projection reports one bounded reason on stderr, preserving export JSON on stdout. The complete privacy inventory has no 500-task cutoff and is cached until board or privacy/config revisions change, so log-follow does not rebuild it for every line. Export accepts closed metadata shapes; unknown fields and nested records are withheld rather than copied. Task titles, paths and private delivery bodies are not part of this projection. It does not change the person's ordinary logs/export output.

Orphan cleanup requires a missing selected root, signed process identity and the host-known hub executable/entrypoint and argv. An inaccessible root or unavailable proof remains unknown; there is no offline config-based role grant. The daemon rechecks authority and process ownership before signals. A confirmed self candidate uses the existing lifecycle stop after its reply. A roster write already committed before authority ends is acknowledged as saved, without authorizing further lifecycle work or commands.

### Conductor-bound restart and recovery continuation (#535)

The configured conductor may start a restart with `ahub restart --yes` or an
upgrade with `ahub upgrade --yes --to <exact-version>` only after the source hub
issues a private continuation record for that exact operation. The record is
separate from public recovery JSON and its `delegatedAudits` history. A
source-issued HMAC binds the operation id, initiating peer, project id and
canonical root, source daemon instance, target root and package bytes, plan
fingerprint, current authority policy and privacy evidence. A public operation
entry or audit label alone grants nothing.

The source and target must both advertise `conductor_recovery`, and the target
coordinator must be supported by the installed coordinator. Missing, old,
unknown or mismatched evidence refuses before the operation takes its hold or
starts staging. An upgrade that hands off to a newer coordinator is person-only
unless that coordinator can establish the same supported proof. At every effect
boundary, the host rechecks the same peer's live conductor role and roster
membership, project authority, read-only status and current non-PII/privacy
policy. Offline continuation uses only bounded current actor/privacy checks;
unrelated public board writes do not invalidate it. Changed or unreadable
authority evidence stops the next effect and leaves the operation for the
person.

Pending settings or routing changes must already be accepted by the running hub before conductor recovery. Protected or restart-bound edits that cannot be proved remain a person's restart. The replacement validates the source-issued policy before importing adapters and uses that same startup snapshot.

Captured TUI terminal restoration remains person-only: a delayed native launcher cannot re-prove the conductor at its eventual spawn. Conductor plans containing captured terminal launches refuse before staging or runtime holds; headless restoration uses the target-owned snapshot through a tools connection.


Only the conductor that created the restart or authorized upgrade may run
`recovery resume|abort` for that operation. A different conductor cannot take
over; the person can use the ordinary recovery commands. The detached
`recovery-run` and target launcher are internal continuations bound to the
recorded operation and captured target arguments. They do not grant arbitrary
console CLI commands. The existing `--live-test` path remains separate and does
not create a conductor continuation.

`task unassign` runs as the conductor's own actor and does not route a
replacement or stop native work. An owner unassign suppresses automatic owner
offers until an authorized explicit assignment or reservation clears that
suppression. This behavior has fixture coverage only; it does not establish a
current installed-release or live-account receipt.

## Standalone ciphertext broker (#446 X2)

From the operator's terminal, run `ahub broker serve --port 8788 --state-dir <private-directory>`.
Default bind is 127.0.0.1; default storage is `broker/` under the selected hub state
directory. Ctrl+C or SIGTERM closes the listener and SQLite handle together.
Accepted ciphertext remains across restart. `GET http://127.0.0.1:8788/health`
returns fixed version/status data.

For another machine, configure TLS termination and use
`--public-url wss://relay.example/ --owner <owner-signing-fingerprint>`.
Repeat `--owner` for each approved creator. Public WSS audiences, even on a loopback
listener behind a proxy, require this allowlist. It controls new rooms only;
existing member revocation still uses the owner's signed roster. Omitting the
allowlist is allowed only in the loopback/no-public-audience development mode;
do not expose that open mode through a proxy.
The audience must be a canonical root URL without credentials, query or fragment.
Proxy `/v1/rooms/<room>` as binary WebSocket, preserve Origin and expose WSS only.
A non-loopback bind also needs `--hostname <address>` and an explicit WSS URL.
The command configures no proxy, certificate, firewall or hosting account; live
TLS and two-machine operation need their own operator receipts.

Keep `broker.db` and its directory outside version control. There is one process
per database, enforced by SQLite's kernel lock; a second instance reports busy.
A crash releases that lock. Do not delete the database as lock recovery: owner/
epoch pins protect membership. Empty/corrupt/unsupported state refuses rather than
forgetting pins. Restore a known valid backup or arrange a fresh room lifecycle
explicitly; X3 clients must retain their own owner/epoch/replay state.

The first room connection proves its signed roster's owner identity; later ones
prove current membership. Room create/invite/join/expose and the hub link are X3;
ordinary chat forwarding and local policy are X4. A stored or queue_ack packet is
transport/storage only; application delivery needs the recipient's separate signed
receipt. Queue-full/backpressure refuses new work without evicting accepted data.
See the [protocol and caps](specs/2026-09-19-agent-hub-design.md#encrypted-rooms-x2-blind-broker-446).


### Reclaim one broker room

Stop the broker first, then run
`ahub broker room drop <room> --yes --state-dir <private-directory>` from the
operator's terminal. Online attempts report busy; agent markers and `--live-test`
delegation refuse. The directory/database must already exist. This forgets only
that room's pins, sender floors and pending ciphertext, freeing its slot; it keeps
other rooms and their pins. It is a destructive room reset, not membership
revocation, secure erasure or confirmation that pending messages were delivered.
Clients must retain their own owner/epoch/replay state. Remove an unwanted owner
from the startup allowlist before restarting so it cannot recreate the dropped id.
Never delete the whole database to free one room.

Existing populated state directories must contain only recognized broker files
and already be 0700. Other populated directories, including a checkout, refuse
without chmod. Empty directories may be tightened. Schema v1 migrates to v2 while
preserving signed pins, floors and queued ciphertext. The 4 MiB per-room admission
share prevents one room taking the whole aggregate byte budget; valid older larger
queues stay available but block new admission until drained or expired.


## Outbound room membership (#446 X3)

Run room mutations from the person's terminal, never an agent shell or `--live-test`.
Start a self-hosted broker as described above, then create a room with
`ahub room create team --broker wss://broker.example/`. The owner fingerprint must
be on a public broker's `--owner` allowlist. `room list` prints that fingerprint.
No room joins or exposure are loaded from committed configuration.

Exchange these artifacts privately out of band:

1. Owner: `ahub room invite team`, send the invitation token to the joining person.
2. Joiner: `ahub room join <token> --name team`, send the printed request back.
3. Owner: `ahub room invite team --accept <request>`, send the printed signed roster.
4. Joiner: `ahub room join team --roster <signed-roster>`.

Both consoles print owner and member fingerprints before installing/consuming.
Compare them out of band, then answer the TTY's y/N prompt (default No). A non-TTY
must pass `--confirm <member-fingerprint-prefix>` with 16..64 matching lowercase
hex characters; it does not execute on a missing or mismatched confirmation.
This flag does not delegate to an agent or bypass the `--live-test` refusal. Only the invitation token contains its one-time secret.
The join request/roster contain no private key or invitation secret. Keep tokens
out of shell transcripts, shared logs and source control. A saved pending join can
be retried with the same token/name/label; `room leave team` cancels it if needed.

`room expose team codex` sets the untracked local exposure policy. On a non-owner
it prints a signed exposure request: send it through the same owner `invite --accept`
and joiner `join --roster` round trip. Empty exposure is the default. `room status`
shows ids and closed states. The X4 chat workflow is below.

`room revoke team <fingerprint>` rotates the owner roster, giving no new key to the
removed member. `room leave team` disconnects locally and retains replay/pin state;
ask the owner to revoke membership as well. Hub shutdown closes links but keeps
membership. Never delete rooms.db to repair a pin or sequence failure. Unknown or
corrupt state disables rooms, while local hub work remains available. Real TLS,
proxy forwarding and two-machine smoke remain unverified until the person runs X7.

## Queue backpressure on automatic task offers (#800)

WIP and a peer's waiting messages measure different constraints. Backpressure is
off by default. A person may opt in through untracked local settings:

```sh
ahub settings set tasks.queue_backpressure.max_queued 20
ahub settings set tasks.queue_backpressure.max_oldest_s 600
```

The bounds are 10,000 messages and seven days; zero disables that threshold.
Values strictly above a threshold hold new automatic owner/reviewer offers.
`ahub route explain <task>` uses the actual assignment rule. `ahub status` shows
queued count, oldest age and a fixed hold reason separately from active,
review-wait and reserved WIP. Unknown age is shown as unknown and holds an offer
when the age threshold is on. Existing queued work still drains normally.

After enabling age policy, old or recovered entries can lack host arrival proof;
resaving/restarting does not make them fresh. Drain them or explicitly assign the
particular task as the person/conductor. That override applies only to the named
role, not other automatic choices, and does not waive privacy/independence/runtime
admission. Automatic reserved planner pulls are still guarded.

Queue-origin holds are retried after committed queue/state/policy changes, without
routing work a person explicitly unassigned. Automatic decline/budget reroutes
retain their retry intent across planning updates; a named proposal keeps its
target. A person reservation waits under pressure rather than moving to another
peer. Self-claims enqueue no owner request and skip only that queue guard.
Continuing reviewers remain bound unless their own queue refuses the new offer.
Setting both values to zero returns
to ordinary automatic assignment. This PR changes no live repository setting or
routing template; real-use adoption metrics remain separate from fixture checks.


## Screened room chat (#446 X4)

After joining and confirming fingerprints, expose each receiving native peer with
`ahub room expose team codex`. A non-owner returns the signed exposure request to
the owner and installs the resulting roster as described above. Exposure is empty
by default; this repository enables no room or exposure automatically.

`ahub room status team` lists remote addresses such as `codex@hub-guest`. Send to
one explicitly:

```sh
ahub say @codex@hub-guest "Please inspect the public example"
```

A local exposed agent can use `hub_send` with that exact address. Native peers
can exchange round-trips. X5b below adds the person's durable inbox for replies
to `user@label`. An older X4-only receiver returns signed `failed_safe` with
"person inbox not supported yet (X5)", rather than claiming admission. One remote plus
local recipients is supported. X4 refuses multiple remote recipients before any
delivery: send separately. Ordinary broadcasts stay local. Unknown or ambiguous
addresses refuse. Private turns, PII task references and private envelopes do not
cross; secret/path/pattern/model-screen failures produce an ids-only stub.

Room status and `ahub queue show <delivery-id>` distinguish accepted ciphertext
from **completed (admitted)**, meaning the remote hub saved the chat to its local
peer queue. Native/model execution is independent. Incoming messages remain
untrusted text and grant no local task, role, approval, tool or control authority.

Offline queues are capped at 200 per room. In untracked config.local.json, optional
`rooms.ack_timeout_s` defaults to 600 and `rooms.queue_ttl_h` to 24. A restart,
expired deadline or uncertain publication leaves `needs_review`. It is not
replayed automatically. A late signed receipt is visible as evidence in queue
inspection; the person's disposition is still required. Old text cannot be
retried to a replacement fingerprint reusing a label. An unproved terminal retry
refuses and requires a deliberately authored new message.
An expired or missing original enqueue deadline likewise refuses retry without
recording a successful disposition. Send a new message deliberately instead.

The ACK timeout starts when the application is handed to the room link, even if
the broker never confirms storage. A reconnect or restart requests fresh signed
presence from the other hub without waiting for its peer state to change.
Capacity refusal of one incoming chat retains that pending chat while allowing
later packets and receipts through; a later online or person-disposition event
rechecks admission. Merely reading room status applies no disposition.
Up to eight matching receipt payloads per room have a separate 1,024-byte-per-row
durable reserve so a full chat inbox can still settle outstanding deliveries.
The normal chat cap is unchanged; unrelated receipts cannot use that reserve.
Presence retired at the ordinary cap is re-fetched once after capacity frees,
so that a dropped state update does not leave the remote view stale indefinitely.
Fresh authenticated chat that reaches the full ordinary inbox is refused and
transport-ACKed without admission or a signed receipt. The sender's application
expires to `needs_review`; receipt traffic behind the refused chat continues.

For an incoming uncertain admission, copy its frame id from room status:

```sh
ahub room resolve team --frame FRAME_DIGEST --action accept
ahub room resolve team --frame FRAME_DIGEST --action discard
```

Both forms show the owner/member fingerprints before asking y/N. Non-TTY use
requires `--confirm` with a matching member fingerprint prefix. Accept records
that the person vouches the local peer got it; discard records dropping it.
Neither sends, re-admits, or produces a signed completion. The displayed state is
**disposed (accept|discard, by person)**. These mutations refuse agent shells and
`--live-test`, including after leaving a room.

Application-id and trace metadata retain 30 days/10,000 per room, evicting settled
rows first. Protected uncertainty remains until person disposition. Outside that
retention no historical app-id or trace claim is made; permanent seq floors and
MAX_HOP 3 still apply. Status prioritizes uncertainty and bounds each direction's
rows to 200; queue inspection remains the delivery-history entry point. Broker,
TLS/proxy and real two-machine/account receipts remain separate live proof.

## Room metadata views (#446 X5)

Press `8` in the panel console for Rooms, or open Agents > Rooms in the dashboard.
The views show local room membership, owner/self fingerprints, member count,
link state and exposed remote peer ids/states. They are hidden when an older hub
supplies no room field or no rooms are configured. An unavailable read clears
old metadata and shows an unavailable state. Reading status creates no room
storage or keys.

Relay figures are **since daemon startup**, not lifetime totals: outbound is
successful handoffs, inbound is confirmed local admissions, and withheld is a
subset of outbound handoffs. Unknown values display as unknown, not zero. A
daemon restart resets the counters; neither a handoff nor these totals means a
native agent completed its work.

These views contain no message body/title, reason, broker URL, key material or delivery
history. Use the existing queue inspection workflow for delivery uncertainty.
The metadata-only views never show inbox bodies; use the separate person-only
CLI below.

## Person-only room inbox (#446 X5b)

List metadata for all rooms or one named room:

```sh
ahub room inbox [<name>] [--json]
```

The list contains local inbox ids, room/sender metadata, times, byte counts and
states, never body previews. One operand is always a room name, even `show`,
`done` or `discard`. Only an action plus an exact local UUID acts on a message:

```sh
ahub room inbox show <id>
ahub room inbox done <id>
ahub room inbox discard <id>
```

Only list accepts `--json`; none of these commands accepts `--confirm` or asks
for a fingerprint. All inbox forms refuse agent shells, conductors and
`--live-test`. They also refuse during recovery or a Bus hold. Show prints one
sanitized, terminal-safe untrusted body and does not mark it done. Done/discard
immediately purge the body and keep a metadata stub. Their acknowledgement is
sent before any background room retry. Expiry does the same;
there is no archive or read-after-done command. Capacity released by done/discard
or a real TTL purge wakes already-deferred X4 traffic; no new receipt is sent for
the purged entry, and idle ticks never poll queued plaintext. Dashboard, status, logs, memory,
models and observers never receive the body.

The sender's **completed (inbox)** receipt means durable admission, not that the
person read or completed the request. Reading, disposing or expiring the local
copy never changes that receipt. Inbound session counts increment once at
admission. Older X4 senders cannot parse the new inbox receipt reasons and stay
uncertain; do not treat mixed-version traffic as verified success.

Limits are 100 unread messages per room, 64 KiB decoded body per message and
4 MiB canonical payload bytes retained globally, including JSON overhead and
escaping (the displayed size remains decoded UTF-8 body bytes). The unchanged 64 KiB entire-wire cap
leaves less than 64 KiB for a sendable body. Schema 4 starts the 30-day TTL at the
first durable local crypto arrival, not remote time or restart. Legacy pending
person traffic without that age gets fixed `failed_safe/inbox_age_unavailable`;
native peer traffic is unchanged. Full, oversized or already-expired person
admissions return fixed `inbox_full`, `inbox_oversize` or `inbox_expired` refusals.

Up to 1,000 settled stubs per room remain for 30 days after settlement, oldest
first. Unread messages and their admission identities are protected, along with
unsettled identities at the shared 10,000-per-room application cap. One loaded
daemon expiry hook runs every 30 seconds, including for left rooms; it creates
no empty room database or keys. Bodies remain plaintext in the protected local
store, with no new encryption-at-rest or secure-erasure guarantee.

Lists are complete up to 1,100 rows. If an all-room list exceeds that limit, the
CLI explicitly asks you to choose a room name; it never silently truncates.
ponytail: pagination is later work; a filtered room's 100 unread plus 1,000
settled stubs fit the current response ceiling.
