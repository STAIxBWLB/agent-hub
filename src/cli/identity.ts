import { conductorOperation, OPERATIONAL_PERSON_GUIDANCE } from "../hub/operational-authority.ts";
import { nativeCliMarkerPeer } from "../adapters/definitions/native-identity-defaults.ts";
import { recoveryPresentationFlag } from "./recovery-presentation-options.ts";
import { definitionOf, kindOf, type KindMap, type ProjectAdapterCatalog } from "../adapters/registry.ts";

/** Recovery reads this declaration before delegating to another package's CLI. */
export const LIVE_TEST_SUPPORTED = true;

/** Presentation prefixes cannot hide a person's recovery action from authorization. */
function recoveryAction(args: readonly string[]): string | undefined {
  return args.find(arg => !recoveryPresentationFlag(arg));
}

export const LIVE_TEST_PERSON_REFUSAL = "live-test cannot write person-attributed content; use peer tools or a person's terminal";

/** Person verdicts and user-authored workflow content are never delegated. */
export function liveTestRefusal(command: string, args: readonly string[], context: { repairedFresh?: boolean } = {}): boolean {
  if (command === "sdlc" && (args[0] === "authorize-release" || args[0] === "plan-review" || args[0] === "release-assign" || args[0] === "merge" || args[0] === "train" && args[1] !== "report")) return true;
  if (args.some(arg => arg === "--as-user" || arg.startsWith("--as-user="))) return true;
  const sub = command === "recovery" ? recoveryAction(args) : args.find(arg => arg !== "--json");
  return ["task", "role", "goal", "deliverables"].includes(command)
    || (command === "backlog" && sub !== "list") || (command === "release" && !["list", "show"].includes(sub ?? ""))
    || (command === "memory" && sub !== "graph")
    || (command === "recovery" && (sub === "reattach" || sub === "dispose" && context.repairedFresh === true))
    || (command === "board" && args[0] === "import") || (command === "sdlc" && (args[0] === "record" || args[0] === "accept" || args[0] === "accept-departure"))
    || (command === "bench" && args.find(arg => arg !== "--json") === "run") || command === "pet"
    // #691: trusting an untested agent CLI version is the person's consent, never a delegated live-test operation.
    || (command === "agents" && !args.every(arg => arg === "--json"));
}

export type CliIdentity =
  | { role: "console" }
  | { role: "tools"; peer: string }
  | { role: "invalid"; reason: string };

/** Honest defaults for native shells, not authentication against an agent that can edit its environment. */
export function detectCliIdentity(env: Readonly<Record<string, string | undefined>>, instances?: KindMap): CliIdentity {
  const hub = env.AGENTHUB_PEER_ID;
  const claude = env.CLAUDECODE;
  const session = env.CLAUDE_CODE_SESSION_ID;
  const codex = env.CODEX_THREAD_ID;
  const invalid = (reason: string): CliIdentity => ({ role: "invalid", reason });
  if (hub !== undefined && (!/^[a-z][a-z0-9-]{0,31}$/.test(hub) || /\s/.test(hub) || ["user", "hub", "digest"].includes(hub))) return invalid("invalid AGENTHUB_PEER_ID marker");
  if (claude !== undefined && claude !== "1") return invalid("invalid CLAUDECODE marker");
  if (session !== undefined && (!session || /\s/.test(session))) return invalid("invalid CLAUDE_CODE_SESSION_ID marker");
  if (codex !== undefined && (!codex || /\s/.test(codex))) return invalid("invalid CODEX_THREAD_ID marker");
  if (session !== undefined && claude === undefined) return invalid("CLAUDE_CODE_SESSION_ID without CLAUDECODE marker");
  if (claude !== undefined && codex !== undefined) return invalid("conflicting native agent markers");
  const native = nativeCliMarkerPeer(claude !== undefined, codex !== undefined);
  if (hub !== undefined && native !== undefined && (kindOf(hub, instances) ?? hub) !== native) return invalid("AGENTHUB_PEER_ID conflicts with native agent marker");
  const peer = hub ?? native;
  return peer === undefined ? { role: "console" } : { role: "tools", peer };
}

