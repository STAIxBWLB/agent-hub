import { retainedLaunchWarning } from "./native-cli-retained.ts";
import { resolve } from "node:path";
import type { NativeCliEntryContext } from "./native-cli-entry-types.ts";
import type { ControlClient } from "../../hub/control-client.ts";
import type { JcodeTuiBinding, JcodeTuiState } from "../jcode.ts";
import { bundleInStatus, rosterInStatus } from "../../hub/status-roster.ts";

const WAITING = "jcode's TUI opens after its first hub turn; send it work, or Ctrl-C";

export async function waitForJcodeTui(hub: ControlClient, fail: NativeCliEntryContext["fail"], signal: AbortSignal,
  options: Record<string, string | undefined>, first?: JcodeTuiState): Promise<Extract<JcodeTuiState, { state: "ready" }> | undefined> {
  let binding: JcodeTuiBinding | undefined = first?.binding, announced = false, current = first;
  while (!signal.aborted) {
    if (!current) {
      const reply = await hub.request({ t: "native_tui_launch", peer: "jcode", binding, args: options });
      if (signal.aborted) return;
      if (!reply.ok || !reply.binding || !["waiting", "ready"].includes(reply.state)) fail("Jcode launch changed or its native saved session is unavailable; retry from a terminal");
      current = reply as JcodeTuiState;
    }
    if (binding && (binding.launchId !== current.binding.launchId || binding.sessionId !== current.binding.sessionId)) fail("Jcode launch changed while waiting");
    binding = current.binding;
    if (current.state === "ready") return current;
    if (!announced) { console.log(WAITING); announced = true; }
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, 200); signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
    });
    current = undefined;
  }
}

export async function runJcodeEntry(ctx: NativeCliEntryContext): Promise<void> {
  const { args, cwd, stateDir, cliDir, unattendedEnv, connect, fail, takeFlags } = ctx;
  const { launcherPreview, qwenSessionId, configureJcodeMcp, readControl, startModeOf } = ctx.helpers;
  const print = args.includes("--print-command");
  if (args.includes("--dry-run") || print) {
    // Pure previews never create a native store or start a session. Only a person may resolve an existing private tuple.
    if (!print || args.includes("--dry-run") || !ctx.person) {
      try { return console.log(JSON.stringify(launcherPreview("jcode", args, cwd, stateDir, unattendedEnv), null, 2)); }
      catch { fail("cannot preview Jcode launch: invalid arguments or configuration (details withheld)"); }
    }
  }
  const { one, rest } = takeFlags(args.filter(arg => arg !== "--print-command"), ["--mode", "--model", "--provider-profile", "--session-id"], []);
  if (rest.length || (one["--mode"] !== undefined && !["headless", "tui"].includes(one["--mode"]))) fail("usage: ahub jcode [--mode tui|headless] [--model <alias>] [--provider-profile <name>] [--session-id <id>]");
  if (one["--session-id"] !== undefined && !qwenSessionId(one["--session-id"])) fail("invalid Jcode session identity");
  const control = readControl(stateDir);
  const mode = one["--mode"] ?? (ctx.instance ? "headless" : control?.startModes?.jcode ?? startModeOf(ctx.projectConfig().peers, "jcode"));
  if (print && (mode === "headless" || !control?.features?.includes("native_tui_launch"))) {
    try { return console.log(JSON.stringify(launcherPreview("jcode", args, cwd, stateDir, unattendedEnv), null, 2)); }
    catch { return fail("cannot preview Jcode launch: invalid arguments or configuration (details withheld)"); }
  }
  if (mode === "tui" && !ctx.person) fail("Jcode's private TUI is person-only; run ahub jcode in your terminal");
  const hub = await connect(), abort = new AbortController();
  let interrupted = false;
  const interruptedWait = () => { if (abort.signal.aborted && !interrupted) fail("hub connection closed while waiting for Jcode; retry from a terminal"); return abort.signal.aborted; };
  const interrupt = () => { interrupted = true; abort.abort(); hub.close(); process.exitCode = 130; };
  process.once("SIGINT", interrupt);
  const oldClose = hub.onClose;
  hub.onClose = (code, reason) => { if (!abort.signal.aborted) abort.abort(); oldClose?.(code, reason); };
  try {
    const snapshot = (await hub.request({ t: "status" })).status;
    const rostered = rosterInStatus(snapshot, "jcode");
    if (rostered === undefined) fail("cannot read jcode's roster membership from the running hub; upgrade or restart it, then retry (nothing was started)");
    if (!rostered) fail("jcode is off roster; add it with ahub roster add jcode");
    const warning = retainedLaunchWarning(snapshot, "jcode", ctx.definition); if (warning) console.error(warning);
    const options = { model: one["--model"], providerProfile: one["--provider-profile"], sessionId: one["--session-id"] };
    if (print) {
      if (!hub.features.includes("native_tui_launch") || mode !== "tui") return console.log(JSON.stringify(launcherPreview("jcode", args, cwd, stateDir, unattendedEnv), null, 2));
      const reply = await hub.request({ t: "native_tui_launch", peer: "jcode", args: options });
      if (!reply.ok || reply.state !== "ready") fail("Jcode's selected native session is not saved and ready; run ahub jcode to wait for its first hub turn");
      return console.log(JSON.stringify(reply.launch, null, 2));
    }
    if (mode === "tui") {
      if (!hub.features.includes("native_tui_launch")) fail("the running hub does not support Jcode TUI launch; upgrade it before retrying");
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        if (one["--mode"] || Object.values(options).some(value => value !== undefined)) fail("run ahub jcode with these options in a terminal");
        const reply = await hub.request({ t: "peer_start", peer: "jcode" });
        if (!reply.ok) fail(reply.error);
        console.log(reply.command ?? "Jcode terminal requested"); return;
      }
    }
    const written = configureJcodeMcp(cwd, stateDir, bundleInStatus(snapshot) ?? resolve(cliDir, "../../plugins/agent-hub/server.js"));
    if (written.tracked) console.error(".jcode/mcp.json is tracked; review this local machine-path change before committing it");
    const reply = await hub.request({ t: "start", peer: "jcode", args: { mode, ...options }, operationId: process.env.AGENTHUB_RECOVERY_OPERATION }, 65_000);
    if (interruptedWait()) return;
    if (!reply.ok) fail(reply.error);
    if (mode === "headless") { console.log(reply.already ? "jcode is already attached" : "jcode attached (headless); native policy unmanaged, NO hub sandbox"); return; }
    const ready = await waitForJcodeTui(hub, fail, abort.signal, options);
    if (interruptedWait() || !ready) return;
    // No managed terminal record: Jcode's controlled recovery is refused at plan time, so, like Kimi's TUI, it has
    // no terminal recovery adapter (#564).
    const confirmed = await hub.request({ t: "native_tui_launch", peer: "jcode", binding: ready.binding, args: options });
    if (interruptedWait()) return;
    if (!confirmed.ok || confirmed.state !== "ready") fail("Jcode launch changed before its terminal opened");
    ctx.execWithEnv(confirmed.launch.cmd, confirmed.launch.args, { ...ctx.helpers.childEnv(), ...confirmed.launch.env });
  } finally { process.removeListener("SIGINT", interrupt); hub.onClose = oldClose; hub.close(); }
}
