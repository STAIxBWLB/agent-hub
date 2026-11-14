import { ADAPTERS, deriveAdapterLists, type AdapterDefinition } from "../adapters/registry.ts";
import { VERSION } from "../version.ts";
import { ROADMAP_FORMS } from "./roadmap.ts";
import { paint, wrap, Report as LayoutReport, type Span } from "./console-state.ts";

/** One usage form of `ahub help`: the usage starts with `ahub <command>`, alternatives joined by `|`. */
export interface HelpEntry { section: string; usage: string; description: string; /** #1504: the overview row of a native agent, from its adapter definition (`cli.summary`); never a table in this file that names a peer. */ summary?: string }

/** #1405: one source for the probe usage, read by `ahub help` and by the refusal of a malformed probe command. */
export const GUIDANCE_PROBE_USAGE = {
  register: "register --file JSON [--json]",
  start: "start --id HASH --revision N [--variant G1-HASH] [--json]",
  show: "show --id HASH [--json]",
  receipts: "receipts --id HASH [--json]",
  cancel: "cancel --id HASH --revision N [--json]",
} as const;
/** What to print when `ahub guidance probe ...` did not parse: the typed subcommand's own usage, or all five for an unknown one. */
export function guidanceProbeUsage(args: readonly string[]): string {
  const typed = args[1], known = typed !== undefined && Object.hasOwn(GUIDANCE_PROBE_USAGE, typed);
  const forms = known ? [GUIDANCE_PROBE_USAGE[typed as keyof typeof GUIDANCE_PROBE_USAGE]] : Object.values(GUIDANCE_PROBE_USAGE);
  const id = known && typed === "register" ? "" : " HASH is the 64-character probe id that ahub guidance probe register printed; no command lists probes.";
  return `${known ? `ahub guidance probe ${typed} has a missing or malformed argument` : "unknown guidance probe command"}; usage: ${forms.map(form => `ahub guidance probe ${form}`).join(" | ")}.${id}`;
}

