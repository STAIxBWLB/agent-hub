import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PiToolReceipts } from "../../../src/pi/tool-receipts.ts";
import { ReceiptError, type Cause, type ProofContext, type ProofResult, type ProofResults } from "../types.ts";

// Promoted from docs/verification/pi-152-model-free.ts and pi-152-native.mjs (#1248). Every assertion of the 1.5.0 and 1.5.2 receipts is kept; what changed is that the launcher,
// package root and version are the candidate's (the artifact the installer verified), the scratch home is the harness's private home, and each native child runs under the shared
// bounded command port, so nothing here spawns an unowned process. No account, API key, model or provider is used: the only listener is a fixed loopback bridge that counts requests.
const NATIVE = fileURLToPath(new URL("./pi-native.mjs", import.meta.url));
const EXTENSION = fileURLToPath(new URL("../../../src/pi/extension.ts", import.meta.url));
const IDS = ["native-identity", "cli-rpc-session", "sdk-registration", "tool-replay", "failed-tool", "zero-provider-requests", "host-permission-modes", "version-admission", "isolated-home-cleanup"] as const;
/**
 * Host fixtures the receipt names for the two Linux-capable legs. They test this checkout's own host code (Pi permission modes, the COMPAT table and its admission rules), not the
 * candidate, so they are the same files the receipt ran: `test/permission-modes.test.ts` "Pi mode grants" and `test/pi-compat.test.ts` with `test/compat.test.ts`. They run under the
 * shared bounded command port with the harness's private environment minus every hub variable (a hub home would change what the fixtures read).
 */
const HOST_COMMANDS: Record<string, readonly string[]> = {
  "host-permission-modes": ["test", "test/permission-modes.test.ts", "--test-name-pattern", "Pi mode grants"],
  "version-admission": ["test", "test/pi-compat.test.ts", "test/compat.test.ts"],
};
const BRIDGE_TOKEN = "fixture";
const HOST_LEGS = new Set(Object.keys(HOST_COMMANDS));
const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));
async function hostLeg(context: ProofContext, id: string): Promise<ProofResult> {
  const env: NodeJS.ProcessEnv = { ...context.env };
  for (const key of ["AGENTHUB_HOME", "AGENTHUB_PROJECT_DIR", "AGENTHUB_STATE_DIR", "AGENTHUB_PEER_ID", "AGENTHUB_LAUNCH_ID", "AMEM_HOME"]) delete env[key];
  const run = await context.run([process.execPath, ...HOST_COMMANDS[id]!], { cwd: REPOSITORY, env, signal: context.signal, timeoutMs: context.limits.legMs, maxBytes: context.limits.outputBytes });
  if (!run.ownedStopConfirmed || run.survivorDetected) return result("fail", "cleanup");
  if (context.signal.aborted) return result("fail", "cancelled");
  if (run.timedOut) return result("fail", "timeout");
  // Bun prints its summary on stderr: a pass is exit 0 with at least one pass and no fail line.
  const summary = `${run.stdout}\n${run.stderr}`;
  return run.exitCode === 0 && /\b[1-9]\d* pass\b/.test(summary) && /\b0 fail\b/.test(summary) ? result("pass", "ok") : result("fail", "proof-failed");
}

const result = (status: ProofResult["status"], cause: Cause): ProofResult => ({ status, cause });

/** Entries below the account's `~/.pi/agent` the receipt did not compare: they change in normal use of a Pi the person runs. */
const VOLATILE = new Set(["sessions", "logs", "cache", "caches", "install", "installs", "bin"]);
const HOME_ENTRIES = 20_000;
/**
 * SHA-256 over the relative path and content of every file under the account's real `~/.pi/agent` (the same set the 1.5.0 and 1.5.2 receipts compared), `"absent"` when there is none,
 * `undefined` when it cannot be read inside the bound. The account home is read here only: no child ever gets it, and the harness never writes it.
 */
