import { ADAPTERS, deriveAdapterLists, type AdapterDefinition } from "../adapters/registry.ts";
import { VERSION } from "../version.ts";
import { paint, wrap, type Span } from "./console-state.ts";

/** One usage form of `ahub help`: the usage starts with `ahub <command>`, alternatives joined by `|`. */
export interface HelpEntry { section: string; usage: string; description: string }

const SECTIONS: [string, [usage: string, description: string][]][] = [
  ["Projects", [
    ["ahub --project <path|id> <command>", "select a repository or worktree explicitly"],
    ["ahub projects [--json] [--full] [--color=auto|always|never]", "list registered projects and live status"],
    ["ahub projects remove <id>", "forget a stopped registration (keeps project files)"],
    ["ahub setup [--yes]", "install or update the Claude Code channel plugin from this package, then run doctor"],
    ["ahub init [--profile dev|research|writing|general|<pack>] [--shadow] [--release-guard] [--dry-run --json]", "preview or write .agenthub/config.json and the AGENTS.md marker block (drops a legacy CLAUDE.md block); a pack is a project file .agenthub/roles/<name>.pack.json"],
    ["ahub --live-test [--project <path|id>] <command> [args...]", "user-authorized operational console delegation; ordinary calls retain peer identity; person-authored content refuses"],
    ["ahub help [command]", "this help, or one command's entries; also --help and -h"],
    ["ahub version | --version", "print the installed version"],
    ["ahub completion zsh|bash|fish", "print a shell completion script; its candidates come from these help entries"],
  ]],
  ["Daemon and runtime", [
    ["ahub up [--unattended] [--no-console]", "start the daemon; interactive terminals enter console"],
    ["ahub console [--panels] [--color=auto|always|never]", "enter the human console; P cycles built-in pet characters/off; exiting leaves the daemon running"],
    ["ahub console --no-pet", "turn off attention for this session; combines with --panels and --color"],
    ["ahub pet --window [--close]", "start or close the macOS floating window, from a person's terminal"],
    ["ahub pet [--short]", "read attention without connecting; --short prints ahub!N only when action is needed"],
    ["ahub pet --palette <blue|teal|violet|ochre>", "save the floating window's base color to pet.palette in .agenthub/config.local.json"],
    ["ahub sdlc status [task] | explain <task> [--json] [--color=auto|always|never] | export <task> | record <task> <receipt-json>", "read head-bound lifecycle gates and the next actor/action; status and explain are open to any agent as a public view (private tasks stay stubs), export and record are person only; export stays JSON"],
    ["ahub sdlc queue <owner/repo> | release <owner/repo> [live-issue...] [--json] [--color=auto|always|never]", "read-only merge and release evidence; open to any agent as public readback of the checkout's repositories, never an authorization"],
    ["ahub sdlc merge <task> [--dry-run]", "guarded squash merge of an approved task at its approved head after every gate is re-read; follows sdlc.toml auto_merge (off, dry-run, on); --dry-run only reports (person or conductor)"],
    ["ahub sdlc authorize-release <version> [--json] [--color=auto|always|never]", "approve this daemon checkout commit, version and fresh docs (person only; restart revokes)"],
    ["ahub sdlc release-guard -- <literal git push|gh release create|npm publish argv>", "read-only authorization preflight; init --release-guard installs the tag pre-push hook"],
    ["ahub sdlc release-guard-hook <remote-name> <remote-url>", "internal pre-push readback; validates version tags and forwards exact stdin on success"],
    ["ahub sdlc accept <task> --issue <n> [--repo owner/repo]", "accept the task's spec issue at its current body; build entry needs it in enforce (person only)"],
    ["ahub sdlc accept-departure <task> <head> <reason...>", "accept current plan departures on that exact PR head (person only)"],
    ["ahub sdlc plan-review <task> <revision> <reason...> [--review full|delta|none --reviewers N] [--ci full|focused|reuse]", "record planner review, scope and host-read issue metadata"],
    ["ahub sdlc train report|configure|cut <release-id> [revision] [json]", "plan a release and freeze its approved scope after resource/quota admission"],
    ["ahub sdlc release-assign <task> <revision> <release-id|none> <reason...>", "assign approved/in-flight work without changing execution"],
    ["ahub sdlc costs [owner/repo] [--json] [--color=auto|always|never]", "read bounded planner cost metrics for linked merged PRs"],
    ["ahub sdlc metrics [--since <YYYY-MM-DD|ISO time>] [--json] [--color=auto|always|never]", "read SDLC metrics and control band tiers from board history (planner or person; read-only)"],
    ["ahub backlog groom | return <task> <revision> <reason...> [--json] [--color=auto|always|never]", "read grooming findings or return accepted untouched work to backlog (planner/person)"],
    ["ahub status [--json] [--full] [--color=auto|always|never]", "the hub, its peers, model backends and task counts"],
    ["ahub status --all [--json] [--color=auto|always|never]", "show every registered project"],
    ["ahub logs [-f]", "person: last 100 hub.log lines (-f starts at 10); conductor: bounded public lines and follow while authority remains"],
    ["ahub doctor [--json] [--full] [--color=auto|always|never]", "check the tools, daemon, plugin, gateway, models and memory library this project uses"],
    ["ahub doctor --stale-anchors [--json]", "read-only bounded report of public memory symbol anchors at current HEAD; private or unavailable evidence stays unknown"],
    ["ahub doctor --orphans [--kill] [--json] [--color=auto|always|never]", "person: inspect missing-root registrations; conductor --kill: selected project only; signed hub ownership is required before any stop"],
    ["ahub agents [--json]", "show each gated agent CLI's installed version and verdict (verified, in-line, trusted, refused or unknown)"],
    ["ahub agents trust <id> <version> [--revoke]", "accept an untested agent CLI version on this machine (person only; runtime proofs still run)"],
    ["ahub kill", "stop this project's hub"],
    ["ahub down", "stop this project's hub, the counterpart of ahub up (same as ahub kill)"],
    ["ahub reset [--all] [--yes]", "list, then with --yes stop the hub and discard every queued and needs_review delivery, clear holds and pauses and drop session pointers; --all moves the state directory to .agenthub/archive instead"],
    ["ahub restart [--dry-run] [--yes] [--json] [--verbose] [--color=auto|always|never]", "recover this project's runtime; a configured conductor's --yes requires a same-project, source-issued continuation proof, otherwise run it as the person"],
    ["ahub upgrade [--to <version>] [--dry-run] [--yes] [--json] [--verbose] [--color=auto|always|never]", "review and upgrade running projects; --to defaults to latest for interactive review or dry-run, while --yes requires --to <exact-version>; conductor apply needs the same project's supported proof, and a newer-coordinator handoff is person-only"],
    ["ahub recovery [status|resume|abort] [<operation-id>] [--json] [--color=auto|always|never]", "inspect a preflight; without an id, resume/abort select the operation holding the lock; a bare terminal opens the person's screen; only its initiating conductor may continue its own supported restart/upgrade with fresh proof"],
    ["ahub recovery reattach <operation-id> codex|claude|pi", "person only: repair that blocked peer with its recorded session; leaves the rest for recovery resume"],
    ["ahub recovery dispose [<operation-id>] --fresh-session codex|claude --reason <text>", "end a partial operation by starting that peer as a new session, recording the lost conversation"],
    ["ahub recovery dispose [<operation-id>] --stop-and-archive --reason <text>", "end a partial operation: stop its own targets, archive its snapshot and release the lock; the upgrade is abandoned, not completed"],
    ["ahub daemon [--unattended]", "internal: the detached hub process that ahub up or the dashboard manager starts"],
    ["ahub recovery-run <operation-id>", "internal: a detached runner; conductor use is limited to the captured operation continuation, not a general command"],
  ]],
  ["Agents", [
    ["ahub <configured-kind> [--mode headless] [--as <instance>] [--session-id <id>] [--print-command | --dry-run]", "start a trusted config.local.json ACP kind (default off roster); native argv is withheld in previews"],
    ["ahub role list [--group <group>] | show <id>", "read bounded catalog guidance with layer and content hash"],
    ["ahub role assign <peer> <id> | clear <peer> [<id>]", "person only: add or clear catalog guidance, applied at the next peer start"],
    ["ahub stop <peer>", "person or configured conductor: stop a hub-owned headless peer; end TUI agents in their terminals"],
    ["ahub models status [--json] [--color=auto|always|never]", "inspect local model state as labelled fields"],
    ["ahub models setup|start [--json] [--color=auto|always|never] | stop", "prepare or inspect local Ollama MLX; setup and start print the model state like status (legacy stop is explicit)"],
  ]],
  ["Messages and approvals", [
    ["ahub say [@peer ...] <text>", "send as the console user (no @peer = broadcast); delivered at once, start the text with [STATUS] to let it batch or [FYI] for the record only"],
    ["ahub watch kimi|qwen [--no-thoughts] [--color=auto|always|never]", "person-only transient activity from a headless ACP peer; q quits, approvals stay in console"],
    ["ahub tail", "live stream of messages, states and permission requests"],
    ["ahub permission [<peer> [ask|ask-when-needed|never-ask]] [--yes]", "human only: inspect or set a running peer mode; never-ask requires --yes; config never-ask waits for console y"],
    ["ahub permit <id> <option>", "answer a permission request shown by tail (\"deny\" cancels)"],
    ["ahub roster [--json] [--color=auto|always|never]", "every known peer, participation, start mode and retained work"],
    ["ahub roster add <peer> | remove <peer> [--yes] [--now]", "person or configured conductor: change live participation through settings; removal previews retained messages and task handoff; remove also deletes the roster key of an instance no longer declared"],
    ["ahub settings [list] [--json] | get <key> [--json]", "the settings the dashboard can change, each with its value, the file it comes from and when it applies"],
    ["ahub settings set <key> <value|inherit> [--yes] [--preview] [--now] | undo | reload", "validated settings: conductor set is limited to exact live operational keys; undo/reload and other keys are person only; --preview saves nothing; conductor writes keep the person undo record"],
    ["ahub settings edit <config.local.json|sdlc.toml> (set <path> <json> | remove <path>)... [--reason <text>] [--preview] [--yes] | backups [--json]", "human only: structural config (instances, review, snapshots, approvals, context.gate, sdlc.toml mode and required_checks) validated by the hub's own loaders, previewed as a diff and written with a backup; a key that runs code or locates secrets needs its name typed, never --yes"],
    ["ahub pause|resume <peer>", "hold a peer's deliveries in its queue / release them"],
    ["ahub queue list [--peer <id>] [--json] [--full] [--color=auto|always|never]", "inspect durable deliveries; open to any agent as public queue metadata, held bodies stay with the person or conductor"],
    ["ahub queue show <delivery-id> [--json] [--color=auto|always|never]", "person or configured conductor: inspect one delivery and revision; agent output uses the public view"],
    ["ahub queue resolve <delivery-id> --action completed|retry|discard --reason <text> [--revision N] [--json] [--color=auto|always|never]", "person or configured conductor: resolve a queued or needs_review delivery; --revision binds the displayed row instead of a fresh show; a queued delivery can be discarded while its peer is busy, and a refusal names its cause"],
    ["ahub queue discard --peer <id> --reason <text> [--state queued|needs_review] [--yes] [--json]", "person or configured conductor: without --yes count one peer's queued (default) deliveries; with --yes discard them all with the reason, one recorded discard each; other peers' queues are untouched"],
  ]],
  ["Tasks and review", [
    ["ahub board import github --label <label> [--milestone <milestone>] [--repo <owner/repo>]", "person or configured conductor: read bounded open issues into deduplicated Backlog; never writes GitHub"],
    ["ahub board [state | --ready] [--columns] [--release <name> | --release-id <id>] [--json] [--full] [--color=auto|always|never]", "the task board, one line per task at a terminal width; --full: whole titles and SDLC advice; --ready: proposed tasks with nothing left to wait for"],
    ["ahub task propose [--class <c> | <class>] <title...> [--owner <peer>] [--path <p>]... [--after <id>]... [--urgent] [--backlog] [--detail <text>]", "put a task on the board; a first word that names a class is taken as the class; while a task named by --after is not approved yet, --owner reserves the task for that peer, offered to it first once it is ready; otherwise --owner assigns it now"],
    ["ahub backlog list [--json] [--full] [--color=auto|always|never] | add <class> <title...> | plan <id> <revision> <fields-json> <reason...> | pin <id> <revision> true|false <reason...> | undo <id> <revision> [--json] [--color=auto|always|never]", "person only: plan work with a reason; {} records a note-only revision, fields.sdlc sets backlog repo/issue identity and clears old spec acceptance; preserve pins/frozen scope and refuse stale edits; list is by rank (--json: raw listing)"],
    ["ahub release new <name> <goal> <order> | list | show <name> | plan <name> <revision> <dates-json> | activate|freeze|ship|drop <name> <revision> [--json] [--color=auto|always|never]", "person only, except show (any agent, public metadata): planned UTC millisecond dates and phased scope; ship records a time after approval, never tags or publishes"],
    ["ahub backlog split <id> <revision> <parts-json> <reason...> [--json] [--color=auto|always|never]", "person only: stage2..8 child prerequisites; original task retains integration, undo refuses used or changed children"],
    ["ahub backlog pull-ready <id> <revision> <reason...> [--json] [--color=auto|always|never]", "person only: reserve an eligible WIP slot before routing; pending unowned work can be undone"],
    ["ahub backlog pull|return <id>", "person only: pull backlog into To Do or return ownerless proposed work; --backlog on task propose stages unoffered work"],
    ["ahub smoke run qwen-dual-output --project-id <id> --receipt <file.json> [--timeout-ms <100..120000>] [--json]", "requires the leading --live-test flag; disposable temporary project only: Q2 dual-file submit and queued second submit; isolated native HOME, owned-process cleanup and a counts/timings receipt; requires OPENAI_API_KEY, OPENAI_BASE_URL and OPENAI_MODEL; real-account live proof remains a separate person leg"],
    ["ahub broker serve [--hostname <host>] [--port <0..65535>] [--public-url <ws[s]://host/>] [--owner <fingerprint>]... [--state-dir <dir>]", "person only: standalone ciphertext relay; default loopback port 8788, public WSS needs owner allowlist and TLS termination"],
    ["ahub broker room drop <room> --yes [--state-dir <dir>]", "person only, broker stopped: forget one room's pins, floors and queued ciphertext; other rooms stay intact"],
    ["ahub room create <name> --broker <url> [--label <id>] | invite <name> [--accept <request>] | join <token> [--name <name>] [--label <id>] | join <name> --roster <signed-roster> | leave <name> | revoke <name> <fingerprint> | expose <name> [<peer>...] [--confirm <member-fingerprint-prefix>]", "person only, never --live-test: every mutation displays both fingerprints, then requires TTY y/N (default No) or --confirm matching 16..64 lowercase hex of the member fingerprint; exchange artifacts out of band, never invitation secrets through the broker"],
    ["ahub room resolve <name> --frame <digest> --action accept|discard [--confirm <member-fingerprint-prefix>]", "person only, never --live-test: dispose one uncertain incoming application after fingerprint confirmation; no republish or signed receipt"],
    ["ahub room list [--json] | status [<name>] [--json]", "read-only room ids, owner/member fingerprints, epochs and link states; agent shells may read; no message bodies or invitation secrets"],
    ["ahub room inbox [<name>] [--json] | inbox show <id> | inbox done|discard <id>", "person only, never --live-test: metadata list, one untrusted console body, or local body purge; completed (inbox) means admitted, never read"],
    ["ahub source add <path|url> | list [--json] [--color=auto|always|never]", "list is person only, add the person's or the configured conductor's: register an input as a content-hashed source (src:<16 hex of the SHA-256>) under the hub state dir sources/<id>/ (meta.json, raw, text); a URL is fetched once by this command, https only, at most 5 redirects; up to 16 MiB, never truncated; a path under pii.paths or text matching signals.pii_patterns is private, and private is never downgraded"],
    ["ahub schedule list | run <id> | pause <id> | resume <id> [--json] [--color=auto|always|never]", "list is person only; run, pause and resume are the person's or the configured conductor's: the machine-local schedules (`schedules` in .agenthub/config.local.json); list shows each one's next run, run proposes one now through the same hold, open-task and PII path as the timer and restarts its period, pause stops the timer proposing it without counting a skip, resume starts a fresh period so a pause is never replayed as a run"],
    ["ahub intake \"<text>\" [--source <id>...] | approve <id> | discard <id> [--json] [--color=auto|always|never]", "person only, except approve (person or configured conductor): turn a plain request into a draft backlog card that nothing offers or pulls until you approve it; the configured planner is asked to split it with hub_backlog_split, or the hub model proposes the split (a PII request only on an on-prem model, never to a planner); each --source must be a registered src: id; approve clears the draft on it and its parts, discard cancels them through task cancel"],
    ["ahub deliverables [--task <id>] [--approved] [--check] [--json] [--color=auto|always|never]", "what each task delivered and a reviewer approved, by id, hash and size (a path only where the PII screen allows); --check measures the files now and marks one changed since review; an agent sees only the tasks hub_task_show shows it"],
    ["ahub task show <id> [--json] [--full] [--color=auto|always|never] | escalate <id>", "full task with history (the person sees PII text, an agent the public view) / hand it to the next peer in escalate_to (person or configured conductor)"],
    ["ahub task role <id> <role|none>", "the person, or an agent on a task it owns: change bounded catalog guidance on an open task; routing and authority are unchanged"],
    ["ahub task assign <id> <peer> [--role owner|reviewer|planner] [--revision N]", "name the owner (default), reviewer or person-only planner; a task that still waits reserves its owner; a peer that cannot take it is refused with the reason; --revision refuses stale console actions"],
    ["ahub task unassign <id> [--role owner|reviewer] [--revision N]", "person or configured conductor: remove the owner/reservation or reviewer without routing a replacement or stopping native work; preserves the actual actor"],
    ["ahub task claim <id> <slot> <supported|unsupported|unclear> [--model <label>] [--model-said <supported|unsupported|unclear>]", "person only: record your verdict on one declared plan claim (by its 1-based slot, never its text), with the model label and what the model said, so the research scorecard can show agreement; a later verdict for the slot replaces the earlier one"],
    ["ahub task cancel <id> --reason <text> [--superseded-by <ref>] [--revision N] [--json] [--color=auto|always|never]", "the person, or an agent on its own task as hub_task_cancel allows: close obsolete work with a reason; retain its history without stopping native work or releasing dependents; eligibility follows the task-board policy"],
    ["ahub task label <id> ok|regressed|reverted|incomplete|wrong|abandoned [--created <time>]", "your later verdict on an approved task, kept in the research records (research must be on); an agent labels only a task it owns, and its record names it"],
    ["ahub review <id> approved|changes_requested [note...] [--unmet <item>]... [--head <sha>] [--findings <json>]", "give a review verdict on a task; the person can do the same in ahub console: Tasks, select the task, r, then a (approve) or c (request changes, with a note)"],
    ["ahub review brief <id>", "print the review brief of a task's commit: reviewable and excluded files, rules, coverage to account for"],
    ["ahub route explain <id>", "why a task went where it went, its reserved owner and the planner walk included"],
    ["ahub route explain --class <c> <title...>", "what would happen to such a task now"],
    ["ahub ask [--remember] <question...>", "answer from the task board, shared memory and this run's log, with the ids it rests on"],
    ["ahub remember <text...>", "save a note to the memory all agents share"],
  ]],
  ["Budget", [
    ["ahub budget [--json] [--full] [--color=auto|always|never]", "quota windows per peer with each number's kind (native, count, manual) and source, why a peer shows no number, and who is paused until when"],
    ["ahub budget set <peer> <0..1> [--resets-in 30m] [--window 5h|week]", "feed a reading by hand (also: test the relay)"],
    ["ahub budget resume <peer>", "override a budget pause; readings are ignored for that peer until the window resets"],
    ["ahub budget execution status [id] [--json] [--color=auto|always|never]", "read execution counters and limits"],
    ["ahub budget execution configure <config.json> | disable <id> [--json] [--color=auto|always|never]", "opt-in limits on model calls, tool calls, time and tokens for pi and local"],
  ]],
  ["History and reports", [
    ["ahub turns [peer] [--limit N] [--json] [--color=auto|always|never]", "recent turns and the files each changed (a git work tree only)"],
    ["ahub undo <turn> [--yes] [--context]", "put back the files a turn changed; refuses files changed since. Without --yes it only lists them; --context also drops a Codex turn from its conversation"],
    ["ahub report [--since 7d|<iso>] [--by task] [--json] [--color=auto|always|never]", "turns, tokens, messages, overlaps and task events per period"],
    ["ahub report --dogfood [--since 7d|<iso>] [--json]", "read-only scorecard: flow, quality, cost, delivery, performance and adoption; missing evidence is unknown"],
    ["ahub usage [--since 7d|<iso>] [--by peer|task|issue|pr|release|day|model] [--json] [--color=auto|always|never]", "tokens per group from the incremental roll-up: the provider's total with and without cache reads, input, output, reasoning and the hub's own count; each number names its source, unknown is never 0"],
    ["ahub usage limits [--peer <id>] [--limit <n>] [--json] [--color=auto|always|never]", "current quota windows and the history of pauses, resumes and resets"],
    ["ahub usage total [--json] [--color=auto|always|never]", "lifetime development tokens since the first event, per peer and overall"],
    ["ahub export [--since 7d|<iso>]", "structured events (events.jsonl) as JSON lines; never message bodies; the configured conductor gets a bounded projection (last 1000 events)"],
    ["ahub research [--since 30d] [--all] [--json]", "success, first-pass, rework and check-failure rates, tokens and wall time per approved task, from the opt-in research records"],
    ["ahub research addons [--since 30d] [--all] [--json]", "approved tasks with each add-on (claude-mem, ponytail, ripwire, ...) on against off, with intervals; association, not cause"],
    ["ahub research export [--format jsonl|csv] [--since 30d] [--all]", "the research records for outside analysis: ids, counts and tokens, never text"],
    ["ahub research backfill", "build this project's research records once from events.jsonl (person or configured conductor)"],
    ["ahub bench run <suite.json> --arm <label> [--repeat N] [--tasks a,b] [--addon <name>=on|off]... [--memory off|claude-mem|native|both]", "run a benchmark suite against the peers attached here, in a project kept for benchmarks (it resets the work tree; person or configured conductor); --addon and --memory declare the arm's add-on and memory state and refuse a setup that differs"],
    ["ahub bench list|status [--json]", "benchmark runs on this machine / the one running now"],
    ["ahub bench report <run> [--json]", "pass rate, first pass, rework, tokens and wall time per task and overall"],
    ["ahub bench compare <run|arm>... [--suite <name>] [--mixed] [--json]", "compare arms of one suite with 95% bootstrap intervals; inconclusive below 5 counted attempts per arm"],
    ["ahub bench export [--format jsonl|csv]", "benchmark records for outside analysis: ids, outcomes and counts, never suite text"],
    ["ahub check-path <file> [--peer <id>]", "other owners' open tasks that claim or changed a file"],
    ["ahub memory [list] [--tier short|long] [--kind <kind>] [--peer <p>] [--machine <id>] [--since <iso>] [--limit N] [--json]", "the hub's own memory for this project: decisions, contracts, fails and findings, short- and long-term (docs/memory.md)"],
    ["ahub memory search <words> | show <id> | graph <id|node> [--hops 1|2] [--history | --as-of <iso>] [--json]", "find entries, read one with its provenance, or list its graph neighbourhood; superseded and expired entries are hidden unless a person asks for --history or --as-of"],
    ["ahub memory promote|demote|forget <id> | supersede <old> <new> | rebuild", "a person's changes to memory: move an entry between tiers, forget it, mark it superseded, or rebuild the index from the logs"],
    ["ahub memory sync [--remote <private git url>] | machine [--label <name>]", "sync hub memory with your other machines through a private git remote (a person's), or show or name this machine"],
    ["ahub memory import claude-mem [--db <path>] [--limit N] [--restart] | dedupe [--apply] | suggestions | confirm|reject <id>", "copy the hub's notes from claude-mem into hub memory (a person's); review the model's suggested edges"],
    ["ahub memory decay [--days N] [--json]", "person only: list long-term entries older than N days (default 90) that no open goal links; review only, nothing is changed"],
    ["ahub memory profile-check [--json]", "read-only check of the running hubs' memory bindings against their memory profiles; exits 1 when one is not ready"],
    ["ahub goal [list] [--all] | show <id> [--json]", "long-term tasks: state, which machine holds each and until when, linked board tasks"],
    ["ahub goal new <title> [--milestone <text>]... [--depends <id>]... [--shared] | link <id> <task> | state <id> <state> | done <id> | take <id> [--force]", "a person's changes to long-term tasks (link also the configured conductor's); take --force voids other machines' claims"],
  ]],
  ["Hooks", [
    ["ahub check-path --hook", "check-path as a Claude Code PreToolUse hook (templates/claude-hooks.json); never blocks"],
    ["ahub facts --hook", "turn-free facts as a Claude Code PreToolUse, PostToolUse and Stop hook (issue #108); never blocks"],
  ]],
  ["Dashboard", [
    ["ahub ui [--no-open]", "open the local dashboard with configured attention character (or print its one-time link)"],
    ["ahub ui --settings [--no-open]", "human only: open it with a settings session, which for 15 minutes may change permission modes, routing, start settings and structural config"],
    ["ahub ui --all [--no-open]", "open the unified project dashboard"],
    ["ahub ui --all --stop", "stop only the dashboard manager"],
    ["ahub manager", "internal: the dashboard manager process that ahub ui --all starts"],
  ]],
];
export function helpEntries(definitions: readonly AdapterDefinition[] = ADAPTERS): readonly HelpEntry[] {
  const byKind = new Map(definitions.map(definition => [definition.kind, definition]));
  const order = deriveAdapterLists(definitions).HELP_ORDER;
  const native = order.flatMap(kind => byKind.get(kind)?.cli.usage ?? []);
  const instanceKinds = order.filter(kind => byKind.get(kind)?.instances !== undefined);
  const instances: readonly [string, string] = [`ahub ${instanceKinds.join("|")} --as <instance> [options...]`, "start an extra instance of that kind declared under instances in .agenthub/config.local.json"];
  return SECTIONS.flatMap(([section, rows]) => {
    const entries: readonly (readonly [string, string])[] = section === "Agents" ? [rows[0]!, ...native, ...(instanceKinds.length ? [instances] : []), ...rows.slice(1)] : rows;
    return entries.map(([usage, description]) => ({ section, usage, description }));
  });
}
export const HELP = helpEntries();