const SECTIONS: [string, [usage: string, description: string][]][] = [
  ["Projects", [
    ["ahub specs list [--json] | check [--require-fresh] [--base <ref>] [--json] | covers <file...> | stamp <id-or-document...> [--yes]", "read design specs, validate their graph and source freshness, or find covering specs; runs without a daemon; check exits 1 on errors and, with --require-fresh, stale documents; stamp is person only (a terminal, never an agent): it shows old -> new, asks (--yes skips the question but still needs a terminal), and then changes only the verified-against line (or the stamps-file entry) to the full HEAD SHA, refused while the covered paths have uncommitted changes"],
    ["ahub worktrees [--json] | tidy [--json] | tidy --confirm <fingerprint> [--json]", "list live and settled worktrees; preview what is safe to remove; `--confirm` (the person only) runs git worktree remove and git branch -d, never forced"],
    ["ahub --project <path|id> <command>", "select a repository or worktree explicitly"],
    ["ahub projects [--json] [--full] [--color=auto|always|never]", "list registered projects and live status"],
    ["ahub projects remove <id>", "forget a stopped registration (keeps project files)"],
    ["ahub setup [--yes] [--agents <a,b>] [--research|--no-research]", "install or update the channel plugin and project-neutral hook in Claude configuration homes in use, preserving unrelated profile settings, ask once which agents ahub up starts (--agents answers it, --yes keeps the current choice or claude,codex, no terminal keeps the default), save the research default only with explicit --research/--no-research (ordinary setup leaves it unchanged), register the acon console plugin (console/plugins/ahub.json in the hub home, read at acon's next start), then run doctor"],
    ["ahub init [--profile dev|research|writing|general|<pack>] [--agents <a,b,...|none>] [--sdlc off|advise|enforce] [--required-checks <a,b,...>] [--coordination advisory|turn-free] [--memory|--no-memory] [--research|--no-research] [--snapshots|--no-snapshots] [--pi|--no-pi] [--specs|--no-specs] [--spec-review off|report|require] [--conductor <peer>|none] [--planner <a,b,...>] [--reviewer <a,b,...>|person] [--track-config|--no-track-config] [--autonomy inherit|off] [--shadow] [--release-guard] [--yes] [--dry-run --json]", "preview or write .agenthub/config.json and the AGENTS.md marker block (drops a legacy CLAUDE.md block); a pack is a shipped one (writing-pack, analysis, ops) or a project file .agenthub/roles/<name>.pack.json; a new project inherits a trusted machine autonomy default and the agent set chosen at ahub setup (start.agents) into config.local.json. Settings flags (#1065): --agents sets start.agents (none starts no agent), --research/--no-research sets research.enabled (new project default: the trusted setup choice, else off) and --autonomy off skips the autonomy inheritance, all in config.local.json; --sdlc sets sdlc.toml mode (off writes no file on a new project); advise/enforce discovers required checks from CI or literal workflow job names; --required-checks overrides discovery, and enforce without names refuses before writes; --coordination, --memory, --snapshots and --pi set their keys in config.json. On an existing project only a flag you give changes anything, and --dry-run shows each change as old -> new (--dry-run --json adds a settings array); a value equal to the current one is a no-op, an invalid value is refused with the allowed ones and nothing is written. --specs/--no-specs and --spec-review set the design-specs keys (and the AGENTS.md specs block). --track-config keeps .agenthub/config.json, routing.toml and sdlc.toml visible to git (a rule that ignores one is named and nothing is written; a routing.toml that names a machine endpoint stays ignored) and lists them to commit; --no-track-config ignores them; either sets the AGENTS.md role sentence, and neither keeps what git and the block say today. A person at a terminal who runs ahub init on a new project with no flag that sets anything and no --yes is asked each setting in turn with its default in brackets (Enter keeps it, a wrong answer asks again, and a third wrong answer ends init with nothing written), sees the plan and answers y/N; N, Ctrl-C and Ctrl-D write nothing. A peer, a live test, a pipe and --dry-run are never asked, and --yes takes the defaults. Success prints next steps to commit shared init changes, start with ahub up or ahub claude and, for advise/enforce, accept specs/departures and use guarded merge. --conductor, --planner and --reviewer (#1408) choose who conducts, plans and reviews, each on its own: the shared config.json roles are written as an explicit list for every peer whose roles change (the one that loses a role too), implementer and verifier are untouched, a peer that cannot hold the role (a headless conductor, a kind that cannot plan) is refused before any write with the reason and the eligible peers, --conductor none leaves the person conducting from ahub console and --reviewer person sends reviews to the person; Executables, secrets, models and permissions stay file edits"],
    ["ahub --live-test [--project <path|id>] <command> [args...]", "user-authorized operational console delegation; ordinary calls retain peer identity; person-authored content refuses"],
    ["ahub help [command]", "this help, or one command's entries; also --help and -h"],
    ["ahub version | --version", "print the installed version"],
    ["ahub completion zsh|bash|fish", "print a shell completion script; its candidates come from these help entries"],
  ]],
  ["Daemon and runtime", [
    ["ahub up [--unattended] [--no-console] [--no-agents]", "start the daemon, then ask it to start this project's default agents (start.agents, claude and codex unless chosen at setup; one line each, a refusal names the manual command; --no-agents skips them), then enter console in an interactive terminal"],
    ["ahub console [--panels] [--color=auto|always|never]", "enter the human console; P cycles built-in pet characters/off; exiting leaves the daemon running"],
    ["ahub console --no-pet", "turn off attention for this session; combines with --panels and --color"],
    ["ahub pet [--short]", "read attention without connecting; --short prints ahub!N only when action is needed"],
    ["ahub pet --palette <blue|teal|violet|ochre>", "retired floating-window option: run acon ui and open Mini"],
    ["ahub sdlc status [task] | explain <task> [--json] [--color=auto|always|never] | export <task> | record <task> <receipt-json>", "read head-bound lifecycle gates and the next actor/action; status and explain are open to any agent as a public view (private tasks stay stubs), export and record are person only; export stays JSON"],
    ["ahub sdlc queue <owner/repo> | release <owner/repo> [live-issue...] [--json] [--color=auto|always|never]", "read-only merge and release evidence; open to any agent as public readback of the checkout's repositories, never an authorization"],
    ["ahub sdlc survey start [--focus bugs|tests|debt|deps|dx|docs] [--json] [--color=auto|always|never]", "person or current conductor: file one read-only planner survey at a pinned source ref; only explicitly vetted findings produce backlog cards"],
    ["ahub sdlc survey show <task> [--json] [--color=auto|always|never]", "read findings and their vet decisions; unchanged or unknown prior rejections remain rejected before, and reconsideration needs an explicit vetted reason"],
    ["ahub sdlc audit start [--profile quick|standard] [--since <ref>] [--json] [--color=auto|always|never]", "file one read-only security audit task and seed its coverage ledger from [security] in sdlc.toml (person or current conductor); quick and scoped runs read as partial"],
    ["ahub sdlc audit show [<audit>] [--json] [--color=auto|always|never]", "the newest (or named) audit: source, coverage counts by unit state, each unit and finding; open important finding details are shown to the person only"],
    ["ahub sdlc adopt-merge <task> --pr <n>", "record an already merged PR at the task's recorded head with green required checks and no open Important finding; approve and release dependents (person or current conductor)"],
    ["ahub sdlc merge <task> [--dry-run] [--json] [--color=auto|always|never]", "guarded squash merge of an approved task at its approved head after every gate is re-read; follows sdlc.toml auto_merge (off, dry-run, on); --dry-run only reports (person or conductor)"],
    ["ahub sdlc authorize-release <version> [--json] [--color=auto|always|never]", "approve this daemon checkout commit, configured version source and docs policy (person or unique configured conductor on the person's explicit release instruction naming the release in its own session; hub/task/review/file/peer relays never qualify; restart revokes)"],
    ["ahub sdlc configure [--mode off|advise] [--required-checks names] [--json] [--color=auto|always|never]", "save only lifecycle mode/check names through loader validation and backup, pending restart (person or current unique conductor on the person's explicit instruction in its own session; enforce and other fields remain person-only; no release consent)"],
    ["ahub sdlc release-guard -- <literal git push|gh release create|npm publish argv>", "read-only authorization preflight; init --release-guard installs the tag pre-push hook"],
    ["ahub sdlc release-guard-hook <remote-name> <remote-url>", "internal pre-push readback; validates version tags and forwards exact stdin on success"],
    ["ahub sdlc accept <task> --issue <n> [--repo owner/repo]", "accept the task's spec issue at its current body; build entry needs it in enforce (person only)"],
    ["ahub sdlc accept-departure <task> <head> <reason...>", "accept current plan departures on that exact PR head (person only)"],
    ["ahub sdlc plan-review <task> <revision> <reason...> [--review full|delta|none --reviewers N] [--ci full|focused|reuse]", "record planner review, scope and host-read issue metadata"],
    ["ahub sdlc train report|configure|cut <release-id> [revision] [json]", "plan a release and freeze its approved scope after resource/quota admission"],
    ["ahub sdlc release-assign <task> <revision> <release-id|none> <reason...>", "assign approved/in-flight work without changing execution"],
    ["ahub sdlc costs [owner/repo] [--json] [--color=auto|always|never]", "read bounded planner cost metrics for linked merged PRs"],
    ["ahub sdlc metrics [--since <YYYY-MM-DD|ISO time>] [--json] [--color=auto|always|never]", "read SDLC metrics and control band tiers from board history (planner or person; read-only)"],
    ["ahub backlog groom | return <task> <revision> <reason...> [--reserved <peer> | --unreserve] [--json] [--color=auto|always|never]", "read grooming findings or return accepted untouched work to backlog (planner/person); --reserved names the peer the card is reserved for as it goes back, --unreserve clears the reservation (a person's reservation needs the person)"],
    ["ahub status [--json] [--full] [--verbose] [--color=auto|always|never]", "is the hub OK, and what to do next: an Attention list (each item with its next command), then the hub, peers and tasks; --verbose or --full prints every detail (model backends, specs, queue pressure, schedules, per-peer notes)"],
    ["ahub status --all [--json] [--color=auto|always|never]", "show every registered project"],
    ["ahub logs [-f]", "person: last 100 hub.log lines (-f starts at 10); conductor: bounded public lines and follow while authority remains"],
    ["ahub doctor [--json] [--full] [--color=auto|always|never]", "check the tools, daemon, plugin, gateway, models, memory library and memory capture setup (read from `amem setup <tool> --json`, a preview) this project uses, the runtime capture pruning ledger, whether the shared config.json tracking matches the AGENTS.md roles sentence, and who holds conductor, planner and reviewer as the loader settled them (a warning, never a failure); warn when the CLI or plugin is older than its running daemon"],
    ["ahub doctor --stale-anchors [--json]", "read-only bounded report of public memory symbol anchors at current HEAD; private or unavailable evidence stays unknown"],
    ["ahub doctor --orphans [--kill] [--json] [--color=auto|always|never]", "person: inspect missing-root registrations; conductor --kill: selected project only; signed hub ownership is required before any stop"],
    ["ahub agents [--json]", "show each gated agent CLI's installed version and verdict (verified, in-line, trusted, refused or unknown)"],
    ["ahub agents trust <id> <version> [--revoke]", "accept an untested agent CLI version on this machine (person only; runtime proofs still run)"],
    ["ahub kill", "stop this project's hub"],
    ["ahub down", "stop this project's hub, the counterpart of ahub up (same as ahub kill)"],
    ["ahub reset [--all] [--yes]", "list, then with --yes stop the hub and discard every queued and needs_review delivery, clear holds and pauses and drop session pointers; --all moves the state directory to .agenthub/archive instead"],
    ["ahub restart [--dry-run] [--yes] [--json] [--verbose] [--color=auto|always|never]", "recover this project's runtime; a configured conductor's --yes requires a same-project, source-issued continuation proof, otherwise run it as the person"],
    ["ahub upgrade [--project <path|id>] [--to <version>] [--dry-run] [--yes] [--json] [--verbose] [--color=auto|always|never]", "review and upgrade this selected project (default: current directory; --project selects another); global CLI/plugin updates are separate; --to defaults to latest for interactive review or dry-run, while --yes requires --to <exact-version>; conductor apply needs the same project's supported proof, and a newer-coordinator handoff is person-only"],
    ["ahub recovery [status|resume|abort] [<operation-id>] [--json] [--color=auto|always|never]", "inspect a preflight; without an id, resume/abort select this project's hold or a retained legacy machine hold; a bare terminal opens the person's screen; only its initiating conductor may continue its own supported restart/upgrade with fresh proof"],
    ["ahub recovery reattach <operation-id> codex|claude|pi", "person only: repair that blocked peer with its recorded session; leaves the rest for recovery resume"],
    ["ahub recovery dispose [<operation-id>] --fresh-session codex|claude --reason <text>", "end a partial operation by starting that peer as a new session, recording the lost conversation"],
    ["ahub recovery dispose [<operation-id>] --stop-and-archive --reason <text>", "end a partial operation: stop its own targets, archive its snapshot and release the lock; the upgrade is abandoned, not completed"],
    ["ahub daemon [--unattended]", "internal: the detached hub process that ahub up or the dashboard manager starts"],
    ["ahub recovery-run <operation-id>", "internal: a detached runner; conductor use is limited to the captured operation continuation, not a general command"],
  ]],
  ["Agents", [
    ["ahub <configured-kind> [--mode headless] [--as <instance>] [--session-id <id>] [--print-command | --dry-run]", "start a trusted config.local.json ACP kind (default off roster); native argv is withheld in previews; an external module instance needs the person's start"],
    ["ahub role list [--group <group>] | show <id>", "read bounded catalog guidance with layer and content hash"],
    ["ahub role assign <peer> <id> | clear <peer> [<id>]", "person only: add or clear catalog guidance, applied at the next peer start"],
    ["ahub stop <peer>", "person or configured conductor: stop a hub-owned headless peer; end TUI agents in their terminals"],
    ["ahub peer takeover <peer> [standby-id] [--json] [--color=auto|always|never]", "person only: detach the attached session without stopping its process and request that the selected standby session attach; ahub status shows standby identities"],
    ["ahub models status [--json] [--color=auto|always|never]", "inspect local model state as labelled fields"],
    ["ahub models setup|start [--json] [--color=auto|always|never] | stop", "prepare or inspect local Ollama MLX; setup and start print the model state like status (legacy stop is explicit)"],
  ]],
  ["Messages and approvals", [
    ["ahub say [@peer ...] <text>", "send as the console user (no @peer = broadcast); delivered at once, start the text with [STATUS] to let it batch or [FYI] for the record only"],
    ["ahub watch kimi|qwen [--no-thoughts] [--color=auto|always|never]", "person-only transient activity from a headless ACP peer; q quits, approvals stay in console"],
    ["ahub tail", "live stream of messages, states and permission requests"],
    ["ahub permission [<peer> [ask|ask-when-needed|never-ask]] [--yes]", "human only: inspect or set a running peer mode; never-ask requires --yes; config never-ask waits for console y"],
    ["ahub permit <id> <option>", "answer a permission request shown by tail (\"deny\" cancels)"],
    ["ahub answer [<set> <question>=<option>[,<option>]... [--other [<question>=]<text>] [--instructed <quote>]] [--json] [--color=auto|always|never]", "without operands list open hub_ask questions; with them the person answers one set. Only the configured conductor may use --instructed on the person's explicit instruction in its own session (#1328); never its own set or a relayed instruction"],
    ["ahub results [--unread] [--read <id> | --read-all | --unread-last] [--json] [--color=auto|always|never]", "person only: list what the runs you started left behind (unread ones marked *); --read marks one read, --read-all every one, --unread-last lights the most recent read one again; listing never marks anything"],
    ["ahub roster [--json] [--color=auto|always|never]", "every known peer, participation, start mode and retained work"],
    ["ahub roles [--json] [--color=auto|always|never]", "each rostered peer's flow roles as the running hub settled them, the planner and who reviews when no reviewer can run; works from a task worktree"],
    ["ahub roster add <peer> | remove <peer> [--yes] [--now]", "person or configured conductor: change live participation through settings; removal previews retained messages and task handoff; remove also deletes the roster key of an instance no longer declared"],
    ["ahub autonomy on [--all-projects] [--yes] | off [--all-projects] | status [--json]", "person only: apply the autonomy preset and machine default with one confirmation, optionally to every registered project; off removes fixed preset keys (manual edits included); status reports modes, floor enforcement and Claude homes; settings undo restores a live-hub project write"],
    ["ahub model set <peer> <model> | clear <peer> | list [--json]", "person only: select a runtime model at the next turn, clear its override, or inspect effective models and pending changes; unsupported peers need a restart"],
    ["ahub settings [list] [--json] | get <key> [--json]", "the settings the dashboard can change, each with its value, the file it comes from and when it applies; get sdlc.mode or sdlc.required_checks reads running and file values without adding writable keys"],
    ["ahub settings set <key> <value|inherit> [--yes] [--preview] [--now] | undo | reload", "validated settings: conductor set is limited to exact live operational keys; undo/reload and other keys are person only; --preview saves nothing; conductor writes keep the person undo record"],
    ["ahub settings edit <config.local.json|sdlc.toml> (set <path> <json> | remove <path>)... [--reason <text>] [--preview] [--yes] | backups [--json]", "human only: structural config (instances, review, snapshots, approvals, context.gate, research.runners, sdlc.toml mode and required_checks) validated by the hub's own loaders, previewed as a diff and written with a backup; a key that runs code or locates secrets needs its name typed, never --yes"],
    ["ahub pause|resume <peer>", "hold a peer's deliveries in its queue / release them"],
    ["ahub title <peer> <text...>", "person only: replace a Pi or local-worker session title; native-title peers rename in their own UI"],
    ["ahub queue list [--peer <id>] [--all] [--json] [--full] [--color=auto|always|never]", "inspect durable deliveries; open to any agent as public queue metadata, held bodies stay with the person or conductor; rows a resolution already settled (a retried parent, a discarded or completed row) are hidden and counted on stderr, --all shows them"],
    ["ahub queue show <delivery-id> [--json] [--color=auto|always|never]", "person or configured conductor: inspect one delivery and revision; agent output uses the public view"],
    ["ahub queue resolve <delivery-id> --action completed|retry|discard --reason <text> [--revision N] [--json] [--color=auto|always|never]", "person or configured conductor: resolve a queued or needs_review delivery; --revision binds the displayed row instead of a fresh show; a queued delivery can be discarded while its peer is busy, and a refusal names its cause"],
    ["ahub queue discard --peer <id> --reason <text> [--state queued|needs_review|failed] [--yes] [--json]", "person or configured conductor: without --yes count one peer's deliveries; with --yes discard them all with the reason, one recorded discard each. With no --state it takes the peer's queued and unsettled failed deliveries (a failed row a resolution already settled is left alone); --state names exactly one kind, needs_review only that way; other peers' queues are untouched"],
  ]],
  ["Tasks and review", [
    ["ahub board import github --label <label> [--milestone <milestone>] [--repo <owner/repo>]", "person or configured conductor: read bounded open issues into deduplicated Backlog; never writes GitHub"],
    ["ahub board [state | --ready] [--columns] [--release <name> | --release-id <id>] [--handoffs] [--json] [--full] [--color=auto|always|never]", "the task board, one line per task at a terminal width; --full: whole titles and SDLC advice; --ready: proposed tasks with nothing left to wait for; --handoffs: what this project handed to other projects and the last state each reported"],
    ["ahub task propose [--class <c> | <class>] <title...> [--owner <peer>] [--path <p>]... [--after <id>]... [--urgent] [--needs-network] [--needs-worktree] [--backlog] [--detail <text>]", "put a task on the board; --needs-network keeps it away from a peer whose shell has none; --needs-worktree keeps it away from a sandboxed peer unless the hub can make the task worktree for it (it makes it, commits and pushes at done); a first word that names a class is taken as the class; while a task named by --after is not approved yet, --owner reserves the task for that peer, offered to it first once it is ready; otherwise --owner assigns it now"],
    ["ahub task handoff --list | --sync | --project <root|id> [<class>] <title...> [--path <p>]... [--issue <n>] [--task <n>] [--detail <text>] [--duplicate-ok <reason>] [--key <uuid>] [--json] [--color=auto|always|never]", "person only: register work that belongs to ANOTHER project that runs agent-hub on that project's board (an ownerless proposal its own roles take from there); the target must be registered and running, nothing is queued; a feature or behavior change first needs a spec issue there (--issue), and an issue that already has an open task there is refused with those ids unless --duplicate-ok <reason>; a handoff the target did not confirm is reported as outcome_unknown with a key, and --key <uuid> files the same request once; --list shows each handoff with its age and whether its target is reachable (reachable, unreachable with the cause, or moved), and --sync asks every target now instead of at the next 5-minute pass; its state changes show in ahub board --handoffs (an agent that hands off gets them as task messages)"],
    ["ahub backlog list [--json] [--full] [--color=auto|always|never] | add <class> <title...> | plan <id> <revision> <fields-json> <reason...> | pin <id> <revision> true|false <reason...> | person <id> <revision> true|false <reason...> | undo <id> <revision> [--json] [--color=auto|always|never]", "person only: plan work with a reason; {} records a note-only revision, fields.sdlc sets backlog repo/issue identity and clears old spec acceptance; preserve pins/frozen scope and refuse stale edits; person marks a leg only the person can run (live receipts, their accounts or approvals): no agent is offered it, auto pull and the idle sweep skip it, and it counts toward no planner WIP; list is by rank and shows it as waiting on the person (--json: raw listing)"],
    [`ahub roadmap ${ROADMAP_FORMS.list} | ${ROADMAP_FORMS.show}`, "read public milestone membership and computed progress; private work is a count, unavailable evidence stays unknown"],
    [`ahub roadmap ${ROADMAP_FORMS.new}`, "planner or conductor: create a milestone without GitHub writes or roadmap model calls"],
    [`ahub roadmap ${ROADMAP_FORMS.edit}`, "edit at the current revision; reload roadmap show after a stale-revision refusal"],
    [`ahub roadmap ${ROADMAP_FORMS.link} | ${ROADMAP_FORMS.unlink} | ${ROADMAP_FORMS.order} | ${ROADMAP_FORMS.state}`, "planner or conductor: link and order; done and dropped require the person"],
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
    ["ahub capabilities [--json] [--color=auto|always|never]", "person only, never a conductor or an agent shell: list the skills and commands each attached peer offers (Kimi 2.3.2 and Qwen 0.26.1 sessions, Codex 0.166.0 skills; other versions list nothing), whether you share each one, its digest and the class a call would count as; sharing is invocation.share in .agenthub/config.local.json, this machine only; it only lists and never calls anything"],
    ["ahub learn list [--all] | accept <id> | reject <id> [--json] [--color=auto|always|never]", "person only, never a conductor or an agent shell: review a recurring-unmet-criterion candidate the hub filed (#514a); accept writes its one review checklist line, added to your current checklist, to .agenthub/config.local.json through the settings writer (this machine only, never a tracked file, ahub settings undo puts it back, applies after a restart) and closes the card; reject only closes it"],
    ["ahub study draft <parent> <contract.json> | revise <id> <revision> <contract.json> | approve <id> <revision> | close <id> <revision> --reason <text> | approve-protocol <hash> [--json] [--color=auto|always|never]", "person only: store a research campaign contract as a draft, revise it, approve it (the only step that creates the unit tasks and lets work start) or close it; approve-protocol binds approval to the exact protocol and evaluator hashes; a planner drafts through hub_study_draft and hub_study_revise and can never approve"],
    ["ahub study evidence <ev-id> [--revision <n>] | evidence --task <task> | check <task> <manifest.json> [--json] [--color=auto|always|never]", "explicit evidence provenance and offline synthesis readiness: single-link reads reuse research scope/privacy; task inventory and check are person-only. Complete claim/link inventories and registered deliverable hashes bind the manifest. Separate citation, locator, person judgment, contradiction and artifact statuses never certify truth; a non-ready check exits nonzero"],
    ["ahub study show [<id> | --after <id>] [--json] [--color=auto|always|never]", "read-only for anyone: list this project's research campaigns, 50 per page (the page names the --after cursor that continues it), or one campaign's coverage per unit, handoff state, budget support and why dispatch is held; a private campaign, task or source shows ids, counts and states only"],
    ["ahub study experiments (--campaign <id> [--after <n>] | --attempt <ra-id> [--events-after <n>] | --plan <hash> --baseline <ra-id> --variant <ra-id>) [--json] [--color=auto|always|never]", "read-only for anyone, the same read as hub_experiment_show: a campaign's recorded attempts (50 a page, --after continues), one attempt with its events, or one comparison under a recorded plan; each value names its provenance and a declared value is never shown as observed"],
    ["ahub deliverables [--task <id>] [--approved] [--check] [--json] [--color=auto|always|never]", "what each task delivered and a reviewer approved, by id, hash and size (a path only where the PII screen allows); --check measures the files now and marks one changed since review; an agent sees only the tasks hub_task_show shows it"],
    ["ahub task show <id> [--json] [--full] [--color=auto|always|never] | escalate <id>", "full task with history (the person sees PII text, an agent the public view) / hand it to the next peer in escalate_to (person or configured conductor)"],
    ["ahub task role <id> <role|none>", "the person, or an agent on a task it owns: change bounded catalog guidance on an open task; routing and authority are unchanged"],
    ["ahub task assign <id> <peer> [--role owner|reviewer|planner] [--revision N]", "name the owner (default), reviewer or person-only planner; a task that still waits reserves its owner; a peer that cannot take it is refused with the reason; --revision refuses stale console actions"],
    ["ahub task unassign <id> [--role owner|reviewer] [--revision N]", "person or configured conductor: remove the owner/reservation or reviewer without routing a replacement or stopping native work; preserves the actual actor"],
    ["ahub task claim <id> <slot> <supported|unsupported|unclear> [--model <label>] [--model-said <supported|unsupported|unclear>] [--manifest <manifest.json> --disposition <resolved|qualified>]", "person only: record your verdict on one declared plan claim (by its 1-based slot, never its text), with optional model agreement metadata; paired manifest/disposition fields bind an adjudicated or explicitly qualified research conclusion to the exact synthesis manifest; a later verdict for the slot replaces the earlier one"],
    ["ahub task cancel <id> --reason <text> [--superseded-by <ref>] [--revision N] [--json] [--color=auto|always|never]", "the person, or an agent on its own task as hub_task_cancel allows: close obsolete work with a reason; retain its history without stopping native work or releasing dependents; eligibility follows the task-board policy"],
    ["ahub task label <id> ok|regressed|reverted|incomplete|wrong|abandoned [--created <time>]", "your later verdict on an approved task, kept in the research records (research must be on); an agent labels only a task it owns, and its record names it; --created is the person's"],
    ["ahub review <id> approved|changes_requested [note...] [--unmet <item>]... [--head <sha>] [--findings <json>] [--security-pass <json>]", "give a review verdict on a task; the person can do the same in ahub console: Tasks, select the task, r, then a (approve) or c (request changes, with a note)"],
    ["ahub review brief <id>", "print the review brief of a task's commit: reviewable and excluded files, rules, coverage to account for"],
    ["ahub route explain <id>", "why a task went where it went, its reserved owner and the planner walk included"],
    ["ahub route explain --class <c> <title...>", "what would happen to such a task now"],
    ["ahub ask [--remember] <question...>", "answer from the task board, shared memory and this run's log, with the ids it rests on"],
    ["ahub remember <text...>", "save a note to the memory all agents share"],
  ]],
  ["Budget", [
    ["ahub budget [--json] [--full] [--color=auto|always|never]", "quota windows per peer with each number's kind (native, count, manual) and source, why a peer shows no number, who is paused until when, and the reviewer quota admission rule"],
    ["ahub budget set <peer> <0..1> [--resets-in 30m] [--window 5h|week]", "feed a reading by hand (also: test the relay)"],
    ["ahub budget resume <peer>", "override a budget pause; readings are ignored for that peer until the window resets"],
    ["ahub budget execution status [id] [--json] [--color=auto|always|never]", "read execution counters and limits"],
    ["ahub budget execution configure <config.json> | disable <id> [--json] [--color=auto|always|never]", "opt-in limits on model calls, tool calls, time and tokens for pi and local"],
  ]],
  ["History and reports", [
    [`ahub guidance probe ${Object.values(GUIDANCE_PROBE_USAGE).join(" | ")}`, "person or configured conductor only: bounded T1 declaration and fake-only probe lifecycle; receipts reads the sealed receipts, the outcome denominator and the comparability reasons, read-only; production execution is unavailable"],
    ["ahub guidance create --file JSON [--json]", "record a bounded immutable advisory proposal through current task authority; no activation or probe"],
    ["ahub guidance list --task N --task-created MS [--cursor TOKEN] [--json]", "bounded guidance metadata pages; withdrawn history and withheld fields remain explicit"],
    ["ahub guidance show --task N --task-created MS --id HASH [--json]", "screened editable-section diff selected by existing variant id, never a displayed experiment label"],
    ["ahub guidance withdraw --task N --task-created MS --revision R --id HASH [--json]", "one-way withdrawal using current task flow; retained history never becomes active guidance"],
    ["ahub lineage show (--task N | --attempt ra-id | --root JSON [--task-scope N --task-created MS]) [--cursor TOKEN] [--nodes N --edges N --bytes N] [--json]", "bounded execution metadata and explicit evidence strengths; unavailable stays unknown, with no probes or replay"],
    ["ahub lineage link --task N --task-created MS --revision N --ref JSON [--from JSON] [--json]", "register a declared metadata link through the task's current authority and revision; no producer attestation"],
    ["ahub turns [peer] [--limit N] [--json] [--color=auto|always|never]", "recent turns and the files each changed (a git work tree only)"],
    ["ahub undo <turn> [--yes] [--context]", "put back the files a turn changed; refuses files changed since. Without --yes it only lists them; --context also drops a Codex turn from its conversation"],
    ["ahub report [--since 7d|<iso>] [--by task] [--json] [--color=auto|always|never]", "turns, tokens, messages, overlaps and task events per period"],
    ["ahub report --dogfood [--since 7d|<iso>] [--json]", "read-only scorecard: flow, quality, cost, delivery, performance and adoption; missing evidence is unknown"],
    ["ahub usage [--since 7d|<iso>] [--by peer|task|issue|pr|release|day|model] [--json] [--color=auto|always|never]", "tokens per group from the incremental roll-up: the provider's total with and without cache reads, input, output, reasoning and the hub's own count; each number names its source, unknown is never 0"],
    ["ahub usage limits [--peer <id>] [--limit <n>] [--json] [--color=auto|always|never]", "current quota windows and the history of pauses, resumes and resets"],
    ["ahub usage total [--json] [--color=auto|always|never]", "lifetime development tokens since the first event, per peer and overall"],
    ["ahub export [--since 7d|<iso>]", "structured events (events.jsonl) as JSON lines; never message bodies; the configured conductor gets a bounded projection (last 1000 events)"],
    ["ahub research [--since 30d] [--all] [--json]", "success, first-pass, rework and check-failure rates, tokens and wall time per approved task (cancelled tasks have records too and are not counted), from the opt-in research records"],
    ["ahub research addons [--since 30d] [--all] [--json]", "approved tasks with each add-on (claude-mem, ponytail, ripwire, ...) on against off, with intervals; association, not cause"],
    ["ahub research export [--format jsonl|csv | --dataset <dir>] [--since 30d] [--all]", "the research records for outside analysis: ids, counts and tokens, never text; --dataset writes per-project tasks.jsonl, manifest.json and quality.json (family names only, with each field's unknown count, quota gaps and token attribution share) to a directory in your home outside every project"],
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
    ["ahub memory declined [--json]", "person only: list declined physical outbound row ids and safe rule labels; never shows row text; reports incomplete scans explicitly"],
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
  const native: readonly (readonly [string, string, string?])[] = order.flatMap(kind => (byKind.get(kind)?.cli.usage ?? []).map(([usage, description], index) => [usage, description, index === 0 ? byKind.get(kind)?.cli.summary : undefined] as const));
  const instanceKinds = order.filter(kind => byKind.get(kind)?.instances !== undefined);
  const instances: readonly [string, string] = [`ahub ${instanceKinds.join("|")} --as <instance> [options...]`, "start an extra instance of that kind declared under instances in .agenthub/config.local.json"];
  return SECTIONS.flatMap(([section, rows]) => {
    const entries: readonly (readonly [string, string, string?])[] = section === "Agents" ? [rows[0]!, ...native, ...(instanceKinds.length ? [instances] : []), ...rows.slice(1)] : rows;
    return entries.map(([usage, description, summary]) => ({ section, usage, description, ...(summary ? { summary } : {}) }));
  });
}
export const HELP = helpEntries();

const COMMAND = /^ahub (-{0,2}[a-z][a-z-]*(?: ?\| ?-{0,2}[a-z][a-z-]*)*)/;
/** The command words a usage documents: `ahub pause|resume <peer>` documents pause and resume. */
export function helpCommands(entry: HelpEntry): string[] {
  return COMMAND.exec(entry.usage)?.[1]!.split(/ ?\| ?/) ?? [];
}


/**
 * CLI output standard v1, Help: the overview lists each command once per group as `  <name>  <one-line summary>` in two aligned columns; the long text, every usage form
 * and every flag are in `ahub help <command>`. A summary is at most SUMMARY_MAX cells. A command not named here (the native agents, whose text comes from their
 * adapter definitions, never from a table that names a peer) takes the first clause of its description. `<group>/<command>` wins over `<command>` where one name
 * means two things (`backlog`, `check-path`).
 */
const SUMMARY_MAX = 56;
const SUMMARIES: Readonly<Record<string, string>> = {
  specs: "read design specs and check their freshness", worktrees: "list worktrees, preview and confirm cleanup", "--project": "run a command against another project",
  projects: "list registered projects and live status", setup: "install the plugin and hooks, choose default agents", init: "write .agenthub/config.json and the AGENTS.md block",
  "--live-test": "user-authorized console delegation (person only)", help: "this overview, or one command's usage", version: "print the installed version", completion: "print a shell completion script",
  up: "start the daemon and this project's default agents", console: "open the human console", pet: "read attention without connecting", sdlc: "read lifecycle gates and the next action",
  "Daemon and runtime/backlog": "return accepted untouched work to the backlog", status: "is the hub OK, and what to do next", logs: "show the hub log", doctor: "check tools, daemon, plugin, models and memory",
  agents: "show each agent CLI's version and verdict", kill: "stop this project's hub", down: "stop this project's hub (same as kill)", reset: "discard queued deliveries and clear holds",
  restart: "recover this project's runtime", upgrade: "review and upgrade this project", recovery: "inspect, resume or abort a held operation",
  daemon: "internal: the detached hub process", "recovery-run": "internal: a detached recovery runner",
  role: "read catalog guidance for a role", stop: "stop a hub-owned headless peer", peer: "hand the attached session to a standby", models: "inspect local model state",
  say: "send a message as the console user", watch: "watch a headless ACP peer's activity", tail: "live stream of messages and states", permission: "inspect or set a peer's permission mode",
  permit: "answer a permission request", answer: "list and answer open hub_ask questions", results: "list what your runs left behind", roster: "every known peer and its participation",
  roles: "each peer's flow roles, planner and reviewers", autonomy: "apply the autonomy preset", model: "select or inspect runtime models", settings: "list, read and change settings",
  pause: "hold or release a peer's deliveries", title: "rename a Pi or local-worker session", queue: "inspect and resolve durable deliveries",
  board: "show the task board, import open issues", task: "put tasks on the board and move them along", "Tasks and review/backlog": "plan, pull and return backlog cards", roadmap: "milestones and their computed progress",
  release: "plan and ship releases", smoke: "live smoke test in a temporary project", broker: "run the ciphertext relay for rooms", room: "encrypted rooms between hubs (person only)",
  source: "register inputs as content-hashed sources", schedule: "list and run machine-local schedules", intake: "turn a plain request into a draft backlog card",
  capabilities: "list the skills each attached peer offers", learn: "review recurring-criterion candidates", study: "research campaign contracts",
  deliverables: "what each task delivered and a reviewer approved", review: "give a review verdict on a task", route: "why a task went where it did",
  ask: "answer from the board, memory and the log", remember: "save a note to shared memory", budget: "quota windows per peer and why one is paused",
  guidance: "guidance declarations and the probe lifecycle", lineage: "execution metadata and evidence strengths", turns: "recent turns and the files each changed",
  undo: "put back the files a turn changed", report: "turns, tokens, messages and task events", usage: "tokens per group from the roll-up", export: "events as JSON lines",
  research: "success and rework rates per approved task", bench: "run a benchmark suite against attached peers", "History and reports/check-path": "other owners' open tasks that claim a file",
  memory: "the hub's own project memory", goal: "long-term tasks and who holds them", "Hooks/check-path": "Claude PreToolUse hook for file claims", facts: "Claude hook for turn-free facts",
  ui: "open the local dashboard", manager: "internal: the dashboard manager process",
};
/** The first clause of a description, cut at a word and ended with `...` when it is longer than the column: the whole text is `ahub help <command>`. */
function firstClause(description: string, max: number): string {
  const clause = description.replace(/\s*\([^)]*\)/g, "").split(/;(?= )|\. /)[0]!.trim();
  if (Bun.stringWidth(clause) <= max) return clause;
  // A clause that is too long ends where its sentence first pauses (`:` or `, `) when that leaves a readable summary; otherwise it is cut at a word and ended with `...`.
  const pause = clause.search(/: |, /);
  if (pause >= 8 && Bun.stringWidth(clause.slice(0, pause)) <= max) return clause.slice(0, pause);
  let out = "";
  for (const word of clause.split(" ")) { if (Bun.stringWidth(`${out} ${word}`.trim()) > max - 3) break; out = `${out} ${word}`.trim(); }
  return `${out.replace(/[,:;\s]+$/, "")}...`;
}
/** One overview row: the command words an entry documents (`pause|resume`), and its one-line summary. */
export interface OverviewRow { section: string; name: string; summary: string }
export function helpOverviewRows(entries: readonly HelpEntry[] = HELP): OverviewRow[] {
  const shown = new Map<string, Set<string>>(), rows: OverviewRow[] = [];
  for (const entry of entries) {
    const seen = shown.get(entry.section) ?? shown.set(entry.section, new Set()).get(entry.section)!;
    const fresh = helpCommands(entry).filter(word => !seen.has(word));
    if (!fresh.length) continue;
    fresh.forEach(word => seen.add(word));
    const own = (word: string) => SUMMARIES[`${entry.section}/${word}`] ?? SUMMARIES[word];
    const summary = own(fresh[0]!) ?? entry.summary ?? firstClause(entry.description, SUMMARY_MAX);
    rows.push({ section: entry.section, name: fresh.join("|").replace(/^version\|--version$/, "version|--version"), summary: Bun.stringWidth(summary) > SUMMARY_MAX ? firstClause(summary, SUMMARY_MAX) : summary });
  }
  return rows;
}

/**
 * #1504 T2, one example or more per command that takes arguments: complete, copyable, and only ever a form, subcommand and flag the command's own usage lists
 * (`test/help.test.ts` runs each against the dispatch table and the usage). A native agent's example is derived from its definition's usage, never named here.
 * Internal commands (`daemon`, `recovery-run`, `manager`, `facts`) have none: nobody types them.
 */
export const EXAMPLES: Readonly<Record<string, readonly string[]>> = {
  specs: ["ahub specs check --require-fresh", "ahub specs covers src/cli/help.ts"], worktrees: ["ahub worktrees tidy"], "--project": ["ahub --project ../other-repo status"],
  projects: ["ahub projects --json"], "--live-test": ["ahub --live-test status"], setup: ["ahub setup --agents claude,codex"], init: ["ahub init --profile dev --sdlc advise --dry-run --json"],
  help: ["ahub help task"], completion: ["ahub completion zsh"],
  up: ["ahub up --no-console"], console: ["ahub console --panels"], pet: ["ahub pet --short"],
  sdlc: ["ahub sdlc status 12", "ahub sdlc explain 12 --json"], backlog: ["ahub backlog list --full", "ahub backlog return 12 3 waiting on a spec"],
  status: ["ahub status --verbose"], logs: ["ahub logs -f"], doctor: ["ahub doctor --json"], agents: ["ahub agents --json"],
  reset: ["ahub reset"], restart: ["ahub restart --dry-run"], upgrade: ["ahub upgrade --dry-run"], recovery: ["ahub recovery status"],
  role: ["ahub role list"], stop: ["ahub stop pi"], peer: ["ahub peer takeover codex"], models: ["ahub models status"],
  say: ["ahub say @codex please rebase on main"], watch: ["ahub watch kimi"], permission: ["ahub permission codex ask-when-needed"],
  permit: ["ahub permit 7 deny"], answer: ["ahub answer"], results: ["ahub results --unread"], roster: ["ahub roster --json"], roles: ["ahub roles --json"],
  autonomy: ["ahub autonomy status"], model: ["ahub model list"], settings: ["ahub settings list"], pause: ["ahub pause codex"], resume: ["ahub resume codex"],
  title: ["ahub title pi release review"], queue: ["ahub queue list --peer codex"], board: ["ahub board --ready"],
  task: ["ahub task show 12", "ahub task propose implement Fix the flaky test --path test/a.test.ts"], roadmap: ["ahub roadmap show 3"], release: ["ahub release list"],
  smoke: ["ahub smoke run qwen-dual-output --project-id 1f3a --receipt receipt.json"], broker: ["ahub broker serve --port 8787"], room: ["ahub room list"],
  source: ["ahub source list"], schedule: ["ahub schedule list"], intake: ["ahub intake \"Add a dark mode toggle\""], capabilities: ["ahub capabilities --json"], learn: ["ahub learn list"],
  study: ["ahub study show --json"], deliverables: ["ahub deliverables --task 12 --check"], review: ["ahub review 12 approved looks good", "ahub review brief 12"],
  route: ["ahub route explain 12"], ask: ["ahub ask what blocks task 12"], remember: ["ahub remember Pi 1.5.2 is verified"], budget: ["ahub budget --full"],
  guidance: ["ahub guidance list --task 12 --task-created 1760000000000"], lineage: ["ahub lineage show --task 12"], turns: ["ahub turns codex --limit 5"],
  undo: ["ahub undo 42"], report: ["ahub report --since 7d"], usage: ["ahub usage --by peer --since 7d"], export: ["ahub export --since 7d"], research: ["ahub research --since 30d"],
  bench: ["ahub bench list"], "check-path": ["ahub check-path src/cli/help.ts"], memory: ["ahub memory search sweep"], goal: ["ahub goal list"], ui: ["ahub ui --no-open"],
};
/** Commands nobody types: a process the hub starts, or a hook a tool calls. They have no example. */
export const INTERNAL_COMMANDS: readonly string[] = ["daemon", "recovery-run", "manager", "facts"];

/** One example per native agent, from its own definition: `ahub <kind> --print-command` when its usage has that flag (it prints the launch and starts nothing), else the bare command. */
function nativeExample(command: string, entries: readonly HelpEntry[]): string[] {
  const own = entries.find(entry => entry.section === "Agents" && helpCommands(entry).includes(command) && entry.summary !== undefined);
  return own ? [own.usage.includes("--print-command") ? `ahub ${command} --print-command` : `ahub ${command}`] : [];
}

/** A flag of a command's usages: its value shape as the usage writes it, and the subcommand forms it appears in (empty for the command's base form). */
export interface HelpFlag { flag: string; shape: string; /** `=` or a space: how the usage joins the flag and its value, kept so the Flags line reads as the usage does. */ joiner: "=" | " "; forms: string[] }
const FLAG = /(?<![\w-])(-{1,2}[A-Za-z][A-Za-z0-9-]*)(?:=([^\s\]()]+)| (<[^>]+>|[A-Z][A-Za-z]*\b|N\b|[a-z0-9_,.-]+(?:\|[a-z0-9_,.<>-]+)+))?/g;
/** Every flag the usages of `command` name, in the order they first appear, once each. */
export function helpFlags(command: string, entries: readonly HelpEntry[] = HELP): HelpFlag[] {
  const found = new Map<string, HelpFlag>();
  for (const entry of entries.filter(entry => helpCommands(entry).includes(command))) {
    const prefix = COMMAND.exec(entry.usage)?.[0] ?? "";
    topLevelPieces(entry.usage).forEach((piece, index) => {
      const body = index === 0 ? piece.slice(prefix.length).trim() : piece;
      const token = body.split(/\s/)[0]!.replace(/[\[\]]/g, "");
      const form = token.split("|").filter(word => /^[a-z][a-z0-9-]*$/.test(word)).join("|");
      for (const match of body.matchAll(FLAG)) {
        const flag = match[1]!, shape = match[2] ?? match[3] ?? "", joiner = match[2] !== undefined ? "=" as const : " " as const;
        const seen = found.get(flag) ?? found.set(flag, { flag, shape, joiner, forms: [] }).get(flag)!;
        if (!seen.shape && shape) { seen.shape = shape; seen.joiner = joiner; }
        if (form && !seen.forms.includes(form)) seen.forms.push(form);
      }
    });
  }
  return [...found.values()];
}
/** The two flags the standard itself defines (`docs/design/cli-output.md`, Output and Color); every other flag keeps only what its usage says. */
const FLAG_MEANING: Readonly<Record<string, string>> = {
  "--json": "one JSON document on stdout, never colored",
  "--color": "auto, always or never; auto follows NO_COLOR, FORCE_COLOR and the terminal",
};

