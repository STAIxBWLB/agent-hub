import { retainedLaunchWarning } from "./native-cli-retained.ts";
import type { NativeCliEntryContext } from "./native-cli-entry-types.ts";

export async function runQwenEntry(ctx: NativeCliEntryContext): Promise<void> {
  const peer = ctx.instance ?? "qwen";
  const { args, cwd, stateDir, unattendedEnv, connect, fail, takeFlags } = ctx;
  const { launcherPreview } = ctx.helpers;
  if (args.includes("--print-command") || args.includes("--dry-run")) {
    try { return console.log(JSON.stringify(launcherPreview("qwen", args, cwd, stateDir, unattendedEnv), null, 2)); }
    catch { fail("cannot preview Qwen launch: invalid arguments or configuration (details withheld)"); }
  }
  const { one, rest } = takeFlags(args, ["--mode", "--model", "--session-id"], []);
  const adapter = ctx.definition;
  if (one["--session-id"] !== undefined && !adapter.session.crashIdentity?.({ sessionId: one["--session-id"] }).sessionId) fail("invalid Qwen session identity");
  if (rest.length || (one["--mode"] !== undefined && !(adapter.start.forms as readonly string[]).includes(one["--mode"]))) fail("Qwen TUI is not offered before verification; usage: ahub qwen [--mode headless] [--model <alias>] [--session-id <id>]");
  const hub = await connect();
  try {
    const snapshot = (await hub.request({ t: "status" })).status;
    const warning = retainedLaunchWarning(snapshot, peer, ctx.definition); if (warning) console.error(warning);
    const reply = await hub.request({ t: "start", peer, args: { mode: "headless", ...(one["--model"] ? { model: one["--model"] } : {}), ...(one["--session-id"] ? { sessionId: one["--session-id"] } : {}) }, operationId: process.env.AGENTHUB_RECOVERY_OPERATION }, 35_000);
    if (!reply.ok) fail(reply.error);
    console.log(reply.already ? `${peer} is already attached` : `${peer} attached (headless); use ahub say @${peer} and the console for approvals`);
  } finally { hub.close(); }
}
