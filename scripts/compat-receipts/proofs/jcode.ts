import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, readdirSync, writeFileSync, writeSync, type Stats } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { Readable, Writable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { jcodeCommand } from "../../../src/adapters/jcode.ts";
import { readProcessTable, stopOwnedProcess, trackGroup } from "../../../src/hub/child-process.ts";
import { realPath } from "../../../src/hub/project.ts";
import { ReceiptError, type ProofContext, type ProofResults } from "../types.ts";

const NATIVE_LEGS = ["isolation", "serve-cleanup", "acp-initialize-new-load-mode-ceilings", "mcp-owned-environment", "telemetry", "active-turn-soft-interrupt"] as const;
const MODEL = "receipt-fixed-model", PROFILE = "receipt-loopback";
const PROMPT = "receipt original prompt", STEER = "receipt steer prompt", HEAD = "receipt streamed prefix";
const SERVER_KEYS = ["argv", "debug_socket_path", "idle_timeout_secs", "owner_pid", "pid", "ppid", "schema_version", "scope", "socket_path", "started_at"];
export interface JcodeProofObservation {
  step: "steer-pong" | "steer-subscribe" | "steer-idle" | "steer-stream-arrived" | "steer-active" | "steer-ack" | "steer-end-turn" | "steer-request-count" | "steer-first-conversation" | "steer-second-conversation" | "telemetry-walk" | "first-shape" | "second-shape" | "telemetry-kind";
  cause: "ok" | "pending" | "assertion" | "telemetry-id" | "milestone" | "opt-out-marker" | "other-telemetry-name" | "symlink" | "entry-budget" | "io" | "original" | "steer" | "head" | "session-context" | "system-reminder" | "other" | "directory" | "regular";
  rootClass: "none" | "home" | "jcode-home";
  passed: boolean;
  count: number;
}
function check(value: unknown): asserts value { if (!value) throw new ReceiptError("proof-failed"); }
function contained(root: string, value: string): boolean {
  const rel = relative(realPath(root), realPath(value));
  return isAbsolute(value) && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}
function privateJSON(file: string, cap: number): any {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    check(before.isFile() && before.nlink === 1 && before.size <= cap);
    const text = readFileSync(fd, "utf8"), after = fstatSync(fd);
    check(after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs);
    return JSON.parse(text);
  } finally { closeSync(fd); }
}
async function until(condition: () => boolean, signal: AbortSignal): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    if (condition()) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", aborted); resolve(); };
      const aborted = () => { clearTimeout(timer); signal.removeEventListener("abort", aborted); reject(new ReceiptError("cancelled")); };
      const timer = setTimeout(done, 10); signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
    });
  }
}

/** Bounded protocol transport; native requests never acquire a filesystem/terminal permission. */
class JsonLines {
  private queue: any[] = [];
  private pending: { match: (value: any) => boolean; resolve: (value: any) => void; reject: (error: Error) => void }[] = [];
  private failure?: Error;
  private buffer = "";
  private bytes = 0;
  private readonly abort = () => this.fail(new ReceiptError("cancelled"));
  constructor(input: Readable, private readonly output: Writable, private readonly signal: AbortSignal, private readonly cap: number, acp = false) {
    input.on("data", (chunk: Buffer) => {
      if (this.failure) return;
      this.bytes += chunk.length;
      if (this.bytes > this.cap) return this.fail(new ReceiptError("proof-failed"));
      this.buffer += chunk.toString("utf8");
      for (;;) {
        const end = this.buffer.indexOf("\n"); if (end < 0) break;
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        let value: any;
        try { value = JSON.parse(line); } catch { this.fail(new ReceiptError("proof-failed")); return; }
        if (!value || typeof value !== "object" || Array.isArray(value)) { this.fail(new ReceiptError("proof-failed")); return; }
        if (acp && typeof value.method === "string" && value.id !== undefined) {
          this.send({ jsonrpc: "2.0", id: value.id, error: { code: -32601, message: "Receipt grants no native client actions" } });
          continue;
        }
        const index = this.pending.findIndex(waiter => waiter.match(value));
        if (index >= 0) this.pending.splice(index, 1)[0]!.resolve(value);
        else this.queue.push(value);
      }
    });
    input.once("error", () => this.fail(new ReceiptError("proof-failed")));
    input.once("end", () => this.fail(new ReceiptError("proof-failed")));
    output.on("error", () => this.fail(new ReceiptError("proof-failed")));
    signal.addEventListener("abort", this.abort, { once: true });
    if (signal.aborted) this.abort();
  }
  send(value: unknown): void { if (!this.failure) this.output.write(`${JSON.stringify(value)}\n`); }
  next(match: (value: any) => boolean): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    const index = this.queue.findIndex(match);
    if (index >= 0) return Promise.resolve(this.queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => this.pending.push({ match, resolve, reject }));
  }
  fail(error: Error): void { this.failure ??= error; for (const waiter of this.pending.splice(0)) waiter.reject(this.failure); }
  close(): void { this.signal.removeEventListener("abort", this.abort); this.fail(new ReceiptError("cancelled")); }
}