export type PeerCommandAccess = "allowed" | "conductor" | "console";

/** A closed list: unknown commands cannot acquire console authority through an agent shell. */
export function classifyPeerCommand(command: string, args: readonly string[], catalog?: ProjectAdapterCatalog): PeerCommandAccess {
  if (command === "recovery" && recoveryAction(args) === "reattach") return "console";
  const native = catalog?.definitionOf(command) ?? definitionOf(command);
  if (native?.cli.personOnlyFlags?.some(flag => args.includes(flag))) return "console";
  if (command === "pet" && args.includes("--window")) return "console";
  if (command === "permission" || command === "watch") return "console";
  if (args.some((arg) => arg === "--as-user" || arg.startsWith("--as-user="))) return "console";
  if (conductorOperation(command,args)) return "conductor";
  if (command === "stop") return "console";
  if (command === "sdlc" && ["release-guard", "release-guard-hook"].includes(args[0] ?? "")) return "allowed";
  // #786: the guarded merge is the person's or the configured conductor's; the daemon refuses any other peer by role.
  if (command === "sdlc" && args[0] === "merge") return "conductor";
  if (command === "role") return ["list", "show"].includes(args[0] ?? "") ? "allowed" : "console";
  if (command === "task") {
    if (["propose", "show"].includes(args[0] ?? "")) return "allowed";
    if (["assign", "escalate"].includes(args[0] ?? "")) return "conductor";
    return "console";
  }
  // #317: the deliverable list is the person's view of the board (it can name files); an agent reads its own tasks through hub_task_show.
  if (command === "deliverables") return "console";
  if (command === "route") return args[0] === "explain" ? "allowed" : "console";
  // #691: reading agent CLI versions is harmless; trusting an untested version on this machine is a person's.
  if (command === "agents") return args.every(arg => arg === "--json") ? "allowed" : "console";
  // #247: reading the research measures and records is harmless (ids and counts only); writing them is a person's.
  if (command === "research") return args[0] === "backfill" ? "console" : "allowed";
  // #258: reading hub memory is harmless; promote, demote, forget, supersede and rebuild are a person's.
  if (command === "memory") { const sub = args.find((arg) => arg !== "--json"); return sub === undefined || sub.startsWith("--") || ["list", "search", "show", "suggestions"].includes(sub) || (sub === "machine" && !args.includes("--label")) ? "allowed" : "console"; } // graph labels are unscreened note text: a person's
  if (command === "goal") { const sub = args.find((arg) => arg !== "--json"); return sub === undefined || sub.startsWith("--") || ["list", "show"].includes(sub) ? "allowed" : "console"; }
  // #251: a run resets the bench project's tree and proposes work; reading results is harmless.
  // The subcommand is the first argument that is not --json, which the command accepts anywhere.
  if (command === "bench") return args.find((arg) => arg !== "--json") === "run" ? "console" : "allowed";
  if (command === "budget") return !args.length || args.every((arg) => arg === "--json" || arg === "--full" || arg.startsWith("--color=")) ? "allowed" : "console";
  if (native?.cli.authority === "person") return "console";
  if (native || ["pause", "resume"].includes(command)) return "conductor";
  if (command === "board" && args[0] === "import") return "console";
  if (["help", "version", "--version", "completion", "say", "status", "pet", "board", "report", "usage", "turns", "review", "remember", "facts", "check-path"].includes(command)) return "allowed";
  return "console";
}

