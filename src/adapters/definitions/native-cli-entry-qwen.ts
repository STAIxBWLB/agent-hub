import { retainedLaunchWarning } from "./native-cli-retained.ts";
import type { NativeCliEntryContext } from "./native-cli-entry-types.ts";

function verifiedLaunch(value: unknown): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } | undefined {
  const launch = value as { cmd?: unknown; args?: unknown; env?: unknown } | undefined;
  if (!launch || typeof launch.cmd !== "string" || !launch.cmd || !Array.isArray(launch.args) || !launch.args.every((word: unknown) => typeof word === "string") || !launch.env || typeof launch.env !== "object" || Array.isArray(launch.env)) return undefined;
  return { cmd: launch.cmd, args: launch.args as string[], env: launch.env as NodeJS.ProcessEnv };
}

export async function runQwenEntry(ctx: NativeCliEntryContext): Promise<void> {
  const peer = ctx.instance ?? "qwen";
  const { args, cwd, stateDir, unattendedEnv, connect, fail, takeFlags, execWithEnv } = ctx;
  const { launcherPreview } = ctx.helpers;
  if (args.includes("--print-command") || args.includes("--dry-run")) {
    try { return console.log(JSON.stringify(launcherPreview("qwen", args, cwd, stateDir, unattendedEnv), null, 2)); }
    catch { fail("cannot preview Qwen launch: invalid arguments or configuration (details withheld)"); }
  }
  const { one, rest } = takeFlags(args, ["--mode", "--model", "--session-id"], []);
  const adapter = ctx.definition;
  const usage = "usage: ahub qwen [--mode headless|tui] [--model <alias>] [--session-id <id>]";
  if (one["--session-id"] !== undefined && !adapter.session.crashIdentity?.({ sessionId: one["--session-id"] }).sessionId) fail("invalid Qwen session identity");
  if (rest.length || (one["--mode"] !== undefined && !["headless", "tui"].includes(one["--mode"]))) fail(usage);
  const mode = one["--mode"] === "tui" ? "tui" : "headless";
  if (mode === "tui" && ctx.instance) fail("extra Qwen instances require headless mode");
  if (mode === "tui" && !(process.stdin.isTTY && process.stdout.isTTY)) fail("Qwen's TUI needs a terminal: run ahub qwen --mode tui in one, or use --mode headless");
  const hub = await connect();
  let launch: unknown;
  try {
    const snapshot = (await hub.request({ t: "status" })).status;
    const warning = retainedLaunchWarning(snapshot, peer, ctx.definition); if (warning) console.error(warning);
    const reply = await hub.request({ t: "start", peer, args: { mode, ...(one["--model"] ? { model: one["--model"] } : {}), ...(one["--session-id"] ? { sessionId: one["--session-id"] } : {}) }, operationId: process.env.AGENTHUB_RECOVERY_OPERATION }, 35_000);
    if (!reply.ok) fail(reply.error);
    if (mode === "tui") {
      if (reply.already) return console.log("qwen is already attached (its TUI is running); use that terminal");
      if (reply.adopted) return console.log("qwen: the hub read on from its saved position; the Qwen terminal it was driving is still running");
      launch = reply.launch;
    } else console.log(reply.already ? `${peer} is already attached` : `${peer} attached (headless); use ahub say @${peer} and the console for approvals`);
  } finally { hub.close(); }
  if (mode !== "tui") return;
  const verified = verifiedLaunch(launch);
  if (!verified) return fail("Qwen TUI launch metadata was not verified");
  // The daemon's launch env carries only the peer marker: Qwen runs in the person's own terminal and needs their PATH, HOME (its settings and sessions) and the key its provider
  // names, none of which the daemon may copy. So the person's environment is the base and the daemon's marker goes over it. (Measured: without this the exec found no `qwen`.)
  const env = { ...process.env, ...verified.env };
  delete env.AGENTHUB_RECOVERY_OPERATION; delete env.AGENTHUB_UNATTENDED;
  console.error("Qwen runs in this terminal, driven by the hub through its dual-output files. Limits: a hub deny ends the turn without an answer, and a stalled turn is stopped only by pressing Esc here.");
  return execWithEnv(verified.cmd, verified.args, env);
}
