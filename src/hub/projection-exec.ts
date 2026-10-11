// Trusted synchronous-boundary helper: the parent waits, this process owns and stops the converter group.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
let ownedGroup: number | undefined;
const stop = () => { if (ownedGroup) try { process.kill(-ownedGroup, "SIGKILL"); } catch { /* owned group gone */ } };
// The aggregate preview deadline can expire before the converter's own timer.
process.on("SIGTERM", () => { stop(); process.exit(143); });
process.on("SIGINT", () => { stop(); process.exit(130); });
const request = JSON.parse(await new Response(Bun.stdin.stream()).text()) as { cwd: string; sandbox: string; argv: string[]; timeoutMs?: number };
const limit = 256 * 1024;
const child = spawn("/usr/bin/sandbox-exec", ["-p", request.sandbox, ...request.argv], {
  cwd: request.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir(), LANG: "en_US.UTF-8", TERM: "dumb" },
});
ownedGroup = child.pid;
const decoder = new TextDecoder("utf-8", { fatal: true });
let stdout = "", stderrBytes = 0, outputBytes = 0, invalid = false;
const timeout = typeof request.timeoutMs === "number" && Number.isFinite(request.timeoutMs) ? Math.ceil(Math.max(1, Math.min(5000, request.timeoutMs))) : 5000;
const timer = setTimeout(() => { invalid = true; stop(); }, timeout);
child.stdout.on("data", (bytes: Buffer) => { outputBytes += bytes.length; if (outputBytes > limit) { invalid = true; stop(); } else try { stdout += decoder.decode(bytes, { stream: true }); } catch { invalid = true; stop(); } });
child.stderr.on("data", (bytes: Buffer) => { stderrBytes += bytes.length; if (stderrBytes > limit) { invalid = true; stop(); } });
child.on("exit", () => stop()); // descendants may retain the output pipe after the leader exits
child.on("error", () => { clearTimeout(timer); invalid = true; process.stdout.write(JSON.stringify({ ok: false })); });
child.on("close", code => { clearTimeout(timer); ownedGroup = undefined; try { stdout += decoder.decode(); } catch { invalid = true; } process.stdout.write(JSON.stringify({ ok: !invalid && code === 0, ...(invalid || code !== 0 ? {} : { text: stdout }) })); });