/** No argument text is included: notices and refusal logs must not copy task text or credentials. */
export function cliCommandLabel(command: string, args: readonly string[], catalog?: ProjectAdapterCatalog): string {
  if (command === "backlog") return ["list", "add", "pull", "pull-ready", "split", "return", "plan", "pin", "undo"].includes(args[0] ?? "") ? `backlog ${args[0]}` : "backlog";
  if (command === "board" && args[0] === "import") return "board import";
  if (command === "release") return ["new", "list", "show", "plan", "activate", "freeze", "ship", "drop"].includes(args[0] ?? "") ? `release ${args[0]}` : "release";
  if (!(catalog?.definitionOf(command) ?? definitionOf(command)) && !["upgrade", "restart", "recovery", "recovery-run", "help", "--help", "--version", "version", "completion", "projects", "ui", "manager", "setup", "init", "daemon", "up", "console", "stop", "models", "say", "queue", "tail", "watch", "budget", "board", "task", "review", "remember", "ask", "route", "pause", "resume", "permit", "permission", "settings", "roster", "status", "pet", "logs", "export", "report", "research", "memory", "goal", "bench", "sdlc", "role", "facts", "check-path", "turns", "undo", "kill", "reset", "doctor", "agents"].includes(command)) return "unknown";
  if (["task", "queue", "budget", "route", "recovery", "models", "projects", "research", "memory", "goal", "bench", "agents", "roster", "settings"].includes(command)) {
    const sub = command === "bench" || command === "memory" || command === "goal" ? args.find((arg) => arg !== "--json") : args[0];
    if (sub && ["propose", "show", "assign", "unassign", "escalate", "cancel", "label", "list", "add", "resolve", "resume", "set", "execution", "explain", "status", "abort", "dispose", "reattach", "setup", "start", "stop", "remove", "discard", "export", "backfill", "addons", "run", "report", "compare", "search", "graph", "promote", "demote", "forget", "supersede", "dedupe", "decay", "rebuild", "sync", "machine", "import", "suggestions", "confirm", "reject", "new", "link", "state", "done", "take", "trust"].includes(sub)) return `${command} ${sub}`;
  }
  return (/^[a-z][a-z0-9-]*$/.test(command) && !/\s/.test(command)) || ["--help", "--version"].includes(command) ? command : "unknown";
}

/**
 * #711: a hub refusal that only the person or the task's own reviewer could have avoided ("only its reviewer (user) or the console user can do that",
 * "only the person may ..."). The wording is the hub's, so this reads it and never invents it: anything else gets no extra line.
 */
export const personOnlyRefusal = (error: string): boolean => /\bonly\b[^.]*\b(?:console user|the person)\b/i.test(error);

/**
 * #711: the extra stderr line for an agent shell that was refused something only the person may do. The refusal itself and the authority are unchanged: this only
 * says why the shell was treated as an agent and where to act as the person. `undefined` for the console identity and for any refusal that is not person-only.
 */
export function agentShellCause(identity: CliIdentity, error: string, env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  if (identity.role !== "tools" || !personOnlyRefusal(error)) return undefined;
  const markers = ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"].filter(name => env[name] !== undefined);
  const set = markers.length ? `${markers.join(" and ")} ${markers.length === 1 ? "is" : "are"} set` : "an agent marker is set";
  const task = /\btask #(\d+)\b/.exec(error)?.[1];
  return `This shell runs as agent "${identity.peer}" (${set}), not as you. Run the command in your own terminal, or use the ahub console: ${task ? `Tasks, select #${task}, r` : "Tasks, select the task, r"}.`;
}

export function peerCommandRefusal(peer: string, command: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const markers = ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "AGENTHUB_PEER_ID", "CODEX_THREAD_ID"].filter(name => env[name] !== undefined);
  return `${peer} cannot run ahub ${command}; ${OPERATIONAL_PERSON_GUIDANCE}. Refused because inherited agent markers${markers.length ? ` (${markers.join(", ")})` : ""} identify this shell as an agent. A ! command in an agent session runs as that agent; use a separate terminal outside the agent session`;
}
