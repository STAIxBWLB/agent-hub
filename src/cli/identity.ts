export type CliIdentity =
  | { role: "console" }
  | { role: "tools"; peer: string }
  | { role: "invalid"; reason: string };

/** Honest defaults for native shells, not authentication against an agent that can edit its environment. */
export function detectCliIdentity(env: Readonly<Record<string, string | undefined>>): CliIdentity {
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
  const native = claude !== undefined ? "claude" : codex !== undefined ? "codex" : undefined;
  if (hub !== undefined && native !== undefined && hub !== native) return invalid("AGENTHUB_PEER_ID conflicts with native agent marker");
  const peer = hub ?? native;
  return peer === undefined ? { role: "console" } : { role: "tools", peer };
}

export type PeerCommandAccess = "allowed" | "conductor" | "console";

/** A closed list: unknown commands cannot acquire console authority through an agent shell. */
export function classifyPeerCommand(command: string, args: readonly string[]): PeerCommandAccess {
  if (command === "permission" || command === "stop") return "console";
  if (args.some((arg) => arg === "--as-user" || arg.startsWith("--as-user="))) return "console";
  if (command === "task") {
    if (["propose", "show"].includes(args[0] ?? "")) return "allowed";
    if (["assign", "escalate"].includes(args[0] ?? "")) return "conductor";
    return "console";
  }
  if (command === "route") return args[0] === "explain" ? "allowed" : "console";
  // #247: reading the research measures and records is harmless (ids and counts only); writing them is a person's.
  if (command === "research") return args[0] === "backfill" ? "console" : "allowed";
  // #251: a run resets the bench project's tree and proposes work; reading results is harmless.
  // The subcommand is the first argument that is not --json, which the command accepts anywhere.
  if (command === "bench") return args.find((arg) => arg !== "--json") === "run" ? "console" : "allowed";
  if (command === "budget") return !args.length || args.every((arg) => arg === "--json" || arg === "--full" || arg.startsWith("--color=")) ? "allowed" : "console";
  if (["claude", "codex", "kimi", "pi", "local", "pause", "resume"].includes(command)) return "conductor";
  if (["help", "version", "--version", "say", "status", "board", "report", "turns", "review", "remember", "facts", "check-path"].includes(command)) return "allowed";
  return "console";
}

/** No argument text is included: notices and refusal logs must not copy task text or credentials. */
export function cliCommandLabel(command: string, args: readonly string[]): string {
  if (!["upgrade", "restart", "recovery", "recovery-run", "help", "--help", "--version", "version", "projects", "ui", "manager", "setup", "init", "daemon", "up", "console", "claude", "codex", "kimi", "pi", "local", "stop", "models", "say", "queue", "tail", "budget", "board", "task", "review", "remember", "ask", "route", "pause", "resume", "permit", "permission", "status", "logs", "export", "report", "research", "bench", "facts", "check-path", "turns", "undo", "kill", "reset", "doctor"].includes(command)) return "unknown";
  if (["task", "queue", "budget", "route", "recovery", "models", "projects", "research", "bench"].includes(command)) {
    const sub = command === "bench" ? args.find((arg) => arg !== "--json") : args[0];
    if (sub && ["propose", "show", "assign", "escalate", "label", "list", "resolve", "resume", "set", "execution", "explain", "status", "abort", "dispose", "setup", "start", "stop", "remove", "export", "backfill", "run", "report", "compare"].includes(sub)) return `${command} ${sub}`;
  }
  return (/^[a-z][a-z0-9-]*$/.test(command) && !/\s/.test(command)) || ["--help", "--version"].includes(command) ? command : "unknown";
}

export function peerCommandRefusal(peer: string, command: string): string {
  return `${peer} cannot run ahub ${command}; the person runs it in ahub console or a terminal`;
}