const MCP_OBSERVER = `import{writeFileSync}from'node:fs';import{createInterface}from'node:readline';
writeFileSync(process.argv[2],JSON.stringify({peer:process.env.AGENTHUB_PEER_ID,launch:process.env.AGENTHUB_LAUNCH_ID}),{mode:0o600});
createInterface({input:process.stdin}).on('line',line=>{let m;try{m=JSON.parse(line)}catch{return}if(m.id===undefined)return;
const result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'receipt-observer',version:'1'}}:m.method==='tools/list'?{tools:[]}:{};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});process.stdin.on('end',()=>process.exit(0));`;

function environment(context: ProofContext, nativeHome: string, launch: string): NodeJS.ProcessEnv {
  check(process.env.HOME && realPath(process.env.HOME) === realPath(context.home));
  check(realPath(process.cwd()) === realPath(context.cwd)); // j.sock is intentionally relative to avoid Darwin's pathname ceiling.
  for (const value of [context.home, context.cwd, context.prefix]) check(contained(context.root, value));
  const env: NodeJS.ProcessEnv = { HOME: context.home, PATH: context.env.PATH, LANG: "C", LC_ALL: "C", TZ: "UTC", TERM: "xterm-256color",
    JCODE_HOME: nativeHome, JCODE_SOCKET: "j.sock", JCODE_NO_TELEMETRY: "1", JCODE_DISABLE_CLAUDE_MCP: "1", DO_NOT_TRACK: "1",
    AGENTHUB_PEER_ID: "receipt-jcode", AGENTHUB_LAUNCH_ID: launch };
  for (const key of ["TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "AGENTHUB_HOME", "AMEM_HOME", "CODEX_HOME", "KIMI_CODE_HOME", "CLAUDE_CONFIG_DIR"]) {
    const value = context.env[key]; check(value && contained(context.root, value)); env[key] = value;
  }
  return env;
}
function hasTelemetry(directories: readonly string[], cap: number, observe: (event: JcodeProofObservation) => void): boolean {
  let count = 0;
  const walk = (dir: string, rootClass: "home" | "jcode-home"): boolean => {
    const report = (cause: JcodeProofObservation["cause"], passed = false) => observe({ step: "telemetry-walk", cause, rootClass, passed, count });
    let names: string[];
    try { names = readdirSync(dir); } catch (error) { report("io"); throw error; }
    for (const name of names) {
      if (++count > cap) { report("entry-budget"); throw new ReceiptError("proof-failed"); }
      let entry: Stats;
      try { entry = lstatSync(join(dir, name)); } catch (error) { report("io"); throw error; }
      if (entry.isSymbolicLink()) { report("symlink"); check(false); }
      if (/telemetry|milestone/i.test(name)) {
        let entries = 0, complete = true;
        if (entry.isDirectory()) {
          // Optional diagnosis counts only immediate children with a hard read budget.
          try {
            const directory = opendirSync(join(dir, name), { bufferSize: 1 });
            try {
              while (directory.readSync()) {
                if (entries >= Math.max(0, cap - count)) { complete = false; break; }
                entries++;
              }
            } finally { directory.closeSync(); }
          } catch { complete = false; }
        }
        observe({ step: "telemetry-kind", cause: entry.isDirectory() ? "directory" : entry.isFile() ? "regular" : "other", rootClass, passed: complete, count: entries });
        report(name === "telemetry_id" ? "telemetry-id" : name === "no_telemetry" ? "opt-out-marker" : /milestone/i.test(name) ? "milestone" : "other-telemetry-name");
        return true;
      }
      if (entry.isDirectory() && walk(join(dir, name), rootClass)) return true;
    }
    return false;
  };
  return directories.some((directory, index) => {
    const rootClass = index === 0 ? "home" : "jcode-home";
    if (walk(directory, rootClass)) return true;
    observe({ step: "telemetry-walk", cause: "ok", rootClass, passed: true, count });
    return false;
  });
}
function content(value: any): string {
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value.filter(part => part?.type === "text").map(part => part.text).join("") : "";
}

/** Reconstructed model-free receipt: fixed loopback bytes, no provider/account/model access. */
export async function runJcodeProofs(context: ProofContext): Promise<ProofResults> {
  let diagnosticFD: number | undefined, diagnosticBytes = 0, diagnosticRecords = 0;
  const observe = (event: JcodeProofObservation): void => {
    if (diagnosticFD === undefined || diagnosticRecords >= 64) return;
    try {
      const line = Buffer.from(`${JSON.stringify(event)}\n`);
      if (diagnosticBytes + line.length > Math.min(context.limits.outputBytes, 16 * 1024)) return;
      writeSync(diagnosticFD, line); diagnosticBytes += line.length; diagnosticRecords++;
    } catch { /* Diagnostics never decide a proof result. */ }
  };
  const steeringCheck = (step: JcodeProofObservation["step"], value: unknown, count = 0): void => {
    observe({ step, cause: value ? "ok" : "assertion", rootClass: "none", passed: !!value, count });
    check(value);
  };
  const result: ProofResults = Object.fromEntries(NATIVE_LEGS.map(id => [id, { status: "not-run", cause: "proof-failed" }]));
  const owned: ChildProcess[] = [], channels: JsonLines[] = [], sockets: ReturnType<typeof createConnection>[] = [];
  const abort = new AbortController(), deadline = AbortSignal.timeout(context.limits.legMs);
  const signal = AbortSignal.any([context.signal, abort.signal, deadline]);
  let stage: typeof NATIVE_LEGS[number] = "isolation", cleanup = true, serveValidated = false;
  const decoys = new Map<string, string>();
  let gateway: ReturnType<typeof Bun.serve> | undefined;
  let releaseFirst: (() => void) | undefined;
  const nativeHome = join(context.root, "jcode-home"), observer = join(context.root, "jcode-mcp-observer.mjs"), observed = join(context.root, "jcode-mcp-observed.json");
  const launch = randomUUID(), requests: any[] = [];
  const launchNative = (kind: "serve" | "acp"): ChildProcess => {
    signal.throwIfAborted();
    const argv = jcodeCommand(context.artifact.command, kind, "j.sock", context.cwd, MODEL, PROFILE);
    const child = spawn(argv[0]!, argv.slice(1), { cwd: context.cwd, env: { ...env, ...(kind === "serve" ? { JCODE_READY_FD: "3" } : {}) }, detached: true,
      stdio: kind === "serve" ? ["ignore", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"] });
    owned.push(child); trackGroup(child);
    let bytes = 0;
    const count = (chunk: Buffer) => { bytes += chunk.length; if (bytes > context.limits.outputBytes) abort.abort(new ReceiptError("proof-failed")); };
    child.stdout?.on("data", count); child.stderr?.on("data", count); // Native output is never logged or retained in a result.
    child.once("error", () => abort.abort(new ReceiptError("proof-failed")));
    child.once("exit", () => { if (!signal.aborted && !finishing) abort.abort(new ReceiptError("proof-failed")); });
    return child;
  };
  let env: NodeJS.ProcessEnv = {}, finishing = false;
  const command = async (argv: string[]) => {
    const answer = await context.run(argv, { cwd: context.cwd, env, signal, timeoutMs: context.limits.legMs, maxBytes: context.limits.outputBytes });
    if (!answer.ownedStopConfirmed || answer.survivorDetected) throw new ReceiptError("cleanup");
    if (answer.timedOut) throw new ReceiptError("timeout");
    check(answer.exitCode === 0); return answer.stdout;
  };
  try {
    check(context.id === "jcode" && context.artifact.command.length > 0 && isAbsolute(context.artifact.command[0]!));
    mkdirSync(nativeHome, { mode: 0o700 });
    env = environment(context, nativeHome, launch);
    try { diagnosticFD = openSync(join(context.root, "jcode-proof-observations.jsonl"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600); }
    catch { /* Optional private diagnostics must not alter a native leg. */ }
    const decoyHome = join(context.home, ".jcode"); mkdirSync(decoyHome, { mode: 0o700 });
    for (const name of ["auth.json", "auth-refresh-state.json", "config.toml", "mcp.json"]) {
      const file = join(decoyHome, name), text = name.endsWith(".toml") ? "# private decoy, no account data\n" : "{}\n";
      writeFileSync(file, text, { mode: 0o600, flag: "wx" });
      decoys.set(file, createHash("sha256").update(text).digest("hex"));
    }
    writeFileSync(join(nativeHome, "mcp.json"), '{"mcpServers":{}}\n', { mode: 0o600 });
    for (const directory of [".jcode", ".claude"]) mkdirSync(join(context.cwd, directory), { mode: 0o700 });
    for (const file of [".mcp.json", ".claude/mcp.json"]) writeFileSync(join(context.cwd, file), '{"mcpServers":{}}\n', { mode: 0o600, flag: "wx" });
    writeFileSync(observer, MCP_OBSERVER, { mode: 0o600, flag: "wx" });
    writeFileSync(join(context.cwd, ".jcode", "mcp.json"), JSON.stringify({ mcpServers: { observer: { command: process.execPath, args: [observer, observed], shared: false } } }), { mode: 0o600, flag: "wx" });
    const identity = JSON.parse(await command([...context.artifact.command, "--no-update", "--no-selfdev", "--quiet", "version", "--json"]));
    check(identity?.semver === context.version);
    result.isolation = { status: "pass", cause: "ok" };
    // The endpoint is selected only by this fresh private native profile, never by inherited provider variables.
    gateway = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      if (request.headers.has("origin") || request.headers.has("authorization") || request.headers.has("x-api-key")) return new Response("refused", { status: 403 });
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/models") return Response.json({ object: "list", data: [{ id: MODEL, object: "model", owned_by: "receipt" }] });
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions" || requests.length >= 2) return new Response("refused", { status: 404 });
      const reader = request.body?.getReader(); if (!reader) return new Response("refused", { status: 400 });
      let size = 0; const chunks: Uint8Array[] = [];
      try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > context.limits.outputBytes) return new Response("refused", { status: 413 }); chunks.push(part.value); } }
      finally { await reader.cancel().catch(() => {}); }
      let data: any; try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch { return new Response("refused", { status: 400 }); }
      if (data.model !== MODEL || data.stream !== true || !Array.isArray(data.messages)) return new Response("refused", { status: 400 });
      requests.push(data); const first = requests.length === 1;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        const frame = (delta: unknown, finish: string | null) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "receipt", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`));
        frame({ role: "assistant", content: first ? HEAD : "receipt complete" }, null);
        const finish = () => { try { frame({}, "stop"); controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); } catch { /* aborted native request */ } };
        if (first) releaseFirst = finish; else finish();
      } });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    } });
    await command([...context.artifact.command, "--no-update", "--no-selfdev", "provider", "add", PROFILE, "--base-url", `http://127.0.0.1:${gateway.port}/v1`, "--model", MODEL, "--no-api-key"]);
    stage = "serve-cleanup";
    const server = launchNative("serve");
    let ready = false; (server.stdio[3] as Readable).once("data", () => { ready = true; });
    await until(() => ready, signal);
    check(lstatSync(join(context.cwd, "j.sock")).isSocket() && lstatSync(join(context.cwd, "j-debug.sock")).isSocket());
    for (const name of ["j.sock.hash", "j.sock.daemon.lock"]) check(lstatSync(join(context.cwd, name)).isFile());
    const info = privateJSON(join(context.cwd, "j.sock.server.json"), context.limits.outputBytes);
    check(SERVER_KEYS.every(key => Object.hasOwn(info, key)) && info.pid === server.pid && info.owner_pid === process.pid);
    serveValidated = true;
    stage = "acp-initialize-new-load-mode-ceilings";
    const child = launchNative("acp"), acp = new JsonLines(child.stdout!, child.stdin!, signal, context.limits.outputBytes, true); channels.push(acp);
    let sequence = 0;
    const rpc = (method: string, params: unknown) => { const id = ++sequence; const answer = acp.next(value => value.id === id); acp.send({ jsonrpc: "2.0", id, method, params }); return answer; };
    const init = (await rpc("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })).result;
    check(init?.protocolVersion === 1 && init.agentInfo?.name === "jcode" && init.agentInfo.title === "Jcode" && init.agentInfo.version === context.version
      && init.agentCapabilities?.loadSession === true && Array.isArray(init.authMethods) && init.authMethods.length === 0);
    const created = (await rpc("session/new", { cwd: context.cwd, mcpServers: [] })).result;
    check(typeof created?.sessionId === "string" && created.sessionId.length > 0 && Array.isArray(created.configOptions) && created.models && typeof created.models === "object" && !Array.isArray(created.models));
    const session = created.sessionId;
    const loaded = (await rpc("session/load", { sessionId: session, cwd: context.cwd, mcpServers: [] })).result;
    check(loaded && !Object.hasOwn(loaded, "sessionId") && Array.isArray(loaded.configOptions) && loaded.models && typeof loaded.models === "object" && !Array.isArray(loaded.models));
    for (const method of ["session/set_mode", "session/request_permission"]) {
      const refusal = await rpc(method, { sessionId: session, modeId: "default" });
      check(refusal.error?.code === -32601 && refusal.error.message === `Unsupported ACP method: ${method}`);
    }
    result[stage] = { status: "pass", cause: "ok" };
    stage = "mcp-owned-environment";
    await until(() => { try { return lstatSync(observed).isFile(); } catch { return false; } }, signal);
    const inherited = privateJSON(observed, context.limits.outputBytes);
    check(inherited.peer === env.AGENTHUB_PEER_ID && inherited.launch === env.AGENTHUB_LAUNCH_ID && Object.keys(inherited).length === 2);
    result[stage] = { status: "pass", cause: "ok" };
    stage = "active-turn-soft-interrupt";
    const socket = createConnection("j.sock"); sockets.push(socket);
    const steer = new JsonLines(socket, socket, signal, context.limits.outputBytes); channels.push(steer);
    steer.send({ type: "ping", id: 1 });
    const pong = await steer.next(value => value.type === "pong" && value.id === 1);
    steeringCheck("steer-pong", Array.isArray(pong.capabilities) && pong.capabilities.includes("soft_interrupt_ids"));
    steer.send({ type: "subscribe", id: 2, working_dir: context.cwd, target_session_id: session, continue_on_disconnect: true });
    steeringCheck("steer-subscribe", (await steer.next(value => value.type === "session")).session_id === session);
    steer.send({ type: "state", id: 3 });
    const idle = await steer.next(value => value.type === "state" && value.id === 3);
    steeringCheck("steer-idle", idle.session_id === session && idle.is_processing === false); // Never send an interrupt while idle.
    const prompt = rpc("session/prompt", { sessionId: session, prompt: [{ type: "text", text: PROMPT }] }); prompt.catch(() => {});
    await until(() => requests.length === 1 && !!releaseFirst, signal);
    observe({ step: "steer-stream-arrived", cause: "ok", rootClass: "none", passed: true, count: requests.length });
    steer.send({ type: "state", id: 4 });
    const active = await steer.next(value => value.type === "state" && value.id === 4);
    steeringCheck("steer-active", active.session_id === session && active.is_processing === true);
    steer.send({ type: "soft_interrupt", id: 5, content: STEER, urgent: false, client_id: "receipt-steer" });
    observe({ step: "steer-ack", cause: "pending", rootClass: "none", passed: false, count: 0 });
    await steer.next(value => value.type === "ack" && value.id === 5);
    observe({ step: "steer-ack", cause: "ok", rootClass: "none", passed: true, count: 0 });
    releaseFirst!(); releaseFirst = undefined;
    steeringCheck("steer-end-turn", (await prompt).result?.stopReason === "end_turn");
    steeringCheck("steer-request-count", requests.length === 2, requests.length);
    const conversation = (messages: any[]) => messages.filter(message => message?.role !== "system" && message?.role !== "developer");
    const first = conversation(requests[0].messages), second = conversation(requests[1].messages);
    const shapes = (messages: any[], step: "first-shape" | "second-shape") => {
      for (const [index, message] of messages.slice(0, 64).entries()) {
        const text = content(message?.content);
        const original = text.includes(PROMPT), steer = text.includes(STEER), head = text.includes(HEAD);
        const reminder = !original && !steer && !head && text.startsWith("<system-reminder>") && text.endsWith("</system-reminder>");
        // Diagnostic identity only: pinned v0.99.1 session.rs/prompt.rs framing and field markers.
        const sessionContext = reminder && text.startsWith("<system-reminder>\n# Session Context\n")
          && ["Date: ", "Time: ", "Timezone: ", "OS: ", "Architecture: ", "Jcode version: ", "Working directory: "].every(field => text.includes(`\n${field}`));
        const cause: JcodeProofObservation["cause"] = original && !steer && !head ? "original"
          : steer && !original && !head ? "steer" : head && !original && !steer ? "head"
          : sessionContext ? "session-context" : reminder ? "system-reminder" : "other";
        const expectedRole = cause === "head" ? "assistant" : cause === "other" ? undefined : "user";
        observe({ step, cause, rootClass: "none", passed: expectedRole !== undefined && message?.role === expectedRole, count: index });
      }
    };
    shapes(first, "first-shape"); shapes(second, "second-shape");
    steeringCheck("steer-first-conversation", first.length === 1 && first[0]?.role === "user" && content(first[0].content) === PROMPT, first.length);
    steeringCheck("steer-second-conversation", second.length === 3 && second[0]?.role === "user" && content(second[0].content) === PROMPT
      && second[1]?.role === "assistant" && content(second[1].content).includes(HEAD)
      && second[2]?.role === "user" && content(second[2].content) === STEER, second.length);
    result[stage] = { status: "pass", cause: "ok" };
  } catch (error) {
    const localCause = abort.signal.reason instanceof ReceiptError ? abort.signal.reason.causeCode : undefined;
    const cause = context.signal.aborted ? (context.signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled")
      : deadline.aborted ? "timeout" : localCause ?? (error instanceof ReceiptError ? error.causeCode : "proof-failed");
    result[stage] = { status: "fail", cause };
  } finally {
    try {
      finishing = true;
      for (const channel of channels) channel.close();
      for (const socket of sockets) socket.destroy();
      releaseFirst?.(); gateway?.stop(true);
      for (const child of owned.reverse()) {
        try {
          await stopOwnedProcess(child, { group: true, termMs: 250, killMs: 1000 });
          const rows = await readProcessTable(); check(rows && !rows.some(row => row.pgid === child.pid));
        } catch { cleanup = false; }
      }
      if (!cleanup) result["serve-cleanup"] = { status: "fail", cause: "cleanup" };
      else if (serveValidated) result["serve-cleanup"] = { status: "pass", cause: "ok" };
      // Only private decoy files are fenced. This never reads or hashes the person's real native config.
      if (result.isolation?.status === "pass") {
        try {
          for (const [file, hash] of decoys) {
            const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try { const stat = fstatSync(fd); check(stat.isFile() && stat.nlink === 1 && stat.size <= context.limits.outputBytes); check(createHash("sha256").update(readFileSync(fd)).digest("hex") === hash); }
            finally { closeSync(fd); }
          }
        } catch { result.isolation = { status: "fail", cause: "proof-failed" }; }
      }
      if (owned.length) {
        try {
          const clean = !hasTelemetry([context.home, nativeHome], context.limits.archiveEntries, observe);
          result.telemetry = { status: clean ? "pass" : "fail", cause: clean ? "ok" : "proof-failed" };
        } catch { result.telemetry = { status: "fail", cause: "proof-failed" }; }
      }
    } finally {
      if (diagnosticFD !== undefined) { try { closeSync(diagnosticFD); } catch { /* Optional diagnostics never alter the outcome. */ } }
    }
  }
  return result;
}
