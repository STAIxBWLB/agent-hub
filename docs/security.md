# Security notes

agent-hub connects agents that can each run commands. This page says what the hub defends, how, and what it does not.

## Trust boundaries

- **Other agents' text is untrusted.** Every message that crosses from one peer to another is framed as untrusted input: a channel tag with `meta.source` for Claude started with `ahub claude`; otherwise a fixed header line (`frame()`, `[agent-hub message from ...]`) with an instruction that says it is untrusted, the plugin's server instructions for a tools-only Claude reading `hub_inbox` and a standing instruction for the others. A message body cannot forge the hub's own headers: such lines are quoted (`sanitize`). Replies inherit a hop count capped at 3, so agents cannot ping-pong forever; neither a digest nor a steer can reset it.
- **The control link is loopback plus a secret.** The daemon and the Codex proxy bind 127.0.0.1 only. The control WebSocket requires a per-run token (`.agenthub/state/control-token`, mode 600), and both servers refuse any request that carries an `Origin` header: any web page can open a WebSocket to localhost, and browsers always send `Origin`. External clients cannot claim the console user's id or a hub-managed peer's id.
- **Permission prompts stay on unless an operator selects a permission mode.** `ask` leaves native decisions unchanged. `ask-when-needed` grants scoped Claude file tools or Pi/local writes and edits; Kimi and Codex use their own native policies. `never-ask` requires explicit runtime confirmation or a person's console `y` for a config default at hub start. Until that config confirmation the peer runs in `ask`. Kimi's and `local`'s permission requests are relayed to the console and cancelled after `approvals.timeout_s` (default 120 s) of silence; the macOS notification for a waiting request carries the peer and the tool name only. The one exception is the hub's own tools (`hub_send` and the task tools, matched by exact name): Kimi's requests for them are approved once without a prompt and logged by name, the same trust Codex gets through `approval_mode` in the hub's config. They invoke hub-owned operations rather than arbitrary file or shell tools, and every call passes the hub's own checks. Identity comes from the exact permission title, or from the earlier tool-call title bound to the same call id and resolved against the configured MCP servers when the permission title contains argument JSON (Qwen). Payload text and unrelated display titles never establish identity. For ACP agents, a payload longer than the console shows is marked as cut and never offers a session-wide grant. Pi's write, edit, shell and git write requests are relayed the same way and can be answered `Always allow <tool> until Pi restarts`: later calls of that tool by the same Pi start skip the prompt but stay inside the path guard and sandbox. The grant covers every later call of that tool whatever its payload, is kept in memory only, cannot be given from the dashboard, and each call it allows is logged by tool name. A Pi or `local` request whose call was cancelled or whose turn ended is withdrawn at once: a later answer is refused and grants nothing, an `Always allow` included. One shell command runs without a hub approval: the `!command` a person types in the managed Pi TUI. It stays inside the same sandbox and denylist, and the hub takes it only from the verified owner process of a Pi in TUI mode, while Pi is idle, on a reservation that is used once; a model's own bash call never takes that path (issue #253). `--unattended` turns prompts off, says so loudly, and is never the default.
- **A committed config cannot choose launch commands, credential files, data endpoints, permission modes or a wider sandbox.** The machine-local fields (`kimi_cmd`, `permission_modes`, `codex_bin`, `pi.cmd`, `checks`, `mlx.bin`, `mlx.runtimeDir`, `mlx.modelPath`, `omniroute.urls`, `omniroute.access_hosts`, the `omniroute` key files, `memory.worker_url`, `local.read_allow`, `local.bash_network`, `local.network_allow`, `terminal.open`) apply only from a config file git confirms nobody committed: `.agenthub/config.json` or `.agenthub/config.local.json`, matched by file identity so no other spelling the file system accepts slips past, and `.agenthub` itself not a committed symlink or submodule. Without a repository, or when git fails, they keep their defaults; an empty value always means the default. "Untracked" is answered by the repository that contains the project: a checkout copied or extracted into an unrelated repository, or into an ignored directory of one, is trusted like your own files. So a cloned repository cannot choose a launch command, a completion check, a gateway to send a key file to, a memory endpoint, a permission mode, the command that opens a terminal, or a wider sandbox. A command in `checks` runs as you, outside the local worker's sandbox, like a git hook. So do the `setup` and `verify` commands of a benchmark suite (issue #251): `ahub bench run <suite.json>` is a person's command, refused from an agent session, and it resets the work tree for each attempt, so it runs only with `bench.enabled`, at the root of a clean repository that tracks nothing under `.agenthub/`. Nothing in `routing.toml` or in task text is ever run. `routing.toml` and the other shared fields still come from the checkout, and they matter: `routing.toml` picks the models the local worker and the hub's inference use at your gateway and can turn the PII constraint off, and roles and budget shape who does what. Review them in a repository you do not trust. The hub's own git calls outside the sandbox (snapshots, facts, config trust, project discovery, memory recall, the bench runner) all use the single hardened implementation in the exact-pinned first-party `@staix/agent-mem/platform` package, re-exported by `src/hub/git.ts`, which disables the programs a repository's configuration can name — the file-system monitor, hooks, external diff, the pager, and the credential and askpass helpers, with prompts failing closed — so a config that ever does get written cannot run code with the hub's rights. Of those, the monitor, hooks and external diff are reachable by commands the hub issues (the planted-program test exercises all three; a `diff --no-index` reads the repo's config, so that call also passes `--no-ext-diff` and `--no-textconv`); the pager is not (every call pipes stdout). Credential and askpass helpers are disabled for project repositories; memory sync alone may use credentials for its own memory repository, without prompts. The cost: `core.fsmonitor=false` also turns off a person's enabled built-in monitor for the hub's own calls, so the per-turn snapshot's `add -A` scans the whole tree (the snapshot has a 10 s cap). git has no global switch for filter drivers, and of the hub's commands only the snapshot's `add`/`restore` would run one (its driver command lives in the protected `.git/config`).
- **Telemetry holds no bodies.** `.agenthub/state/events.jsonl` (issue #40) records envelope ids, routing and sizes, task ids and states, overlapping paths and token counts, and the task id (with a PII flag) that each usage and token record is attributed to. It never records a message body, a task title or detail, and marks private (PII) envelopes and tasks as such. It stays on the machine; `ahub export` only prints it. Two opt-in stores copy numbers from it into your home directory, shared by every project on the machine (directories mode 700, files 600): research records (issue #247, `research.enabled`) in `~/.agenthub/research/` hold per approved task the ids, states, counts, tokens, times and PII flag the events hold, a person's label from a closed list, and a hash in place of the project id; benchmark runs (issue #251) in `~/.agenthub/bench/` hold suite name and hash, arm label, the attached peers' ids, models and permission modes, task ids, outcomes, exit codes, counts, tokens and times, never suite text or a command's output.
- **Snapshots stay in your repository.** Per-turn snapshots (issue #33) are git objects in the project's own object store, written through a temporary index; nothing is referenced, pushed or copied elsewhere, and `git gc` prunes them. They hold what the work tree held, including untracked files that are not ignored, so keep secrets in ignored files. They carry the repository's own permissions, and nothing caps their disk use but `git gc`. A turn of a peer holding an open PII task is not snapshotted; a PII file left in the project is snapshotted by later turns like any other file. `ahub undo` restores only files whose current content is exactly what the turn left.
- **The edit hook reads, never decides.** `ahub check-path --hook` (issue #32) reads hub.db and returns context for Claude and a line for you; it sets no permission decision, so your permission rules stay in charge. It names other owners' task ids, titles and states, which then reach Claude's model; PII tasks are left out.
- **The session record holds identities only.** `.agenthub/state/sessions.json` (issue #37, mode 600) keeps each attached peer's recovery metadata: launch options, session and thread ids, Pi's session file path. No message or task text; loss notices name deliveries by id, sender and public task title.
- **Context checkpoints have a separate text record.** Native occupancy readings carry numeric metadata only. An optional context checkpoint persists its summary in `.agenthub/state/context-checkpoint-<peer>.json` with mode 0600 and attempts shared-memory storage when enabled. Completion requires the outstanding request id, current peer/native session and transport generation; new connection claims invalidate old requests. Private turns, every open PII task associated with the peer as owner or reviewer (including pending review), and PII-pattern summaries are refused before persistence or cloud memory. Its text is never broadcast, and context pressure does not pause, reassign or replace the session.
- **The local worker is boxed in.** Paths are resolved through symlinks and must stay inside the project; a secrets denylist (`.env*`, keys, credential files, the hub's own state and the state archives `ahub reset --all` leaves) applies to its file tools, its git arguments and its memory capture alike; `.git` and `.agenthub` are not writable. Writes, edits, shell commands and mutating git wait for approval unless the operator's permission mode grants them (writes and edits inside the grant filter in `ask-when-needed`, all four in `never-ask`; see below), and the approver sees what will be written or run, with control characters escaped. Everything it executes runs under the macOS sandbox, attended or not. Since 0.10 the profile starts from deny default (issue #39): commands run and read only the system, toolchain and project directories (and the project's git dir and the selected developer dir; with network on, the public CA bundles); no writes outside the project, its git dir and a temp dir of its own (`TMPDIR`, made for each command and removed when it ends; issue #63); no `.git` name at any depth, closing the creation, rename, symlink and gitfile routes to a planted repository, no `config` or `hooks` directly under one nor below the discovered modules root of the project's own `.git` (a submodule's git directory, nested submodules included; every term is anchored below that root, so a directory named `refs`, `config` or `hooks` above the project neither disables the rule nor trips it; a `/refs/` or `/logs/` segment below it keeps refs named `config` or `hooks` writable, and leaves a submodule whose own path contains such a segment uncovered; a submodule whose path has `hooks` as a whole component (`tools/hooks` included) fares worse: the rule matches its whole git directory, so every write there is refused; the discovered git directories, the modules root and every component in between are also refused as targets, closing the rename, replace and symlink routes to the same files), no `commondir` at any depth below one, with every such name matched folded against the code points HFS+ ignores (the fold covers the security-relevant names; on a volume that folds names, folded spellings of the components between `.git` and a submodule's git directory are not matched — the 1024-byte SBPL literal cannot hold a folded path — the same residual the external git dir rules carry since #270), and no `.agenthub` anywhere in the project (in an external git dir the `config`/`hooks` rules cover only its own children and the hooks directory's contents, so refs named `config` or `hooks` still work); a nested repository in bare layout stays open — the directory is the git dir, with no `.git` name to anchor a rule on, and the hub never runs git there, whatever the project root is: its calls are all `-C <project root>` or `--no-index` on temp files, and none descends into a nested directory's git layout, so a planted hook fires only if a person or another tool runs git in that directory themselves; the rules are probed on HFS+, which folds the 16 code points the patterns tolerate, and on a case-sensitive APFS image, which folds nothing (a folded spelling is an inert new file there and the real names stay refused); the cost is that `git init`, `git clone` and `git worktree add` do not run inside the sandbox (add, commit, stash, checkout and gc still do), `git submodule update --init` does not either (its git directory's `config` write is refused), and neither do `git worktree remove`, `git worktree prune` of a stale record, `git clean -ffd` in a project with a nested repository, or `rm -rf` of a directory that holds a `.git` (refusing the unlink is what stops the rename-out route); no network, loopback included, unless `local.bash_network`; with it, only through the hub's egress proxy to the hosts in `local.network_allow` (issue #65), which refuses names that resolve to internal addresses (behind NAT64 with the well-known prefix, by the IPv4 address the answer carries; a network-specific prefix is not recognised), so claude-mem and the Codex app-server stay out of reach (`"direct"` opens everything, until 0.13.0). One channel stays open: `trustd`, which TLS clients need, can fetch a certificate's AIA or OCSP URL on a command's behalf, outside the proxy. The allow-default profile of 0.9 and earlier was removed in 0.12.0 (issue #83); a `local.sandbox` setting is ignored with a note. The shared temp dirs (the user's and `/private/tmp`) are closed. Without the sandbox there is no `bash` tool.
- **Capabilities are enforced, not suggested.** `capabilities` (issue #39) is checked by the daemon where task operations and messages arrive, so a peer cannot get round it by phrasing. A peer can never answer a permission request: the control link takes `permit` from the console role only, and a message that quotes a permit command is just text. Both bind the hub's own tool paths: a vendor agent with its own shell in the project (Codex, Claude, Kimi) can read `.agenthub/state/control-token` and connect as the console, which only the local worker's and Pi's sandbox prevents.
- **PII has an enforced path.** A task matching `signals.pii_patterns` goes to `local` or to nobody; its text is absent from other peers' envelopes, the console stream, the log and the board listing; the console user reviews it; `local` answers such a turn to the console only, keeps it out of its history, refuses it when the only gateway is off campus, and may not save notes or spin off tasks during it. Nothing about it is sent to claude-mem, whose observer is a cloud model.
- **A model screen can add to the patterns (issue #198).** With `signals.pii_screen = "local"` in `routing.toml` (default `off`; it applies while `constraints.pii = "local_only"`), a newly proposed task is read by a model before the hub does anything else with it: until the verdict it is on no board, in no envelope, before no triage model, and the hub makes no brief or note call for it. The local worker's claude-mem capture leaves its hub tool calls out (issue #230), so a proposal it makes in an ordinary turn cannot reach claude-mem ahead of the verdict that way. The screen runs on the model on this machine (MLX or Ollama, loopback only) or, without one, on the gateway only while `onCampus()` holds, and the gateway call is refused once more right before transport if the gateway is behind Access; task text never goes off campus to be screened. When the on-device generation slot is taken (Pi generating, another screen), the screen goes to the campus gateway instead of waiting, and on campus a device that fails or is still loading after 60% of the deadline hands over to the gateway too; off campus it waits for the slot and the device within the deadline. With the legacy MLX provider the screen may start an `mlx_lm.server`, as Pi's relay does, and it stays running until `ahub models stop`. Its answer is `pii` or `clear` plus a category from a closed list (name, student id, phone, address, grade, health, other). Anything else, a timeout (8 s, one call and one generation slot per item), a missing or off-campus model, or text longer than 6000 UTF-8 bytes (about 2000 Hangul syllables) is `unknown`, and an unknown task is a PII task: this is the hub's one model call that fails closed, so with the screener down every new task waits for `local`. An unknown verdict has the costs of any PII task, even when a second look clears it later: opening it lifts every silent turn-free cohort for good and turns facts off while it is open, and off campus a proposal without a class is refused (triage is not asked for a PII task there), with an error that says so. Off campus with the on-device slot taken, a task stays `unknown` until it is screened again: while it is still proposed and no peer ever owned it, the hub's release timer (every 60 s, one task at a time, the least tried first, at most 10 times per task in a hub run; never text too long to read) asks again, and `clear` lifts its `pii` signal and routes it through the class peers (a named owner is not remembered; a reserved one is offered first, as always). A task `local` took keeps its PII path, also once it is declined back to nobody. A pattern match is PII without a call. The task's history records the source of its `pii` signal (`regex`, `screen` with the category, or `unknown` with the reason), an unknown verdict is a console line naming the task id only, and `events.jsonl` gets a `pii_screen` record with the item kind, label, source, category, reason and latency, never the text. A routing explanation of a draft does not call the screen and says so.
- **Free text is screened too.** On an ordinary task, a done summary (with its check output: a match withholds the whole note), a review note, an unmet item or a budget handoff that matches a PII pattern (issue #69) is not saved to claude-mem, and every peer, `local` included, gets a stub naming `ahub task show <id>`; the board keeps the text, `hub.log` notes the withholding by task id only, and `ahub ask` shows such a note only when its model is reached on campus. `hub_remember` refuses a match; what a vendor agent writes to its own memory is not screened. With the model screen on, the same items (and `hub_remember` notes) go through it as well, one call each and only after the call's own checks (owner, state, verdict, a running check, memory enabled) pass: a `pii` or `unknown` verdict withholds the item exactly like a pattern match, and the board marks the history entry (`withheld`) so later views (task lists, completed-change notices, `ahub ask`, a reviewer replaced after a restart) keep withholding it. A budget hand-off is screened once per hand-off, whatever the number of tasks it moves; an escalation's reason is the hub's own text and is not screened. Pattern-only, without the model: the check output tail in a done note (only the summary is screened), a plan given with `hub_task_accept`, a decline reason, a task's refs (paths, branch), and context checkpoint summaries. Not screened at all (an existing gap, not new with the screen): the local worker's claude-mem capture records its file, shell and git tool calls in ordinary turns with their raw arguments and output, and the closing answer of a turn that used tools, without a pattern or model check. Its hub tool calls (`hub_send`, the task tools, the conductor tools) are not captured (issue #230), so a title, detail, done summary, review note or `hub_remember` text it writes reaches claude-mem only through the screened paths above.
- **Secrets stay where they are read.** The gateway key and Cloudflare Access values are read inside the gateway client and go only into request headers: never into logs, errors, envelopes, tool output, memory, or the generated Switchyard config (the key travels by environment variable name). Subscription logins of Claude, Codex and Kimi are never proxied or pooled.
- **The hub's own model calls are fenced.** Digest condensation, task triage and the PII screen read agent-written text as data; their output is capped text framed as untrusted, or a value checked against a closed list. It is never used as a route, a peer id, a tool call or an instruction.

## Native memory authority and profile selection

The portable core is the exact-pinned first-party `@staix/agent-mem` 0.3.0 package; it does not replace the hub's caller identity, PII policy or task-write authority. Deny, hardened git, real paths and process identity are single-sourced in its Node-safe platform entry. Current project privacy is applied by the hub before promotion and again before model-facing reads. Standalone person reads are unscreened, and the standalone `--policy-free` acknowledgement grants no hub or peer authority.

`hub_memory_search`, `hub_memory_show` and `hub_memory_graph` take the project from the daemon, require `memory_read`, refuse private turns and validate UTF-8 input before logs or storage work. Complete records and graph metadata are screened before counts and truncation. Search is at most 20 lines/4 KiB (default 8); show accepts at most 8 ids and returns at most 8 KiB; graph is at most 120 nodes/240 edges/6 KiB (default 60 nodes), with no edge lacking an endpoint. Unknown, ambiguous and withheld ids share one neutral refusal. Arguments and results are excluded from hub-managed capture; this does not govern a vendor's independent transcript or memory hooks.

`hub_memory_correct` requires `memory_correct` and proposes a machine-local candidate after the same project/privacy checks, including revalidation after asynchronous screening. It cannot accept or alter a note. Public review failures with unmet items may also propose candidates through Tasks. Candidates and usage counters stay at `M/candidates.db`, are not synced/imported, and never enter recall, briefs, ask or graph evidence. A person accepts shared-v1 candidates through the package CLI's TTY/policy checks; the accepted result is an ordinary v1 note, while the sidecar remains local. Generation `amem review` remains unsupported and refuses. Citation counters are observation proxies, not evidence that an agent understood or used a note.

The hub binds the selected root/profile at open. Invalid/missing generation metadata refuses native memory without a shared-v1 fallback; the bus and board continue. Explicit checks at hub operation entry and before sidecar writes stop later stale calls, but are not atomic against a selector change during an in-flight core operation. Migration therefore requires quiescing consumers and closing handles before changing selection, then reopening through the supported lifecycle. A public core pre-write hook is the upgrade path for atomic in-flight cutover.

Before migrating any real home, every hub sharing it must first be on 0.12.30 with positive authenticated binding or unbound/quiesced proof from `ahub memory profile-check` in each relevant registry. An unknown or unreadable runtime is not proof of absence, and a matching ready binding still holds a handle that must be closed. Profile-check reports only its named registry inventory. Root paths, selector receipts and malformed-legacy counts are person-local diagnostics, excluded from ordinary peer status and allowed agent CLI reads. Source/fixture checks do not establish native capture, real migration or account/device-sync success.

## What is not defended

- **A malicious local process running as you.** It can read the control token, `hub.db`, the project and your home directory without the hub's help. The token keeps web pages and other users out, not your own processes.
- **An agent you launched without its own safeguards.** The hub frames and routes; it does not sandbox Claude Code, Codex or Kimi. `--unattended` plus untrusted peer text is a risk you opt into.
- **What an approved command does inside the project.** The sandbox bounds where a command can write and what it can read, not whether `rm -rf src` was a good idea. Read what you approve.
- **Network-level proof for PII.** The hub proves at its own boundaries (tests search every output) that PII text does not leave; packet-level verification of your gateway path is an operations check.
- **Other operating systems' sandboxes.** Only macOS seatbelt is implemented.

## Permission modes and the hostile-agent boundary

Permission modes control vendor prompts; the CLI identity gate is an operating
policy, not a security boundary against a hostile agent. Kimi or another agent
whose mode permits unasked shells can clear shell markers, invoke the CLI with
`--yes`, or read the control token and connect as the console to raise any
peer's mode. A role check on the ordinary hub tool or conductor path does not
contain an unrestricted shell running as the same user.

Pi and local retain the hub's sandbox, path guard and denylist in every mode.
Their ask-when-needed write/edit grants also exclude canonical native agent
configuration segments in any case, using the same list as Claude's hook. A changed canonical target after approval
is refused before write/edit effects.
Kimi executes its own tools outside that sandbox; Claude and Codex retain their
vendor boundaries. The never-ask confirmation names this difference. No mode
turns off the sandbox or grants a session-wide allow-always option.

Config defaults apply automatically only up to ask-when-needed. A never-ask
request from an applied untracked config is held as ask until the person
confirms its source file in the console at hub start. Git-tracked mode defaults
are filtered by config trust and never offered for confirmation. This confirmation reduces accidental startup
relaxation; an agent with unrestricted shell/token access can still impersonate
the console. Merged and generated Claude settings live in 0600 state files and
are passed by path, keeping caller settings out of process argv.

Claude ask-when-needed grants only resolving project file targets outside
.agenthub, .git, .claude, .codex, .qwen, .kimi, .kimi-code, .pi, .mcp.json, .agents and .claude.json. Symlink escapes, protected aliases, traversal and
unresolved wildcard targets receive no decision. Names are compared folded (letter case, compatibility forms and
the code points HFS+ ignores; case-insensitive APFS folds case but ignored none in the probe; so a look-alike such
as a long s or a name with a zero-width joiner is the same name), the path is judged inside the project, and
a file with a second hard link receives no decision,
for Claude and for the Pi/local write and edit grants alike. The local worker's and Pi's write guard refuses `.git`
and `.agenthub` by the same folded comparison in every mode, so a new `.GIT/config` cannot be planted for git to run. Native rules then apply;
this is a grant filter, not a filesystem sandbox.

## Agent CLI identity and conductor authority

Inside an agent session, `ahub` identifies the caller from `AGENTHUB_PEER_ID`,
or the native Claude/Codex shell marker when the hub marker is absent. It connects
as that peer in tools mode. Messages and task changes retain that actor;
`say` defaults to status priority and important messages still require the peer's
capability. Conflicting or malformed markers fail closed. There is no `--as-user`.
By default, console operations are refused before connecting, including permission answers
and permission modes, queue resolution, budget overrides, benchmark runs, research
backfill and task labels, stopping a peer (`ahub stop`), lifecycle and recovery
operations, and `ask`.
For live verification explicitly authorized by the user, an agent may invoke
`ahub --live-test [--project <path|id>] <command> [args...]`. The flag delegates
the existing console authority for console-class operations and conductor-class peer starts/holds, including approvals,
settings, roster and lifecycle operations. It does not restrict effects to a
scratch project: the agent must stay within the authorized commands and targets.
Malformed or conflicting caller markers still refuse. The original peer and
closed command label are recorded with outcome `delegated` before execution;
if that audit cannot be written, the command refuses. The current daemon emits
`agent_cli` with `delegated: true` and `refused: false`. Allowed-class commands retain the peer identity and capability checks, including
messages, proposals and reviews. Peer starts, pause and resume may delegate
operational console authority; task assign/escalate under the flag refuse. `--as-user`, person task labels,
person-authored planning/release/memory/goal writes, SDLC record, benchmark run
and the pet composer are refused. No argument text is copied into this audit.
Delegated dashboard restrictions are bound to its server-issued ticket/session:
operational settings/start/stop controls remain, but message, proposal and
workflow-history actions refuse even if the body tries to clear the restriction.
The flag is not stored in settings or exported to native agent children. Ahub's
own daemon launch, console subprocesses, recovery runner, interactive follow-up commands and upgrade coordinator
handover carry it explicitly in argv. Each new top-level invocation needs its
own flag. An older CLI does not support it; use a candidate with this feature
for the continuation too. Staging rejects a target without the pinned
`LIVE_TEST_SUPPORTED` declaration before preparation or commit, including a
previously cached stage. Delegated headless-native restoration uses the ordinary target CLI with its
operationId through that operational console authority. Native and TUI
restoration keep their existing identity and ownership checks. External computer-use restrictions remain unchanged.
The operator uses a plain terminal or `ahub console`. A Claude `!` command that
inherits the agent markers follows the same rule. The console strips control
sequences from agent and daemon text before it quotes forged headers, and its
colors come only from a fixed palette applied afterwards, so message text cannot
set styles or operate the terminal.

This is an honest default against accidental impersonation and injected commands.
It does not make the token inaccessible to an agent with unrestricted project
shell access. The existing OS sandbox and loopback authentication boundaries apply.

Steering tools require an explicit `conductor` role, independent of default-allow
capabilities. Only one peer may hold that role. Two task-scoped exceptions need
no role: a task's current owner and reviewer may read its public view with
`hub_task_show`, and the peer that proposed a task may redirect it with
`hub_task_assign` while it is proposed, nobody ever accepted it and its latest
move other than the hub's own was not made from the console (to another peer
only with `assign` when its capabilities are listed).
A conductor may inspect public state, assign or escalate work, start a peer in
the start mode a person set (it cannot choose the mode) and place its own
delivery holds. It cannot answer approvals,
resolve durable deliveries, override budget pauses, release a human hold or stop
a peer: `peer_stop` is taken from the console role only, and no hub tool sends it.
Pending approval summaries exclude titles; PII tasks remain public stubs.
Conduct events contain ids only. Supervision feeds use structured reasons and
never carry check output or approval bodies.

## Reporting

Please report vulnerabilities privately through GitHub's "Report a vulnerability" on this repository rather than in a public issue.

## Local dashboard sessions (issue #6)

- `ahub ui` uses the authenticated console control connection to start an ephemeral HTTP listener on `127.0.0.1`. No UI listener exists before that command. The control and Codex proxy ports continue to refuse every `Origin` header.
- The daemon issues a cryptographically random, single-use bootstrap ticket valid for 60 seconds. The CLI opens the dashboard with that ticket in the URL fragment, never a query string or the control token. The static page removes the fragment immediately and exchanges it with a same-origin POST. Tickets are consumed once; expired tickets cannot create sessions.
- The exchange creates a separate random session, valid for one hour without renewal, in an `HttpOnly; SameSite=Strict; Path=/` cookie named for this listener's port. Sessions and tickets live only in memory and die with the daemon. The page itself keeps one more cookie, `agent-hub-theme` (issue #246): script-set, `SameSite=Strict`, kept for a year for the whole `127.0.0.1` host, and read back only as one of `system`, `light` or `dark`. A second script-set cookie, `agent-hub-office` (issue #264), keeps the Office view choice under the same attributes and is read back only as `off`, `flat` or `isometric`. The #391 view split adds two more script-set cookies under the same attributes: `agent-hub-view`, read back only as one of the seven view names, and `agent-hub-column-focus`, read back only as one of the five board columns or empty. HTTP is loopback-only; the cookie is not a substitute for the origin checks.
- Every request must have the exact listener Host. Every data or action request, including the ticket exchange and snapshot polling, must be POST with the exact listener Origin and JSON content type. Foreign and missing origins, missing or expired sessions, oversized bodies and unknown actions are rejected. There is no CORS support. The only unauthenticated GET is the fixed, data-free HTML shell. No files or paths are served dynamically.
- Responses are non-cacheable, cannot be framed, suppress referrers, and use a content security policy restricting scripts/styles to the shipped inline content and connections to this origin. Browser text is rendered with textContent, never interpreted as HTML.
- The browser receives a bounded redacted event stream, peer states and queue counts, public task views, budget windows, pending approvals, the settings rows (closed values and ids, the file each comes from) and each startable peer's start plan (issue #269), benchmark run summaries (issue #251): the newest runs in `~/.agenthub/bench/`, whichever project on this machine ran them, by suite name, arm label, state, the task id in progress, counts, tokens and times, never suite text, and the office view's optional fields (issue #264): each peer's open turn (start time, attributed task id, attribution kind), a `checking` flag on tasks whose check is running, and warning `links` of overlapping, conflicting or cohort tasks (task and peer ids only, never paths, symbols or reasons; a PII task never joins a link, and a private or PII-attributed turn exposes no task id). Private envelope bodies and PII task text never cross this endpoint. Local-worker and Pi approval titles can contain PII, so their details remain terminal-only; the dashboard identifies the request and directs the operator to `ahub tail` before allowing it. Budget checkpoint summaries are also omitted.
- The closed action list includes permission response, peer pause/resume, console message, task proposal/assignment and the settings actions below (set, undo, preview). Project-board actions add revision-fenced planning, Backlog pull/return/split/undo and release planning/state changes through Tasks; they do not tag, publish or write GitHub state. These use the existing daemon/task paths and budget pause rules. `start_peer` (issue #269) starts a peer from a closed list in the mode a person set, with a command the hub assembles: the request carries a peer id and nothing else. There is no generic control proxy, task-detail read, shell, file access, free-form configuration edit, budget override, launch of a caller-chosen command or daemon shutdown API.
- The listener stops with the daemon. Expired sessions must be reopened with `ahub ui`; the page does not silently obtain new credentials.

## Dashboard settings and the settings session (issue #269)

- Settings are a closed registry (`src/hub/settings.ts`). The dashboard and `ahub settings` can write only its keys, each checked against its own closed values, and only to `.agenthub/config.local.json` and `.agenthub/routing.local.toml`. A file git tracks is never written, so the shared `config.json` and `routing.toml` stay byte-identical; in a repository where git cannot answer, nothing is written either. Commands and binaries (`kimi_cmd`, `codex_bin`, `pi.cmd`, `checks`, `mlx`), credential files and gateway URLs (`omniroute`, `memory.worker_url`), the local worker's reach (`local.read_allow`, `local.bash_network`, `local.network_allow`), `bench.enabled` and `terminal` are refused by name from every surface: they choose what the hub runs or where secrets and task text go.
- `routing.local.toml` holds `stay_switch` and, per class, `peers`, `escalate_to`, `route` (an id `routing.toml` defines) and `pi_backend`, and nothing else: targets, routes, signals and the PII constraint cannot be set through it. A write is read by the hub's own loader before it replaces the file (temp file and rename), and one previous version is kept for undo.
- An ordinary dashboard session (`ahub ui`) reads settings, lowers a mode to `ask`, turns `pi.auto_start` off and changes the safe switches (`research.enabled`, `approvals.notify`, `snapshots.enabled`, `coordination`). Whatever can widen what agents do without asking needs a settings session: a non-ask mode now or at hub start, routing, starting Pi with the hub, removing a machine-local value, and undo. `ahub ui --settings` opens one: its ticket marks the session for 15 minutes, after which it is an ordinary session. `never-ask` also needs the peer's id typed as the confirmation, and a stored never-ask default still waits for the console's `y` at each hub start. An undo never puts never-ask back, and removing a machine-local value that uncovers a never-ask in the shared file needs the same confirmation. "Lowering to `ask`" means handing the decision back to the agent's own rules: for Codex that is the approval policy the person configured natively, which the hub does not judge.
- A settings session is as strong as the console for these settings and no stronger elsewhere. A mode change is the console's own request with the same refusals; tool approvals stay deny-only for Pi and local; there is still no shell, file, task-detail or launch-command API. `ahub ui --settings` and `ahub settings` pass the same identity gate as `ahub permission`, which is an operating policy, not authentication. The hostile-agent boundary above applies unchanged: an agent with an unrestricted shell as the same user can impersonate the console, and so can open a settings session.
- Every change writes a `settings` event (the key, the value before and after, the source `dashboard` or `terminal`) and a line in `hub.log` and open consoles; opening a settings session is logged too. The unified dashboard (`ahub ui --all`) forwards settings actions as an ordinary session and opens no settings session.
- Start modes. A start the hub makes itself (the dashboard's Start control, `peer_start` from a console child, the conductor's `hub_peer_start`, `pi.auto_start`) takes the peer's start mode. Through settings only a settings session or the terminal can set it to headless; a config file can also set `peers.<id>.start_mode`, the shared one included (it is not a machine-local field: headless was the only form for Pi, Kimi and the local worker before this change, a hub-made headless Codex start is the app-server the hub already ran for it, and a start mode grants nothing a permission mode or a capability controls). For a TUI the hub opens a terminal running `<runtime> <its own entry point> --project <this project> <peer>` (and `--mode tui` for Pi): every word is the hub's own, the command line is those words each quoted for a POSIX shell, and no request field, tool argument or agent message is part of it. In a `terminal.open` template `{command}` is that quoted line and `{title}` and `{cwd}` are raw text for argv elements of their own; each placeholder is substituted once, so a project path that itself contains a placeholder, a quote or `$` stays one word. A provider's own error text goes to `hub.log`, not to the caller. The terminal comes from `terminal.open`, a machine-local command template that config trust refuses from a committed file and that no settings surface can write, or from Orca. The opened terminal's environment carries no agent marker, so `ahub` there has the console's identity. Without a provider the start is refused with the command to run by hand; it is never downgraded to headless. A conductor can start a peer but cannot choose its mode.

## Multi-project manager (protocol 7)

The manager has its own loopback session server and authenticated local control
endpoint. Browsers provide registered project IDs and expected daemon instance
IDs; they cannot submit arbitrary paths, ports, PIDs or control tokens. The
manager forwards the same closed, redacted dashboard operations as a project-local
page. It cannot expose private task history or allow local-worker tools.

Per-project control handshakes verify project, root and instance against the
runtime manifest. Shutdown removes only the owning instance's runtime files and
waits for owned child processes. Registry and manager startup claims serialize
concurrent starts; uncertain ownership is reported, not forcibly reclaimed.
A stale browser action against a restarted daemon is rejected, and mutations are
never automatically replayed after a connection failure.

The manager can start registered hubs in attended mode. Its project launches do
not inherit state, unattended or gateway URL/key overrides from the session that
opened the manager. Native memory is deliberately not a project-isolation boundary:
its existing basename/worktree aliases and provider accounts can remain shared.

## Peer roster authority

The running peer roster changes only through console-only settings requests.
`ahub roster` is a person's CLI command, including its read form; no hub tool
exposes the catalog or edits membership. An ordinary dashboard can remove a peer,
but adding requires the existing settings-session authority. Removing the
conductor holder is refused. Local and Pi scoped tools cannot write `.agenthub`.
Claude, Codex and Kimi still follow their own file permissions and can edit a
config file; such an edit changes participation only at the next hub start. A
live settings write or undo applies its own roster key and does not adopt other
file edits. External ids outside the known native catalog keep their prior
admission rules.

Kimi's pull-only TUI owns its tool approvals and session. The person's launcher
merges/removes only the hub MCP entry; the daemon never edits that file and
refuses headless starts while a stale entry exists. An attached Kimi TUI blocks
controlled recovery instead of being treated as a hub-owned headless process.
Scoped Pi and local-worker write/edit grants check both the original project-relative
path and its resolved target for protected agent configuration names. A protected
directory symlinked to an ordinary project directory still asks a person; an alias
into a protected directory also asks. Effects use the guarded real path and recheck
it after approval. Explicit approval and never-ask retain their existing meaning
(#322). ACP permissions arriving offline are cancelled before any auto-approval or
console request; pending permissions are withdrawn on watchdog, offline or stop,
and a late person answer cannot grant them (#311).

The shared scoped-grant exclusion also covers `.agents` skills and `.claude.json`.
The latter is conservatively protected by name; its default documented location
is in the home directory, not a project loader. The source inventory and limits
are in [the configuration inventory](verification/2026-10-11-agent-config-inventory.md).
Instruction files `AGENTS.md`, `CLAUDE.md` and `QWEN.md` remain grantable by default.
A person can set `scoped_grants.protect_instructions` to true to require approval
for scoped writes and edits through original or resolved spellings. It applies
live after a settings write or undo, never changes reads or never-ask, and cannot
be set through an agent, tools or conductor surface. Claude's daemon response
withholds the scoped mode on these writes so an older hook grants nothing too.

Qwen Code's optional production ACP peer requires qwen-code 0.25.0 native identity
and advertised mode ids before setting a policy or starting work. Its own tools
have no hub sandbox; auto-edit approves file edits, yolo every tool. Configured
never-ask still requires the person's confirmation. qwen_cmd is machine-local and
never editable through settings. Legacy benchmark adapters remain unmanaged by
this production table. Startup diagnostics withhold native host/payload details.

Jcode is optional, source/version-fenced and runs native tools without a hub sandbox or hub permission-mode mapping. .jcode joins the scoped-grant exclusion, including lexical/resolved aliases. Only a person writes its unique project MCP entry; foreign/override/symlink entries refuse. The hub owns a private daemon/socket and ACP group, never the global daemon, and copies no credentials. Native diagnostics withhold payloads/hosts. Unproved conversation loads refuse; no fresh replacement is called a restore.

# Transient ACP activity (#286)

- Watch activity can contain file contents, thoughts and command output. It is console-role only, kept in a bounded in-memory ring and exposed only through the `watch` control request. Agent shells, conductor tools, dashboard snapshots, hub tools and memory observers cannot read it. Terminal bodies pass through the console's sanitization and wrapping helpers. Slow sockets close instead of accumulating unbounded output.
- Private/PII turns show a single stub; the adapter latches privacy for that turn. The existing final-answer bus and native approval paths (console and dashboard) remain independent, with their existing privacy rules. Watch never adds activity to either path or any disk log.
- There is no Qwen dual-output input file or TUI transport in this slice; Q2-Q6 are unverified and TUI mode stays refused.

## Global attention metadata (#280, phase 3)

The optional status `needs` projection contains act/watch counts, a known state
and the first item (kind, level, peer/id and numeric times only). Status JSON has
no console-local unread-message count and no full item list. The console-role
reply to the existing status request additionally supplies `attentionItems`,
using the same body-free allowlist so stream navigation needs no board-text read.
Peer/tools status callers do not receive that full list. The summary and item
projection never reads task title/detail, approval title/options, pause reason,
error text or paths, and is never forwarded to memory. PROTOCOL remains 16 and
EVENTS_SCHEMA remains 1; clients that ignore optional fields remain compatible.

The file-reading pet command verifies the recorded process identity through the
shared liveness contract and treats missing/unconfirmed evidence as unavailable.
Recovery uses the existing lock/runner read path; unknown is never absent and
navigation grants no permission or mutation authority. Built-in characters and the dashboard projection use the same structural
privacy boundary described below.

Built-in text-frame characters are literal data, not user files or runtime image
loads. Presentation config admits only known ids/sizes/glyph modes, never paths
or arbitrary glyph bodies. Character cycling emits no workflow effects. Larger
frames carry only structural need ids/counts and exclude source/notice prose;
private task and approval details remain in their existing operator views.

The optional dashboard attention input contains only structural task ids, states,
owner/reviewer ids, approval ids and numeric times, peer delivery states and
budget pause times. It is assembled from the same allowlisted input as status;
task text, plans, approval prose, error text and paths are excluded. This input
is supplied only inside console-authorized dashboard snapshots, never ordinary
status replies or status.json. The #391 dashboard projects this input into nav
and tab-title counts; the in-page pet and its character/pixel injection are gone.
Attention navigation switches a local view and focuses an exact visible row id,
with structural guidance when missing. It cannot grant permissions or invoke a
mutation. Compact-card detail/dialog controls retain the existing authenticated
workflow actions and project/instance fencing. Existing CSP hashing, headers,
origin and session authorization remain in force; data uses text/DOM nodes,
without HTML insertion, inline handlers or external assets.


## Hub-owned structured memory (#258)

With a project config, native hub memory is enabled unless `memory.native` is
false. Append-only segments and their derived index stay in the private hub-home
memory directory, created with 0700 directory permissions. New note segments request mode 0600, and `index.db` receives a best-effort
0600 chmod. Existing file modes and SQLite-created WAL/shared-memory sidecar
modes are not a per-file guarantee; the store protects access through its
explicitly chmodded 0700 parent directory.
PII-task notes, PII-pattern notes and secret-looking text are refused before
persistence; promotions are
screened again. The index can be rebuilt from segments and does not replace the
separate claude-mem worker database.

Sync starts only after a person configures a remote. Public GitHub remotes are
refused; unknown visibility proceeds with a warning for the configured remote.
Short-term segments, machine identity and the derived index are excluded from
sync. Suggested graph edges are off by default and are not evidence until a
person confirms them. Operational details and limits: [hub memory](memory.md).

## Standalone pet window (#391)

The macOS window reads local files only. Its detached host reuses `readPet`,
including signed-daemon liveness and recovery-lock handling, and publishes an
atomic counts-only `pet-view.json` (state, act/watch, known character, blink,
palette from the closed list, built-in pixel frame). It excludes item ids,
task titles/text, refs, paths,
notices and approval prose. Missing or unconfirmed status produces only
`{offline:true}`. Process and position files are separate from this view.

The local WKWebView has a deny-by-default CSP, with only its shipped inline
script/style allowed and network connections forbidden. Text never becomes
HTML or executable source. The retained JXA bridge accepts fixed drag/send/
palette/open/close operations; `NSTask` invokes the host-supplied Bun/CLI/project argv
and appends `say`, `--` and a single message argument, or `pet`, `--palette`
and one closed palette name. It does not evaluate a
shell string. Message text is never logged by the window/host; command stdout
and stderr go to the null device. `ahub say` keeps its existing console-message
authority and recording behavior, and `ahub ui` opens its existing session.
The CLI restricts `pet --window` (including close) to console identity, while
plain terminal pet reads and `pet --palette` remain available to agent shells;
the palette write merges only the closed name into `.agenthub/config.local.json`,
validated and replaced by temp file and rename. Signed pidfiles
fence instance ownership and close; unknown owners are never signalled.

## Bounded task specs and isolated checks (#418)

`hub_task_spec` reads only the GitHub issues named by a current owner's or reviewer's task in this project's origin repository, including the validated canonical GitHub intake source when its title/body has no issue token. The daemon resolves authenticated and container executables outside the project, pins their absolute paths and uses fixed arguments; repository-writable PATH shims are refused. Runner Git resolves its host executable through a restricted PATH. For specs, the model receives no credential or arbitrary authenticated URL capability. Foreign/transferred issues, more than three references, bodies over 64 KiB and aggregate results over 80 KiB fail explicitly. Spec fetches share a 25-second budget inside the control client's 30-second cap; each gh call remains bounded to 15 seconds. Current PII, secret and private-path policy withholds the complete spec rather than returning a partial contract. PII turns and PII tasks refuse these tools. The independent `spec_read` and `check_run` capabilities apply when a peer has a narrowed capability list. Arguments and results are excluded from capture.

`hub_check_start` accepts only a current owner's in-progress task, its recorded branch/commit and either `typecheck` or one to 32 existing `test/*.test.ts` paths. `checks.runner = "container"` is a person opt-in in an untracked config file; a tracked config cannot grant it. Missing service/image, an unverified internal network, stale task/owner/native generation, unavailable dependencies or an invalid path fails closed. There is no host-shell, network or Seatbelt fallback.

The runner uses Apple `container`, pinned Bun 1.4.2 and a verified `hostOnly` internal network with DNS disabled, two CPUs and 4 GiB. It starts a named, labeled VM with a bounded idle process, copies a hub-owned snapshot into the running VM, then invokes a fixed `container exec` check. This run/copy/exec sequence is required because Apple `container copy` rejects a stopped container. No host directory, home, credential directory, hub state or socket is mounted. Source blobs are read from the exact Git commit; symlinks and gitlinks anywhere in the source refuse the run before exclusions. Denied and PII paths are excluded and counted. Dependency files require an equal lockfile, bounded regular files/directories and internal relative symlinks. No dependency installation or Internet access occurs in the VM.

Dependency copies detect observed inode, size and timestamp changes and refuse final-component symlinks using `O_NOFOLLOW`. A same-user writer can still exchange and restore a parent directory between observations; this is not an atomic immutable-dependency guarantee. Source commits remain immutable. Do not treat a dependency copy as protection against a hostile process running as the same host user.

Checks serialize through the repository's existing `ahub-heavy.lock`, with one active and at most two queued runs, a ten-minute execution ceiling and a bounded heavy-slot wait. Queued cancellation settles its receipt and releases queue capacity immediately; active cancellation, timeout and shutdown stop only the named check container. Cleanup is confirmed through inventory before releasing the heavy slot; unknown cleanup keeps the slot and reports an error. Startup removes only this project's labeled containers whose signed recorded hub owner is confirmed gone. Unknown owners are reported for the person, never killed.

Only an unchanged task/owner/native-generation binding receives an agent result. Stale receipts are person-only. Public receipts include the exact source/tree/lockfile, runner/platform, command, exit and bounded output; they omit internal host paths, owner process identity and generation binding. The output tail is screened again before any tool response or hub envelope. Local full output is bounded to 1 MiB and removed on result consumption, after 24 hours or beyond the newest 20 outputs; at most 200 receipts remain. Linux VM evidence is separate from macOS Seatbelt and managed-native acceptance.

Routing receives capability availability and its reason as pure inputs. Implement/test/bulk-edit work requires tests, and local-issue-backed work requires spec access. Explicit nominations and reservations cannot bypass these checks. Inactive sandboxed peers may establish their cached GitHub probe at first start/use; host-provided embeddings can inject bounded probe implementations without implicitly contacting real accounts in fixtures. Neither path grants a model control over the probes.
