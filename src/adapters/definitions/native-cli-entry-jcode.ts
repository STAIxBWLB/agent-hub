import { resolve } from "node:path";
import type { NativeCliEntryContext } from "./native-cli-entry-types.ts";
import { rosterInStatus } from "../../hub/roster.ts";

export async function runJcodeEntry(ctx: NativeCliEntryContext): Promise<void> {
  const { args, cwd, stateDir, cliDir, unattendedEnv, connect, fail, takeFlags } = ctx;
  const { launcherPreview, qwenSessionId, configureJcodeMcp } = ctx.helpers;
  if (args.includes("--print-command") || args.includes("--dry-run")) {
    try { return console.log(JSON.stringify(launcherPreview("jcode", args, cwd, stateDir, unattendedEnv), null, 2)); }
    catch { fail("cannot preview Jcode launch: invalid arguments or configuration (details withheld)"); }
  }
  const { one, rest } = takeFlags(args, ["--mode", "--model", "--provider-profile", "--session-id"], []);
  if (rest.length || (one["--mode"] !== undefined && one["--mode"] !== "headless")) fail("usage: ahub jcode [--mode headless] [--model <alias>] [--provider-profile <name>] [--session-id <id>]");
  if (one["--session-id"] !== undefined && !qwenSessionId(one["--session-id"])) fail("invalid Jcode session identity");
  const hub = await connect();
  try {
    const snapshot = (await hub.request({ t: "status" })).status;
    const rostered = rosterInStatus(snapshot, "jcode");
    if (rostered === undefined) fail("cannot read jcode's roster membership from the running hub; upgrade or restart it, then retry (nothing was started)");
    if (!rostered) fail("jcode is off roster; add it with ahub roster add jcode");
    const written = configureJcodeMcp(cwd, stateDir, resolve(cliDir, "../../plugins/agent-hub/server.js"));
    if (written.tracked) console.error(".jcode/mcp.json is tracked; review this local machine-path change before committing it");
    const reply = await hub.request({ t: "start", peer: "jcode", args: { mode: "headless", model: one["--model"], providerProfile: one["--provider-profile"], sessionId: one["--session-id"] }, operationId: process.env.AGENTHUB_RECOVERY_OPERATION }, 65_000);
    if (!reply.ok) fail(reply.error);
    console.log(reply.already ? "jcode is already attached" : "jcode attached (headless); native policy unmanaged, NO hub sandbox");
  } finally { hub.close(); }
}