function realPiHome(context: ProofContext, base: string): string | undefined {
  try {
    if (!existsSync(base)) return "absent";
    const digest = createHash("sha256");
    let entries = 0;
    const walk = (directory: string, relativePath: string): void => {
      for (const name of readdirSync(directory).sort()) {
        if (relativePath === "" && VOLATILE.has(name)) continue;
        if (++entries > HOME_ENTRIES) throw new ReceiptError("input");
        const path = join(directory, name), info = lstatSync(path), label = join(relativePath, name);
        if (info.isDirectory()) { digest.update(`d:${label}\n`); walk(path, label); }
        else if (info.isFile() && info.size <= context.limits.outputBytes) digest.update(`f:${label}:${createHash("sha256").update(readFileSync(path)).digest("hex")}\n`);
        else digest.update(`o:${label}:${info.size}\n`);
      }
    };
    walk(base, "");
    return digest.digest("hex");
  } catch { return undefined; }
}
function fail(cause: Cause = "proof-failed"): never { throw new ReceiptError(cause); }
const check: (value: unknown) => asserts value = value => { if (!value) fail(); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

interface BridgeCounts { effects: number; providers: number; events: string[] }
/** The fixed loopback bridge of the receipt: a bearer-checked tool endpoint over the real `PiToolReceipts` ledger, and a provider endpoint that must never be reached. */
async function bridge(context: ProofContext, counts: BridgeCounts): Promise<{ port: number; close(): Promise<void> }> {
  const ledger = new PiToolReceipts(join(context.root, "pi-hub.db"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: context.limits.outputBytes, async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("origin") || request.headers.get("authorization") !== `Bearer ${BRIDGE_TOKEN}`) return new Response("forbidden", { status: 403 });
    if (url.pathname === "/commands") { await Bun.sleep(25); return Response.json({ command: null }); }
    const body: unknown = await request.json().catch(() => undefined);
    if (!object(body)) return new Response("bad request", { status: 400 });
    if (url.pathname === "/event") { if (typeof body.type === "string") counts.events.push(body.type); return Response.json({ ok: true }); }
    if (url.pathname === "/budget") return Response.json({ decisions: [] });
    if (url.pathname === "/tool") {
      const args = object(body.args) ? body.args : {};
      const text = await ledger.execute(String(body.sessionId), String(body.toolCallId), String(body.name), body.args, async () => {
        if (args.value === "deny") return "error: fixture permission denied";
        counts.effects++;
        return "fixture success";
      });
      return Response.json({ text, failed: text.startsWith("error:") });
    }
    counts.providers++;
    return new Response("provider forbidden", { status: 500 });
  } });
  return { port: server.port as number, close: async () => { await server.stop(true); await ledger.close(); } };
}

