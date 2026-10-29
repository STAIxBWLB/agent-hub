import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const [log, mode = "success", ...args] = process.argv.slice(2);
if (mode === "probe") { console.log("2.1.309 (Claude Code)"); process.exit(0); }
const prompt = await new Response(Bun.stdin.stream()).text();
appendFileSync(log!, JSON.stringify({ args, prompt, launchId: process.env.AGENTHUB_LAUNCH_ID, peer: process.env.AGENTHUB_PEER_ID, cwd: process.cwd(), pid: process.pid }) + "\n");
if (mode === "before-session") process.exit(1);
const sessionId = args[args.indexOf(args.includes("--resume") ? "--resume" : "--session-id") + 1];
if (prompt) console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }));
if (mode === "staged-error") {
  // The fixture releases only its own child after observing the host-side diagnostic boundary.
  while (!existsSync(log! + ".finish")) await Bun.sleep(5);
  console.error("NATIVE_FAILURE_DETAIL_CANARY");
  console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, error: "NATIVE_FAILURE_DETAIL_CANARY", usage: { input_tokens: 7, output_tokens: 3 } }));
} else if (mode === "hang") {
  const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  writeFileSync(log! + ".descendant", String(child.pid));
  await new Promise(() => {});
} else {
  const result = { type: "result", subtype: mode === "error" ? "error_during_execution" : "success", is_error: mode === "error", usage: { input_tokens: 7, output_tokens: 3 } };
  console.log(JSON.stringify(result));
  if (mode === "duplicate") console.log(JSON.stringify(result));
}