const COMMAND = /^ahub (-{0,2}[a-z][a-z-]*(?: ?\| ?-{0,2}[a-z][a-z-]*)*)/;
/** The command words a usage documents: `ahub pause|resume <peer>` documents pause and resume. */
export function helpCommands(entry: HelpEntry): string[] {
  return COMMAND.exec(entry.usage)?.[1]!.split(/ ?\| ?/) ?? [];
}

const DESCRIPTION = 34;
/**
 * Usage at 2 spaces, description at one fixed column, wrapped at word boundaries to the terminal width
 * (80 to 100 columns). A usage too long for that column puts its description on the next line.
 * With a command, only its entries; an unknown command renders nothing.
 */
export function renderHelp(columns: number, color: boolean, command?: string, definitions?: readonly AdapterDefinition[]): string {
  const width = Math.min(100, Math.max(80, columns || 80));
  const model = definitions === undefined ? HELP : helpEntries(definitions);
  const entries = command === undefined ? model : model.filter(entry => helpCommands(entry).includes(command));
  const lines: Span[][] = command === undefined ? wrap(`agent-hub ${VERSION}: Claude Code, Codex and Kimi as peers in one project directory`, width, 0).map(text => [{ text }]) : [];
  let section = "";
  for (const entry of entries) {
    if (entry.section !== section) {
      if (lines.length) lines.push([]);
      lines.push([{ text: entry.section, tone: "strong" }]);
      section = entry.section;
    }
    const prefix = COMMAND.exec(entry.usage)?.[0] ?? "";
    const usage = wrap(entry.usage, width - 4, 0);
    const description = wrap(entry.description, width - DESCRIPTION, 0);
    const first: Span[] = [{ text: "  " }, { text: prefix, tone: "info" }, { text: usage[0]!.slice(prefix.length) }];
    if (usage.length === 1 && 2 + Bun.stringWidth(usage[0]!) + 2 <= DESCRIPTION) first.push({ text: " ".repeat(DESCRIPTION - 2 - Bun.stringWidth(usage[0]!)) + description.shift() });
    lines.push(first, ...usage.slice(1).map(text => [{ text: `    ${text}` }]), ...description.map(text => [{ text: " ".repeat(DESCRIPTION) + text }]));
  }
  return lines.map(line => paint(line, color)).join("\n");
}

/** Body-free configured command guidance; no native argv or environment values enter help. */
export function configuredAcpHelp(kind: string): string {
  return `ahub ${kind} [--mode headless] [--as <instance>] [--session-id <id>] [--print-command | --dry-run]\nConfigured ACP runs headless through the hub, with native permissions and NO hub sandbox.\nDeclare it in untracked .agenthub/config.local.json, restart the hub, then enable roster.${kind}.\nPreview withholds native argv and starts nothing. Native/model overrides and --unattended are refused.`;
}