const DESCRIPTION = 34;
/**
 * `ahub help <command>` in the standard's shape (#1504): the usage forms, a short description, each flag on one line, examples, then the long text unchanged
 * (every usage form with its whole description) so nothing a form or flag says is lost. Lines are wrapped within `width`.
 */
function renderCommandHelp(width: number, ascii: boolean, command: string, model: readonly HelpEntry[]): Span[][] {
  const entries = model.filter(entry => helpCommands(entry).includes(command));
  if (!entries.length) return [];
  const report = new LayoutReport(width, ascii);
  report.section("Usage");
  for (const entry of entries) {
    const prefix = COMMAND.exec(entry.usage)?.[0] ?? "";
    const text = wrap(entry.usage, width - 2, 4);
    report.append(text.map((line, index): Span[] => index === 0 ? [{ text: "  " }, { text: prefix, role: "accent" }, { text: line.slice(prefix.length) }] : [{ text: "  " + line }]));
  }
  const row = helpOverviewRows(model).find(item => item.name.split("|").includes(command));
  if (row) report.section("Description").note(row.summary, "value");
  const flags = helpFlags(command, model);
  if (flags.length) {
    report.section("Flags", String(flags.length));
    const labels = flags.map(item => item.shape ? `${item.flag}${item.joiner}${item.shape}` : item.flag);
    const column = Math.min(30, Math.max(...labels.map(label => Bun.stringWidth(label)))) + 2;
    flags.forEach((item, index) => {
      const label = labels[index]!, base = item.flag;
      const meaning = FLAG_MEANING[base] ?? (item.forms.length ? `in ${item.forms.length > 3 ? `${item.forms.slice(0, 3).join(", ")} and ${item.forms.length - 3} more` : item.forms.join(", ")}` : "");
      const room = width - 2 - column;
      if (Bun.stringWidth(label) + 2 > column || !meaning) {
        report.append([[{ text: "  " }, { text: label, role: "accent" }]]);
        if (meaning) for (const line of wrap(meaning, width - 2 - column, 0)) report.append([[{ text: " ".repeat(2 + column) + line }]]);
        return;
      }
      const lines = wrap(meaning, room, 0);
      report.append([[{ text: "  " }, { text: label, role: "accent" }, { text: " ".repeat(column - Bun.stringWidth(label)) + lines[0]! }]]);
      for (const line of lines.slice(1)) report.append([[{ text: " ".repeat(2 + column) + line }]]);
    });
  }
  const examples = [...(EXAMPLES[command] ?? []), ...nativeExample(command, model)];
  if (examples.length) {
    report.section("Examples");
    for (const example of examples) report.append(wrap(example, width - 2, 4).map((line, index): Span[] => [{ text: index === 0 ? "  " : "  " }, { text: line, role: index === 0 ? "accent" : "value" }]));
  }
  report.section("Details");
  let section = "";
  for (const entry of entries) {
    if (entry.section !== section) { section = entry.section; report.append([[{ text: `  ${entry.section}`, tone: "strong" }]]); }
    const prefix = COMMAND.exec(entry.usage)?.[0] ?? "";
    const usage = wrap(entry.usage, width - 4, 0);
    const description = wrap(entry.description, width - DESCRIPTION, 0);
    const first: Span[] = [{ text: "  " }, { text: prefix, tone: "info" }, { text: usage[0]!.slice(prefix.length) }];
    if (usage.length === 1 && 2 + Bun.stringWidth(usage[0]!) + 2 <= DESCRIPTION) first.push({ text: " ".repeat(DESCRIPTION - 2 - Bun.stringWidth(usage[0]!)) + description.shift() });
    report.append([first, ...usage.slice(1).map((text): Span[] => [{ text: `    ${text}` }]), ...description.map((text): Span[] => [{ text: " ".repeat(DESCRIPTION) + text }])]);
  }
  return report.lines();
}

