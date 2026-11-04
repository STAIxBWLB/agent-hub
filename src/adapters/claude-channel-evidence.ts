import { spawnSync } from "node:child_process";

export type ClaudeChannelEvidence = "development-channel-launch" | "inherited-marker" | "launch-unverified" | "unknown" | "unreported";
export type ClaudeAttachMode = "channel" | "tools-only";

/** Internal host-observer seam; tests may replace only the raw process row. */
export const claudeParentCommandPort: { read: (ppid: number) => string | undefined } = { read: readClaudeParentCommand };

const TARGETS = new Set(["plugin:agent-hub@agent-hub", "server:agent-hub"]);
const DISABLING = new Set(["-p", "--print", "--output-format", "--background", "--detach", "--daemon", "daemon", "bg", "bg-spare"]);

// ponytail: current native launches expose only a flattened direct-parent argv row; this does not prove registration or authenticate the host. Replace it with an explicit per-server client opt-in when Claude publishes one.
/** Classify a flattened `ps` command only when its leading argv tokens are unambiguous. */
export function classifyClaudeParentCommand(command: string): ClaudeChannelEvidence {
  if (!command || command.length > 4096 || /[\n\r\0]/.test(command)) return "launch-unverified";
  const argv = command.trim().split(/\s+/);
  const executable = argv[0]?.split("/").at(-1);
  if (executable !== "claude" || argv.length < 3 || argv[1] !== "--dangerously-load-development-channels" || !TARGETS.has(argv[2]!)) return "launch-unverified";
  // The channel flag is ignored by print/background/daemon forms. A later repeated
  // flag can change the selected channels, so those commands fail closed as well.
  if (argv.slice(3).some(arg => DISABLING.has(arg) || arg.startsWith("--print=") || arg.startsWith("--output-format=") || arg.startsWith("-p") || arg === "--dangerously-load-development-channels" || arg.startsWith("--dangerously-load-development-channels="))) return "launch-unverified";
  return "development-channel-launch";
}

function readClaudeParentCommand(ppid: number): string | undefined {
  try {
    const result = spawnSync("/bin/ps", ["-ww", "-p", String(ppid), "-o", "command="], {
      encoding: "utf8", timeout: 1500, maxBuffer: 4096,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== "string" || !result.stdout.trim() || result.stdout.trim().includes("\n")) return undefined;
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

/** The plugin's direct parent is Claude Code. Failure to read its bounded process row is unknown. */
export function claudeChannelEvidence(env: NodeJS.ProcessEnv = process.env, ppid = process.ppid, read: (pid: number) => string | undefined = claudeParentCommandPort.read): ClaudeChannelEvidence {
  if (env.AGENTHUB_CHANNEL !== "1") return "unknown";
  if (!Number.isSafeInteger(ppid) || ppid <= 1) return "unknown";
  try {
    const command = read(ppid);
    if (!command || process.ppid !== ppid) return "unknown";
    return classifyClaudeParentCommand(command);
  } catch { return "unknown"; }
}

/** Tests may substitute the raw parent row, but this function always checks the inherited marker and classifier. */
export function currentClaudeChannelEvidence(): ClaudeChannelEvidence {
  return claudeChannelEvidence();
}