function environment(context: ProofContext, port: number, home: string, agentDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: context.env.PATH, LANG: "C", LC_ALL: "C", TZ: "UTC", NO_COLOR: "1", PI_CODING_AGENT_DIR: agentDir, HUB_EXTENSION: EXTENSION, PI_COMPAT_PACKAGE: context.artifact.packageRoot,
    AGENTHUB_PI_BRIDGE_URL: `http://127.0.0.1:${port}`, AGENTHUB_PI_BRIDGE_TOKEN: BRIDGE_TOKEN, AGENTHUB_PI_OWNER_TOKEN: BRIDGE_TOKEN,
    AGENTHUB_PI_TOOLS: JSON.stringify([{ name: "compat_probe", description: "model-free fixture", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }]) };
  for (const key of ["TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) if (context.env[key]) env[key] = context.env[key];
  return env;
}

/** One `--mode rpc` session that answers `get_state`, then is stopped by the owned-process port when its answer arrives or its leg budget ends. */
async function rpcState(context: ProofContext, env: NodeJS.ProcessEnv, port: number, home: string, sessions: string): Promise<{ wire: string; stderr: string }> {
  const launcher = context.artifact.command[0]!;
  const rpcEnv = { ...env, AGENTHUB_PI_RELAY_URL: `http://127.0.0.1:${port}/v1`, AGENTHUB_PI_RELAY_TOKEN: BRIDGE_TOKEN, AGENTHUB_PI_MODELS: JSON.stringify([{ id: "fixture", name: "fixture" }]) };
  // The command port closes stdin, so the request rides a small node driver that writes it and exits when the answer is complete.
  const driver = ["-e", `const {spawn}=require('node:child_process');const c=spawn(process.argv[1],process.argv.slice(2),{stdio:['pipe','pipe','pipe']});let w='',e='';
    c.stdout.on('data',d=>{w+=d;if(w.includes('"command":"get_state"')){c.kill('SIGTERM');}});c.stderr.on('data',d=>{e+=d});
    c.stdin.write(JSON.stringify({id:'probe',type:'get_state'})+'\\n');c.on('close',()=>{process.stdout.write(JSON.stringify({wire:w,stderr:e}));process.exit(0)});
    setTimeout(()=>{c.kill('SIGKILL')},${Math.max(1000, context.limits.legMs - 5000)});`];
  const node = Bun.which("node", { PATH: context.env.PATH ?? "" });
  check(node);
  const run = await context.run([node, ...driver, launcher, "--mode", "rpc", "--provider", "agent-hub-local", "--model", "fixture", "--no-builtin-tools", "--no-skills", "--no-prompt-templates", "--no-extensions", "--extension", EXTENSION, "--session-dir", sessions], {
    cwd: home, env: rpcEnv, signal: context.signal, timeoutMs: context.limits.legMs, maxBytes: context.limits.outputBytes });
  settle(run, context);
  const parsed: unknown = JSON.parse(run.stdout);
  check(object(parsed) && typeof parsed.wire === "string" && typeof parsed.stderr === "string");
  return { wire: parsed.wire as string, stderr: parsed.stderr as string };
}
function settle(run: { ownedStopConfirmed: boolean; survivorDetected?: boolean; timedOut: boolean; exitCode: number | null }, context: ProofContext): void {
  if (!run.ownedStopConfirmed || run.survivorDetected) fail("cleanup");
  if (context.signal.aborted) fail("cancelled");
  if (run.timedOut) fail("timeout");
  check(run.exitCode === 0);
}

/** Test ports are programmatic only: the worker calls `runPiProofs(context)`, so the account home is always the real one and no environment variable or file can point elsewhere. */
export interface PiProofPorts { realHome?: string }

/** Candidate-parameterized form of the pi 1.5.2 model-free receipt. A leg that is not reached because an earlier one failed is a fail, never a pass. */
export async function runPiProofs(context: ProofContext, ports: PiProofPorts = {}): Promise<ProofResults> {
  const output: ProofResults = Object.fromEntries(IDS.map(id => [id, result("fail", "proof-failed")]));
  const counts: BridgeCounts = { effects: 0, providers: 0, events: [] };
  let server: Awaited<ReturnType<typeof bridge>> | undefined;
  let home: string | undefined;
  // The real configuration before anything runs: the harness's HOME is private, so the account's own Pi home is only ever read here, never given to a child.
  const realHome = ports.realHome ?? join(userInfo().homedir, ".pi", "agent");
  const before = realPiHome(context, realHome);
  try {
    check(context.id === "pi");
    const launcher = context.artifact.command[0];
    check(launcher && isAbsolute(launcher) && context.artifact.command.length === 1 && context.artifact.method === "npm-exact");
    const metadata: unknown = JSON.parse(readFileSync(join(context.artifact.packageRoot, "package.json"), "utf8"));
    check(object(metadata) && metadata.name === "@earendil-works/pi-coding-agent" && metadata.version === context.version);
    home = join(context.root, "pi-native-home");
    const agentDir = join(home, "agent");
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });

    // native-identity: `--version` is exactly the candidate version, with empty stderr.
    const version = await context.run([launcher, "--version"], { cwd: home, env: { HOME: home, PATH: context.env.PATH, PI_CODING_AGENT_DIR: agentDir }, signal: context.signal, timeoutMs: Math.min(context.limits.legMs, 30_000), maxBytes: context.limits.outputBytes });
    settle(version, context);
    check(version.stdout.trim() === context.version && version.stderr === "");
    output["native-identity"] = result("pass", "ok");

    server = await bridge(context, counts);
    const env = environment(context, server.port, home, agentDir);
    const node = Bun.which("node", { PATH: context.env.PATH ?? "" });
    check(node);
    // sdk-registration, tool-replay, failed-tool: the installed SDK loads this checkout's extension and its registered callback runs without a prompt.
    const sdk = await context.run([node, NATIVE], { cwd: home, env, signal: context.signal, timeoutMs: context.limits.legMs, maxBytes: context.limits.outputBytes });
    settle(sdk, context);
    check(sdk.stderr === "");
    const native: unknown = JSON.parse(sdk.stdout);
    check(object(native) && native.extension === "loaded" && object(native.first) && native.first.isError === false && JSON.stringify(native.first) === JSON.stringify(native.replay) && object(native.denied) && native.denied.isError === true);
    check(Array.isArray(native.tools) && native.tools.length === 1 && native.tools[0] === "compat_probe");
    output["sdk-registration"] = result("pass", "ok");
    check(counts.effects === 1);
    output["tool-replay"] = result("pass", "ok");
    output["failed-tool"] = result("pass", "ok");

    // cli-rpc-session: the real CLI answers get_state with a session identity and no messages, and the extension reports session start and shutdown.
    const rpc = await rpcState(context, env, server.port, home, join(home, "native-sessions"));
    check(rpc.stderr === "");
    const state = rpc.wire.trim().split("\n").map(line => { try { return JSON.parse(line) as unknown; } catch { return undefined; } }).find(item => object(item) && item.command === "get_state");
    check(object(state) && state.success === true && object(state.data) && state.data.messageCount === 0 && state.data.sessionId && state.data.sessionFile);
    check(counts.events.includes("session_start") && counts.events.includes("session_shutdown"));
    output["cli-rpc-session"] = result("pass", "ok");

    // zero-provider-requests: nothing reached the provider endpoint in any leg above.
    check(counts.providers === 0);
    output["zero-provider-requests"] = result("pass", "ok");
  } catch (error) {
    const cause: Cause = error instanceof ReceiptError ? error.causeCode : "proof-failed";
    for (const id of IDS) if (output[id]?.status === "fail") output[id] = result("fail", cause);
  }
  let stopped = true;
  try { await server?.close(); } catch { stopped = false; }
  // The two host-fixture legs test this checkout, not the candidate, so they run whatever happened above; a failure above never turns them into a pass.
  for (const id of HOST_LEGS) output[id] = context.signal.aborted ? result("fail", "cancelled") : await hostLeg(context, id).catch(() => result("fail", "proof-failed"));
  // isolated-home-cleanup: the account's real Pi home is byte-identical after the run (nothing leaked out of the private home), and the loopback listener is closed.
  const after = realPiHome(context, realHome);
  output["isolated-home-cleanup"] = !stopped ? result("fail", "cleanup") : before === undefined || after === undefined ? result("fail", "proof-failed")
    : before === after ? result("pass", "ok") : result("fail", "proof-failed");
  return output;
}