/**
 * Without a command, the overview. With one, `ahub help <command>` (renderCommandHelp), wrapped at word boundaries to the terminal width (80 to 100 columns);
 * an unknown command renders nothing.
 */
export function renderHelp(columns: number, color: boolean, command?: string, definitions?: readonly AdapterDefinition[], ascii = false): string {
  const width = Math.min(100, Math.max(80, columns || 80));
  const model = definitions === undefined ? HELP : helpEntries(definitions);
  // The overview is a fixed 80 columns (standard v1, Help): its rows are short, so a wider terminal gains nothing and every terminal reads the same text.
  if (command === undefined) return renderOverview(80, color, ascii, model);
  // #1504: one command is the standard's shape (usage, description, flags, examples) with the long text below it; an unknown command renders nothing.
  return renderCommandHelp(width, ascii, command, model).map(line => paint(line, color)).join("\n");
}

/**
 * `ahub help`: the standard's overview. One intro line, then each group (`▸ Group`) with `  <name>  <summary>` rows in two aligned columns, never wider than the
 * terminal (80 to 100 cells), then where the long text lives. Every command still appears; every usage form and flag is in `ahub help <command>`.
 */
function renderOverview(width: number, color: boolean, ascii: boolean, entries: readonly HelpEntry[]): string {
  const rows = helpOverviewRows(entries), column = Math.max(...rows.map(row => Bun.stringWidth(row.name))) + 2;
  const report = new LayoutReport(width, ascii);
  const out: Span[][] = wrap(`agent-hub ${VERSION}: Claude Code, Codex and Kimi as peers in one project directory`, width, 0).map(text => [{ text }]);
  out.push([{ text: "Usage: ahub <command> [args]   Details: ahub help <command>", role: "hint" }]);
  let section = "";
  for (const row of rows) {
    if (row.section !== section) { section = row.section; report.section(section); }
    const pad = " ".repeat(column - Bun.stringWidth(row.name));
    const summary = wrap(row.summary, width - 2 - column, 0);
    report.append([[{ text: "  " }, { text: row.name, role: "accent" }, { text: `${pad}${summary[0]!}` }]]);
    for (const more of summary.slice(1)) report.append([[{ text: " ".repeat(2 + column) + more }]]);
  }
  report.section("More").note("ahub help <command> shows every usage form and flag of one command; ahub --help and ahub -h print this overview", "value");
  // #1504 AC1: every section title, the first included, follows one blank line. The report only blanks between its own sections, so the gap after the intro lines is added here.
  return [...out, [], ...report.lines()].map(line => paint(line, color)).join("\n");
}

