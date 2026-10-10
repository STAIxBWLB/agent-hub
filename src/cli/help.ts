import { VERSION } from "../version.ts";
import { paint, wrap, type Span } from "./console-state.ts";

/** One usage form of `ahub help`: the usage starts with `ahub <command>`, alternatives joined by `|`. */
export interface HelpEntry { section: string; usage: string; description: string }

const SECTIONS: [string, [usage: string, description: string][]][] = [
  ["Projects", [
    ["ahub --project <path|id> <command>", "select a repository or worktree explicitly"],
    ["ahub projects [--json]", "list registered projects and live status"],
    ["ahub projects remove <id>", "forget a stopped registration (keeps project files)"],
    ["ahub setup [--yes]", "install or update the Claude Code channel plugin from this package, then run doctor"],
    ["ahub init [--dry-run --json]", "preview or write .agenthub/config.json and the AGENTS.md marker block (drops a legacy CLAUDE.md block)"],
    ["ahub help [command]", "this help, or one command's entries; also --help and -h"],
    ["ahub version | --version", "print the installed version"],
  ]],
  ["Daemon and runtime", [
    ["ahub up [--unattended] [--no-console]", "start the daemon; interactive terminals enter console"],
    ["ahub console [--panels] [--color=auto|always|never]", "enter the human console, leaving the daemon running on exit"],
    ["ahub status", "the hub, its peers, model backends and task counts"],
    ["ahub status --all", "show every registered project"],
    ["ahub logs [-f]", "the last 100 lines of hub.log; -f shows the last 10 and follows it"],
    ["ahub doctor", "check the tools, daemon, plugin, gateway, models and memory worker this project uses"],
    ["ahub doctor --orphans [--kill]", "list registrations whose project root is gone; --kill stops their daemons (SIGTERM, then SIGKILL) only after the process identity checks out"],
    ["ahub kill", "stop this project's hub"],
    ["ahub reset [--all] [--yes]", "list, then with --yes stop the hub and discard every queued and needs_review delivery, clear holds and pauses and drop session pointers; --all moves the state directory to .agenthub/archive instead"],
    ["ahub restart [--dry-run] [--yes]", "recover this project's runtime; on a terminal without a flag it reviews the plan with you, follows the progress and offers the next steps"],
    ["ahub upgrade [--to <version>] [--dry-run] [--yes]", "review and upgrade running projects; --to defaults to the latest release (--yes needs it), and a newer release's own coordinator takes over; on a terminal without --dry-run or --yes: review, end agents first if you choose, apply, follow, and resume, cancel, end or reset on the spot"],
    ["ahub recovery [status|resume|abort] [<operation-id>]", "inspect, resume or cancel a preflight; status names the next actions; without an id, the operation that holds the lock, and with nothing else on a terminal its screen"],
    ["ahub recovery dispose [<operation-id>] --fresh-session codex|claude --reason <text>", "end a partial operation by starting that peer as a new session, recording the lost conversation"],
    ["ahub recovery dispose [<operation-id>] --stop-and-archive --reason <text>", "end a partial operation: stop its own targets, archive its snapshot and release the lock; the upgrade is abandoned, not completed"],
    ["ahub daemon [--unattended]", "internal: the detached hub process that ahub up or the dashboard manager starts"],
    ["ahub recovery-run <operation-id>", "internal: the detached runner of an upgrade, restart or recovery resume"],
  ]],
  ["Agents", [
    ["ahub claude [--print-command] [--unattended] [args...]", "launch Claude Code with the hub channel"],
    ["ahub codex [--print-command] [--unattended] [args...]", "start the Codex adapter and attach the TUI"],
    ["ahub kimi [--print-command] [--model <alias>]", "start Kimi headless under ACP"],
    ["ahub pi [--print-command] [--mode headless|tui | --headless] [--backend auto|dgx|mlx] [--session-id <id>] [--session-file <path>]", "start Pi: its TUI in this terminal unless --headless or the start mode setting (peers.pi.start_mode) says headless; without a terminal the hub opens one or says how"],
    ["ahub local [--route <id> | --model <id>]", "start the hub-native worker on the self-hosted models (routing.toml)"],
    ["ahub stop <peer>", "human only: stop a hub-owned headless peer; end TUI agents in their terminals"],
    ["ahub models setup|status|start|stop", "prepare or inspect local Ollama MLX (legacy stop is explicit)"],
  ]],
  ["Messages and approvals", [
    ["ahub say [@peer ...] <text>", "send as the console user (no @peer = broadcast); delivered at once, start the text with [STATUS] to let it batch or [FYI] for the record only"],
    ["ahub tail", "live stream of messages, states and permission requests"],
    ["ahub permission [<peer> [ask|ask-when-needed|never-ask]] [--yes]", "human only: inspect or set a running peer mode; never-ask requires --yes; config never-ask waits for console y"],
    ["ahub permit <id> <option>", "answer a permission request shown by tail (\"deny\" cancels)"],
    ["ahub settings [list] [--json] | get <key>", "human only: the settings the dashboard can change, each with its value, the file it comes from and when it applies"],
    ["ahub settings set <key> <value|inherit> [--yes] [--preview] | undo", "human only: change one, written to .agenthub/config.local.json or routing.local.toml (never a tracked file); --preview shows the effect and saves nothing; undo puts back the last write"],
    ["ahub pause|resume <peer>", "hold a peer's deliveries in its queue / release them"],
    ["ahub queue list [--peer <id>] [--json]", "inspect durable deliveries"],
    ["ahub queue show <delivery-id>", "inspect one delivery and revision"],
    ["ahub queue resolve <delivery-id> --action completed|retry|discard --reason <text>", "release a delivery held as needs_review: mark it completed, retry it or discard it"],
  ]],
  ["Tasks and review", [
    ["ahub board [state | --ready]", "the task board; --ready: proposed tasks with nothing left to wait for"],
    ["ahub task propose [--class <c> | <class>] <title...> [--owner <peer>] [--path <p>]... [--after <id>]... [--urgent] [--detail <text>]", "put a task on the board; a first word that names a class is taken as the class; while a task named by --after is not approved yet, --owner reserves the task for that peer, offered to it first once it is ready; otherwise --owner assigns it now"],
    ["ahub task show|escalate <id>", "full task with history (PII text included) / hand it to the next peer in escalate_to"],
    ["ahub task assign <id> <peer>", "give a task to a peer yourself; a task that still waits is reserved for that peer instead"],
    ["ahub task label <id> ok|regressed|reverted|incomplete|wrong|abandoned", "your later verdict on an approved task, kept in the research records (research must be on)"],
    ["ahub review <id> approved|changes_requested [note...] [--unmet <item>]...", "give a review verdict on a task"],
    ["ahub route explain <id>", "why a task went where it went, its reserved owner included"],
    ["ahub route explain --class <c> <title...>", "what would happen to such a task now"],
    ["ahub ask [--remember] <question...>", "answer from the task board, shared memory and this run's log, with the ids it rests on"],
    ["ahub remember <text...>", "save a note to the memory all agents share"],
  ]],
  ["Budget", [
    ["ahub budget", "quota windows per peer, and who is paused until when"],
    ["ahub budget set <peer> <0..1> [--resets-in 30m] [--window 5h|week]", "feed a reading by hand (also: test the relay)"],
    ["ahub budget resume <peer>", "override a budget pause; readings are ignored for that peer until the window resets"],
    ["ahub budget execution configure <config.json> | status [id] | disable <id>", "opt-in limits on model calls, tool calls, time and tokens for pi and local"],
  ]],
  ["History and reports", [
    ["ahub turns [peer] [--limit N]", "recent turns and the files each changed (a git work tree only)"],
    ["ahub undo <turn> [--yes] [--context]", "put back the files a turn changed; refuses files changed since. Without --yes it only lists them; --context also drops a Codex turn from its conversation"],
    ["ahub report [--since 7d|<iso>] [--by task] [--json]", "turns, tokens, messages, overlaps and task events per period"],
    ["ahub export [--since 7d|<iso>]", "structured events (events.jsonl) as JSON lines; never message bodies"],
    ["ahub research [--since 30d] [--all] [--json]", "success, first-pass, rework and check-failure rates, tokens and wall time per approved task, from the opt-in research records"],
    ["ahub research export [--format jsonl|csv] [--since 30d] [--all]", "the research records for outside analysis: ids, counts and tokens, never text"],
    ["ahub research backfill", "build this project's research records once from events.jsonl"],
    ["ahub bench run <suite.json> --arm <label> [--repeat N] [--tasks a,b]", "run a benchmark suite against the peers attached here, in a project kept for benchmarks (it resets the work tree)"],
    ["ahub bench list|status", "benchmark runs on this machine / the one running now"],
    ["ahub bench report <run> [--json]", "pass rate, first pass, rework, tokens and wall time per task and overall"],
    ["ahub bench compare <run|arm>... [--suite <name>] [--mixed] [--json]", "compare arms of one suite with 95% bootstrap intervals; inconclusive below 5 counted attempts per arm"],
    ["ahub bench export [--format jsonl|csv]", "benchmark records for outside analysis: ids, outcomes and counts, never suite text"],
    ["ahub check-path <file> [--peer <id>]", "other owners' open tasks that claim or changed a file"],
  ]],
  ["Hooks", [
    ["ahub check-path --hook", "check-path as a Claude Code PreToolUse hook (templates/claude-hooks.json); never blocks"],
    ["ahub facts --hook", "turn-free facts as a Claude Code PreToolUse, PostToolUse and Stop hook (issue #108); never blocks"],
  ]],
  ["Dashboard", [
    ["ahub ui [--no-open]", "open the local dashboard (or print its one-time link)"],
    ["ahub ui --settings [--no-open]", "human only: open it with a settings session, which for 15 minutes may change permission modes, routing and start settings"],
    ["ahub ui --all [--no-open]", "open the unified project dashboard"],
    ["ahub ui --all --stop", "stop only the dashboard manager"],
    ["ahub manager", "internal: the dashboard manager process that ahub ui --all starts"],
  ]],
];
export const HELP: readonly HelpEntry[] = SECTIONS.flatMap(([section, rows]) => rows.map(([usage, description]) => ({ section, usage, description })));

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
export function renderHelp(columns: number, color: boolean, command?: string): string {
  const width = Math.min(100, Math.max(80, columns || 80));
  const entries = command === undefined ? HELP : HELP.filter(entry => helpCommands(entry).includes(command));
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
