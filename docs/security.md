# Security notes

agent-hub connects agents that can each run commands. This page says what the hub defends, how, and what it does not.

## Trust boundaries

- **Other agents' text is untrusted.** Every message that crosses from one peer to another is framed as untrusted input: a channel tag with `meta.source` for Claude started with `ahub claude`; otherwise a fixed header line (`frame()`, `[agent-hub message from ...]`) with an instruction that says it is untrusted, the plugin's server instructions for a tools-only Claude reading `hub_inbox` and a standing instruction for the others. A message body cannot forge the hub's own headers: such lines are quoted (`sanitize`). Replies inherit a hop count capped at 3, so agents cannot ping-pong forever; neither a digest nor a steer can reset it.
- **The control link is loopback plus a secret.** The daemon and the Codex proxy bind 127.0.0.1 only. The control WebSocket requires a per-run token (`.agenthub/state/control-token`, mode 600), and both servers refuse any request that carries an `Origin` header: any web page can open a WebSocket to localhost, and browsers always send `Origin`. External clients cannot claim the console user's id or a hub-managed peer's id.
- **Permission prompts stay on unless an operator selects a permission mode.** `ask` leaves native decisions unchanged. `ask-when-needed` grants scoped Claude file tools or Pi/local writes and edits; Kimi and Codex use their own native policies. `never-ask` requires explicit runtime confirmation or a person's console `y` for a config default at hub start. Until that config confirmation the peer runs in `ask`. Kimi's and `local`'s permission requests are relayed to the console and cancelled after `approvals.timeout_s` (default 120 s) of silence; the macOS notification for a waiting request carries the peer and the tool name only. The one exception is the hub's own tools (`hub_send` and the task tools, matched by exact name): Kimi's requests for them are approved once without a prompt and logged by name, the same trust Codex gets through `approval_mode` in the hub's config. They invoke hub-owned operations rather than arbitrary file or shell tools, and every call passes the hub's own checks. Identity comes from the exact permission title, or from the earlier tool-call title bound to the same call id and resolved against the configured MCP servers when the permission title contains argument JSON (Qwen). Payload text and unrelated display titles never establish identity. For ACP agents, a payload longer than the console shows is marked as cut and never offers a session-wide grant. Pi's write, edit, shell and git write requests are relayed the same way and can be answered `Always allow <tool> until Pi restarts`: later calls of that tool by the same Pi start skip the prompt but stay inside the path guard and sandbox. The grant covers every later call of that tool whatever its payload, is kept in memory only, cannot be given from the dashboard, and each call it allows is logged by tool name. `--unattended` turns prompts off, says so loudly, and is never the default.
- **A committed config cannot choose launch commands, credential files, data endpoints, permission modes or a wider sandbox.** The machine-local fields (`kimi_cmd`, `permission_modes`, `codex_bin`, `pi.cmd`, `checks`, `mlx.bin`, `mlx.runtimeDir`, `mlx.modelPath`, `omniroute.urls`, `omniroute.access_hosts`, the `omniroute` key files, `memory.worker_url`, `local.read_allow`, `local.bash_network`, `local.network_allow`) apply only from a config file git confirms nobody committed: `.agenthub/config.json` or `.agenthub/config.local.json`, matched by file identity so no other spelling the file system accepts slips past, and `.agenthub` itself not a committed symlink or submodule. Without a repository, or when git fails, they keep their defaults; an empty value always means the default. "Untracked" is answered by the repository that contains the project: a checkout copied or extracted into an unrelated repository, or into an ignored directory of one, is trusted like your own files. So a cloned repository cannot choose a launch command, a completion check, a gateway to send a key file to, a memory endpoint, a permission mode, or a wider sandbox. A command in `checks` runs as you, outside the local worker's sandbox, like a git hook. So do the `setup` and `verify` commands of a benchmark suite (issue #251): `ahub bench run <suite.json>` is a person's command, refused from an agent session, and it resets the work tree for each attempt, so it runs only with `bench.enabled`, at the root of a clean repository that tracks nothing under `.agenthub/`. Nothing in `routing.toml` or in task text is ever run. `routing.toml` and the other shared fields still come from the checkout, and they matter: `routing.toml` picks the models the local worker and the hub's inference use at your gateway and can turn the PII constraint off, and roles and budget shape who does what. Review them in a repository you do not trust.
- **Telemetry holds no bodies.** `.agenthub/state/events.jsonl` (issue #40) records envelope ids, routing and sizes, task ids and states, overlapping paths and token counts, and the task id (with a PII flag) that each usage and token record is attributed to. It never records a message body, a task title or detail, and marks private (PII) envelopes and tasks as such. It stays on the machine; `ahub export` only prints it. Two opt-in stores copy numbers from it into your home directory, shared by every project on the machine (directories mode 700, files 600): research records (issue #247, `research.enabled`) in `~/.agenthub/research/` hold per approved task the ids, states, counts, tokens, times and PII flag the events hold, a person's label from a closed list, and a hash in place of the project id; benchmark runs (issue #251) in `~/.agenthub/bench/` hold suite name and hash, arm label, the attached peers' ids, models and permission modes, task ids, outcomes, exit codes, counts, tokens and times, never suite text or a command's output.
- **Snapshots stay in your repository.** Per-turn snapshots (issue #33) are git objects in the project's own object store, written through a temporary index; nothing is referenced, pushed or copied elsewhere, and `git gc` prunes them. They hold what the work tree held, including untracked files that are not ignored, so keep secrets in ignored files. They carry the repository's own permissions, and nothing caps their disk use but `git gc`. A turn of a peer holding an open PII task is not snapshotted; a PII file left in the project is snapshotted by later turns like any other file. `ahub undo` restores only files whose current content is exactly what the turn left.
- **The edit hook reads, never decides.** `ahub check-path --hook` (issue #32) reads hub.db and returns context for Claude and a line for you; it sets no permission decision, so your permission rules stay in charge. It names other owners' task ids, titles and states, which then reach Claude's model; PII tasks are left out.
- **The session record holds identities only.** `.agenthub/state/sessions.json` (issue #37, mode 600) keeps each attached peer's recovery metadata: launch options, session and thread ids, Pi's session file path. No message or task text; loss notices name deliveries by id, sender and public task title.
- **Context checkpoints have a separate text record.** Native occupancy readings carry numeric metadata only. An optional context checkpoint persists its summary in `.agenthub/state/context-checkpoint-<peer>.json` with mode 0600 and attempts shared-memory storage when enabled. Completion requires the outstanding request id, current peer/native session and transport generation; new connection claims invalidate old requests. Private turns, every open PII task associated with the peer as owner or reviewer (including pending review), and PII-pattern summaries are refused before persistence or cloud memory. Its text is never broadcast, and context pressure does not pause, reassign or replace the session.
- **The local worker is boxed in.** Paths are resolved through symlinks and must stay inside the project; a secrets denylist (`.env*`, keys, credential files, the hub's own state and the state archives `ahub reset --all` leaves) applies to its file tools, its git arguments and its memory capture alike; `.git` and `.agenthub` are not writable. Writes, edits, shell commands and mutating git wait for approval unless the operator's permission mode grants them (writes and edits inside the grant filter in `ask-when-needed`, all four in `never-ask`; see below), and the approver sees what will be written or run, with control characters escaped. Everything it executes runs under the macOS sandbox, attended or not. Since 0.10 the profile starts from deny default (issue #39): commands run and read only the system, toolchain and project directories (and the project's git dir and the selected developer dir; with network on, the public CA bundles); no writes outside the project, its git dir and a temp dir of its own (`TMPDIR`, made for each command and removed when it ends; issue #63); no `.git/hooks` or `.git/config` writes; no network, loopback included, unless `local.bash_network`; with it, only through the hub's egress proxy to the hosts in `local.network_allow` (issue #65), which refuses names that resolve to internal addresses (behind NAT64 with the well-known prefix, by the IPv4 address the answer carries; a network-specific prefix is not recognised), so claude-mem and the Codex app-server stay out of reach (`"direct"` opens everything, until 0.13.0). One channel stays open: `trustd`, which TLS clients need, can fetch a certificate's AIA or OCSP URL on a command's behalf, outside the proxy. The allow-default profile of 0.9 and earlier was removed in 0.12.0 (issue #83); a `local.sandbox` setting is ignored with a note. The shared temp dirs (the user's and `/private/tmp`) are closed. Without the sandbox there is no `bash` tool.
- **Capabilities are enforced, not suggested.** `capabilities` (issue #39) is checked by the daemon where task operations and messages arrive, so a peer cannot get round it by phrasing. A peer can never answer a permission request: the control link takes `permit` from the console role only, and a message that quotes a permit command is just text. Both bind the hub's own tool paths: a vendor agent with its own shell in the project (Codex, Claude, Kimi) can read `.agenthub/state/control-token` and connect as the console, which only the local worker's and Pi's sandbox prevents.
- **PII has an enforced path.** A task matching `signals.pii_patterns` goes to `local` or to nobody; its text is absent from other peers' envelopes, the console stream, the log and the board listing; the console user reviews it; `local` answers such a turn to the console only, keeps it out of its history, refuses it when the only gateway is off campus, and may not save notes or spin off tasks during it. Nothing about it is sent to claude-mem, whose observer is a cloud model.
- **A model screen can add to the patterns (issue #198).** With `signals.pii_screen = "local"` in `routing.toml` (default `off`; it applies while `constraints.pii = "local_only"`), a newly proposed task is read by a model before the hub does anything else with it: until the verdict it is on no board, in no envelope, before no triage model, and the hub makes no brief or note call for it. The local worker's claude-mem capture leaves its hub tool calls out (issue #230), so a proposal it makes in an ordinary turn cannot reach claude-mem ahead of the verdict that way. The screen runs on the model on this machine (MLX or Ollama, loopback only) or, without one, on the gateway only while `onCampus()` holds, and the gateway call is refused once more right before transport if the gateway is behind Access; task text never goes off campus to be screened. When the on-device generation slot is taken (Pi generating, another screen), the screen goes to the campus gateway instead of waiting, and on campus a device that fails or is still loading after 60% of the deadline hands over to the gateway too; off campus it waits for the slot and the device within the deadline. With the legacy MLX provider the screen may start an `mlx_lm.server`, as Pi's relay does, and it stays running until `ahub models stop`. Its answer is `pii` or `clear` plus a category from a closed list (name, student id, phone, address, grade, health, other). Anything else, a timeout (8 s, one call and one generation slot per item), a missing or off-campus model, or text longer than 6000 UTF-8 bytes (about 2000 Hangul syllables) is `unknown`, and an unknown task is a PII task: this is the hub's one model call that fails closed, so with the screener down every new task waits for `local`. An unknown verdict has the costs of any PII task, even when a second look clears it later: opening it lifts every silent turn-free cohort for good and turns facts off while it is open, and off campus a proposal without a class is refused (triage is not asked for a PII task there), with an error that says so. Off campus with the on-device slot taken, a task stays `unknown` until it is screened again: while it is still proposed and no peer ever owned it, the hub's release timer (every 60 s, one task at a time, the least tried first, at most 10 times per task in a hub run; never text too long to read) asks again, and `clear` lifts its `pii` signal and routes it through the class peers (a named owner is not remembered; a reserved one is offered first, as always). A task `local` took keeps its PII path, also once it is declined back to nobody. A pattern match is PII without a call. The task's history records the source of its `pii` signal (`regex`, `screen` with the category, or `unknown` with the reason), an unknown verdict is a console line naming the task id only, and `events.jsonl` gets a `pii_screen` record with the item kind, label, source, category, reason and latency, never the text. A routing explanation of a draft does not call the screen and says so.
- **Free text is screened too.** On an ordinary task, a done summary (with its check output: a match withholds the whole note), a review note, an unmet item or a budget handoff that matches a PII pattern (issue #69) is not saved to claude-mem, and every peer, `local` included, gets a stub naming `ahub task show <id>`; the board keeps the text, `hub.log` notes the withholding by task id only, and `ahub ask` shows such a note only when its model is reached on campus. `hub_remember` refuses a match; what a vendor agent writes to its own memory is not screened. With the model screen on, the same items (and `hub_remember` notes) go through it as well, one call each and only after the call's own checks (owner, state, verdict, a running check, memory enabled) pass: a `pii` or `unknown` verdict withholds the item exactly like a pattern match, and the board marks the history entry (`withheld`) so later views (task lists, completed-change notices, `ahub ask`, a reviewer replaced after a restart) keep withholding it. A budget hand-off is screened once per hand-off, whatever the number of tasks it moves; an escalation's reason is the hub's own text and is not screened. Pattern-only, without the model: the check output tail in a done note (only the summary is screened), a plan given with `hub_task_accept`, a decline reason, a task's refs (paths, branch), and context checkpoint summaries. Not screened at all (an existing gap, not new with the screen): the local worker's claude-mem capture records its file, shell and git tool calls in ordinary turns with their raw arguments and output, and the closing answer of a turn that used tools, without a pattern or model check. Its hub tool calls (`hub_send`, the task tools, the conductor tools) are not captured (issue #230), so a title, detail, done summary, review note or `hub_remember` text it writes reaches claude-mem only through the screened paths above.
- **Secrets stay where they are read.** The gateway key and Cloudflare Access values are read inside the gateway client and go only into request headers: never into logs, errors, envelopes, tool output, memory, or the generated Switchyard config (the key travels by environment variable name). Subscription logins of Claude, Codex and Kimi are never proxied or pooled.
- **The hub's own model calls are fenced.** Digest condensation, task triage and the PII screen read agent-written text as data; their output is capped text framed as untrusted, or a value checked against a closed list. It is never used as a route, a peer id, a tool call or an instruction.

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
.agenthub, .git, .claude, .codex, .qwen, .kimi, .pi and .mcp.json. Symlink escapes, protected aliases, traversal and
unresolved wildcard targets receive no decision. Names are compared folded (letter case, compatibility forms and
the code points a case-insensitive disk ignores, so a look-alike such as a long s or a name with a zero-width joiner
is the same name), the path is judged inside the project, and a file with a second hard link receives no decision,
for Claude and for the Pi/local write and edit grants alike. The local worker's and Pi's write guard refuses `.git`
and `.agenthub` by the same folded comparison in every mode, so a new `.GIT/config` cannot be planted for git to run. Native rules then apply;
this is a grant filter, not a filesystem sandbox.

## Agent CLI identity and conductor authority

Inside an agent session, `ahub` identifies the caller from `AGENTHUB_PEER_ID`,
or the native Claude/Codex shell marker when the hub marker is absent. It connects
as that peer in tools mode. Messages and task changes retain that actor;
`say` defaults to status priority and important messages still require the peer's
capability. Conflicting or malformed markers fail closed. There is no `--as-user`.
Human-only operations are refused before connecting, including permission answers
and permission modes, queue resolution, budget overrides, benchmark runs, research
backfill and task labels, lifecycle and recovery operations, and `ask`.
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
A conductor may inspect public state, assign or escalate work, start supported
headless peers and place its own delivery holds. It cannot answer approvals,
resolve durable deliveries, override budget pauses or release a human hold.
Pending approval summaries exclude titles; PII tasks remain public stubs.
Conduct events contain ids only. Supervision feeds use structured reasons and
never carry check output or approval bodies.

## Reporting

Please report vulnerabilities privately through GitHub's "Report a vulnerability" on this repository rather than in a public issue.

## Local dashboard sessions (issue #6)

- `ahub ui` uses the authenticated console control connection to start an ephemeral HTTP listener on `127.0.0.1`. No UI listener exists before that command. The control and Codex proxy ports continue to refuse every `Origin` header.
- The daemon issues a cryptographically random, single-use bootstrap ticket valid for 60 seconds. The CLI opens the dashboard with that ticket in the URL fragment, never a query string or the control token. The static page removes the fragment immediately and exchanges it with a same-origin POST. Tickets are consumed once; expired tickets cannot create sessions.
- The exchange creates a separate random session, valid for one hour without renewal, in an `HttpOnly; SameSite=Strict; Path=/` cookie named for this listener's port. Sessions and tickets live only in memory and die with the daemon. The page itself keeps one more cookie, `agent-hub-theme` (issue #246): script-set, `SameSite=Strict`, kept for a year for the whole `127.0.0.1` host, and read back only as one of `system`, `light` or `dark`. HTTP is loopback-only; the cookie is not a substitute for the origin checks.
- Every request must have the exact listener Host. Every data or action request, including the ticket exchange and snapshot polling, must be POST with the exact listener Origin and JSON content type. Foreign and missing origins, missing or expired sessions, oversized bodies and unknown actions are rejected. There is no CORS support. The only unauthenticated GET is the fixed, data-free HTML shell. No files or paths are served dynamically.
- Responses are non-cacheable, cannot be framed, suppress referrers, and use a content security policy restricting scripts/styles to the shipped inline content and connections to this origin. Browser text is rendered with textContent, never interpreted as HTML.
- The browser receives a bounded redacted event stream, peer states and queue counts, public task views, budget windows, pending approvals and benchmark run summaries (issue #251): the newest runs in `~/.agenthub/bench/`, whichever project on this machine ran them, by suite name, arm label, state, the task id in progress, counts, tokens and times, never suite text. Private envelope bodies and PII task text never cross this endpoint. Local-worker approval titles can contain PII, so their details remain terminal-only; the dashboard identifies the request and directs the operator to `ahub tail` before allowing it. Budget checkpoint summaries are also omitted.
- The closed action list is permission response, peer pause/resume, console message, task proposal and task assignment. These use the existing daemon/task paths and budget pause rules. There is no generic control proxy, task-detail read, shell, file access, configuration edit, budget override, peer launch or daemon shutdown API.
- The listener stops with the daemon. Expired sessions must be reopened with `ahub ui`; the page does not silently obtain new credentials.


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