/** Split a usage at its top-level " | " only: a pipe inside [...] or <...> belongs to one alternative (`[--class <c> | <class>]`). */
function topLevelPieces(usage: string): string[] {
  // Blank out each bracketed or angled group (same length), split the blanked text at " | ", and cut the real usage at the same widths.
  const blanked = usage.replace(/\[[^\]]*\]|<[^>]*>|\([^)]*\)/g, group => " ".repeat(group.length));
  const pieces: string[] = [];
  let rest = usage;
  for (const part of blanked.split(" | ")) { pieces.push(rest.slice(0, part.length).trim()); rest = rest.slice(part.length + " | ".length); }
  return pieces;
}

/** The subcommand pieces a command documents, each with the words that name it: `ahub task show <id> | escalate <id>` has show and escalate. */
function subcommandPieces(command: string): { subs: string[]; usage: string }[] {
  return HELP.filter(entry => helpCommands(entry).includes(command)).flatMap(entry => {
    const prefix = COMMAND.exec(entry.usage)?.[0] ?? "";
    return topLevelPieces(entry.usage).map((piece, index) => {
      const body = index === 0 ? piece.slice(prefix.length).trim() : piece;
      const token = body.split(/\s/)[0]!.replace(/[\[\]]/g, "");
      return { subs: token.split("|").filter(word => /^[a-z][a-z0-9-]*$/.test(word)), usage: `ahub ${command} ${body}` };
    });
  });
}

/** #1433: whether the help lists `ahub <command> <sub>`, so `ahub <command> <sub> --help` asks for help instead of running it. Free text is never a listed subcommand: `ahub say try ls -h` stays a message. */
export function listsSubcommand(command: string, sub: string): boolean {
  return subcommandPieces(command).some(piece => piece.subs.includes(sub));
}

/** The documented usage line of one subcommand, for a refusal that names it. */
export function subcommandUsage(command: string, sub: string): string | undefined {
  return subcommandPieces(command).find(piece => piece.subs.includes(sub))?.usage;
}

/** Body-free configured command guidance; no native argv or environment values enter help. */
export function configuredAcpHelp(kind: string): string {
  return `ahub ${kind} [--mode headless] [--as <instance>] [--session-id <id>] [--print-command | --dry-run]\nConfigured ACP runs headless through the hub, with native permissions and NO hub sandbox.\nDeclare it in untracked .agenthub/config.local.json, restart the hub, then enable roster.${kind}.\nPreview withholds native argv and starts nothing. Native/model overrides and --unattended are refused.`;
}
