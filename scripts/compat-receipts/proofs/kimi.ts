import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ReceiptError, type Cause, type CommandResult, type ProofContext, type ProofResults } from "../types.ts";
import { runReviewerProofs, type KimiPreparedFixture } from "./reviewers.ts";

// Promoted from #748 kimi-probe.ts, SHA256 2ff8e2841f2cbd58d07add57e5deb9041ee33a692489083a176e6b5d5f406edf.
// Preparation/inventory/broker controls remain in reviewers.ts; no historical result is an input.
const TOOLS = ["mcp__agent-hub__hub_review", "mcp__agent-hub__hub_task_show"];
const NATIVE_IDS = ["native-tool-loop", "write-absent", "write-positive-control", "network-guard-control", "cleanup"];
const BLOCKED = "blocked external network attempt\n";
const guard = fileURLToPath(new URL("./kimi-loopback-only.cjs", import.meta.url));
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const check: (value: unknown) => asserts value = value => { if (!value) throw new ReceiptError("proof-failed"); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function read(file: string, context: ProofContext): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd); check(info.isFile() && info.nlink === 1 && info.size <= context.limits.outputBytes);
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
function successful(run: CommandResult, context: ProofContext): void {
  if (!run.ownedStopConfirmed || run.survivorDetected) throw new ReceiptError("cleanup");
  if (context.signal.aborted) throw new ReceiptError("cancelled");
  if (run.timedOut) throw new ReceiptError("timeout");
  check(run.exitCode === 0);
}
function sse(request: number, positive: boolean, marker: string): string {
  let name: string | undefined, input: Record<string, unknown> = {};
  if (positive && request === 1) { name = "Write"; input = { path: marker, content: "synthetic-write-control" }; }
  else if (!positive && request === 1) { name = TOOLS[1]; input = { id: 7 }; }
  else if (!positive && request === 2) { name = "Write"; input = { path: marker, content: "must-not-write" }; }
  else if (!positive && request === 3) { name = TOOLS[0]; input = { id: 7, verdict: "approved", note: "synthetic receipt only" }; }
  const events: Record<string, unknown>[] = [{ type: "message_start", message: { id: `msg_${request}`, type: "message", role: "assistant", content: [], model: "fixture", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }];
  if (name) events.push({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `call_${request}`, name, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
  else events.push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "SYNTHETIC_COMPLETE" } });
  events.push({ type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: name ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }, { type: "message_stop" });
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}
async function body(request: Request, context: ProofContext): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader(); check(reader);
  const parts: Uint8Array[] = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  context.signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > context.limits.outputBytes) { await reader.cancel(); throw new ReceiptError("proof-failed"); }
      parts.push(next.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(parts).toString("utf8")); check(object(value)); return value;
  } finally { context.signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}

async function nativeCase(context: ProofContext, fixture: KimiPreparedFixture, root: string, positive: boolean, networkLog: string): Promise<void> {
  const own = join(root, positive ? "write-control" : "two-tools"), tool = join(own, "tool"), cwd = join(own, "cwd"), home = join(own, "home"), skills = join(own, "skills"), temp = join(own, "tmp");
  for (const dir of [tool, cwd, home, skills, temp, join(tool, "credentials"), join(tool, "oauth")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const marker = join(cwd, "marker.txt"), agent = join(cwd, "reviewer.md");
  const originalAgent = fixture.launch.args[fixture.launch.args.indexOf("--agent-file") + 1]; check(originalAgent);
  const agentText = read(originalAgent, context);
  const frontEnd = agentText.indexOf("\n---", 4); check(frontEnd > 0);
  const front = Bun.YAML.parse(agentText.slice(4, frontEnd)) as { tools?: unknown; subagents?: unknown };
  check(JSON.stringify(front.tools) === JSON.stringify(TOOLS) && JSON.stringify(front.subagents) === "[]");
  writeFileSync(agent, positive ? agentText.replace("subagents: []", "  - Write\nsubagents: []") : agentText, { mode: 0o600 });
  const copiedFront = Bun.YAML.parse(read(agent, context).slice(4, read(agent, context).indexOf("\n---", 4))) as { tools?: unknown };
  check(JSON.stringify(copiedFront.tools) === JSON.stringify(positive ? [...TOOLS, "Write"] : TOOLS));
  writeFileSync(marker, "unchanged", { mode: 0o600 });
  writeFileSync(join(tool, "mcp.json"), fixture.brokerConfig, { mode: 0o600 });
  writeFileSync(join(tool, "device_id"), "synthetic-device", { mode: 0o600 });
  const token = JSON.stringify({ access_token: "synthetic-access-only", expires_at: Math.floor(Date.now() / 1000) + 7200, expires_in: 7200, token_type: "Bearer", scope: "fixture" });
  writeFileSync(join(tool, "credentials/kimi-code.json"), token, { mode: 0o600 });
  const inventory: string[][] = [], results: string[] = []; let requests = 0, malformed = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: context.limits.outputBytes,
    async fetch(request) {
      try {
        check(!context.signal.aborted && !request.headers.has("origin") && request.method === "POST" && new URL(request.url).pathname === "/v1/messages");
        check(++requests <= (positive ? 2 : 4));
        const value = await body(request, context); check(Array.isArray(value.tools) && Array.isArray(value.messages));
        inventory.push(value.tools.map(item => { check(object(item) && typeof item.name === "string"); return item.name; }));
        for (const message of value.messages) if (object(message) && Array.isArray(message.content)) {
          for (const part of message.content) if (object(part) && part.type === "tool_result") results.push(JSON.stringify(part.content));
        }
        return new Response(sse(requests, positive, marker), { headers: { "content-type": "text/event-stream" } });
      } catch { malformed = true; return new Response("invalid fixture request", { status: 400 }); }
    },
  });
  try {
    const base = `http://127.0.0.1:${server.port}`, scope = `kimi-code-env-${hash(JSON.stringify({ oauthHost: `${base}/auth`, baseUrl: `${base}/v1` })).slice(0, 16)}`;
    writeFileSync(join(tool, `credentials/${scope}.json`), token, { mode: 0o600 });
    const prepared = fixture.launch.env?.KIMI_CODE_HOME; check(prepared);
    const generated = read(join(prepared, "config.toml"), context);
    check(generated.includes("https://api.kimi.ai/coding/v1") && generated.includes("https://auth.kimi.ai") && !generated.includes("synthetic-access-only"));
    const config = generated.replace("https://api.kimi.ai/coding/v1", `${base}/v1`).replace("https://auth.kimi.ai", `${base}/auth`).replace("oauth/kimi-code", `oauth/${scope}`);
    writeFileSync(join(tool, "config.toml"), config, { mode: 0o600 });
    const parsed = Bun.TOML.parse(config) as { providers: Record<string, { base_url: string; oauth: { oauth_host: string } }> };
    check(parsed.providers["managed:kimi-code"]?.base_url === `${base}/v1` && parsed.providers["managed:kimi-code"]?.oauth.oauth_host === `${base}/auth`);
    check(fixture.launch.env && fixture.launch.current?.() === true && fixture.launch.envMode === "replace" && fixture.launch.env.KIMI_CODE_TRUST_WORKSPACE === undefined && fixture.launch.env.KIMI_DISABLE_OAUTH_LOCK === undefined);
    const baseline = fixture.calls.length;
    const run = await context.run([...context.artifact.command, "-p", "Run only the synthetic fixture operations.", "--output-format", "stream-json", "--agent-file", agent, "--skills-dir", skills], {
      cwd, env: { ...fixture.launch.env, HOME: home, KIMI_CODE_HOME: tool, TMPDIR: `${temp}/`, XDG_CONFIG_HOME: join(home, ".config"), NODE_OPTIONS: `--require ${JSON.stringify(guard)}`, PROBE_NETWORK_LOG: networkLog },
      signal: context.signal, timeoutMs: context.limits.legMs, maxBytes: context.limits.outputBytes,
    });
    successful(run, context);
    check(!malformed && requests === (positive ? 2 : 4) && inventory.length === requests && read(networkLog, context) === "");
    check(inventory.every(names => names.length === (positive ? 3 : 2) && [...TOOLS, ...(positive ? ["Write"] : [])].every(name => names.includes(name))));
    check(read(marker, context) === (positive ? "synthetic-write-control" : "unchanged"));
    check(JSON.stringify(fixture.calls.slice(baseline)) === JSON.stringify(positive ? [] : ["hub_task_show", "hub_review"]));
    if (!positive) check(results.some(text => text.includes("ERROR: Tool execution failed.") && /Tool.*Write.*not found/.test(text)));
    check(read(join(tool, "config.toml"), context) === config && read(join(tool, "credentials/kimi-code.json"), context) === token && read(join(tool, `credentials/${scope}.json`), context) === token);
    check(fixture.launch.current?.() === true);
  } finally { await server.stop(true); }
}

/** Fixed local protocol only. The typed command port owns child groups, deadlines and output caps. */
export async function runKimiNativeProofs(context: ProofContext, fixture: KimiPreparedFixture): Promise<ProofResults> {
  const output: ProofResults = Object.fromEntries(NATIVE_IDS.map(id => [id, { status: "not-run", cause: "producer-not-importable" }]));
  const binary = context.artifact.command[0], node = Bun.which("node", { PATH: context.env.PATH ?? "" });
  if (!binary || !isAbsolute(binary) || context.artifact.command.length !== 1 || !node) {
    for (const id of NATIVE_IDS) output[id] = { status: "not-run", cause: !node ? "install-unavailable" : "input" };
    return output;
  }
  const root = mkdtempSync(join(context.root, "kimi-native-")), log = join(root, "network.log");
  writeFileSync(log, "", { mode: 0o600 });
  let cleanup = true;
  try {
    try {
      const control = await context.run([node, "--require", guard, "-e", "try { require('node:https').get('https://receipt.invalid'); process.exitCode = 2; } catch (error) { if (error.message !== 'receipt permits loopback only') throw error; process.stdout.write('BLOCKED'); }"], {
        cwd: context.cwd, env: { ...context.env, PROBE_NETWORK_LOG: log }, signal: context.signal, timeoutMs: context.limits.legMs, maxBytes: context.limits.outputBytes,
      });
      successful(control, context); check(control.stdout === "BLOCKED" && read(log, context) === BLOCKED);
      output["network-guard-control"] = { status: "pass", cause: "ok" };
      writeFileSync(log, "", { mode: 0o600 });
      for (const positive of [false, true]) {
        await nativeCase(context, fixture, root, positive, log);
        for (const id of positive ? ["write-positive-control"] : ["native-tool-loop", "write-absent"]) output[id] = { status: "pass", cause: "ok" };
      }
    } catch (error) {
      const cause: Cause = error instanceof ReceiptError ? error.causeCode : "proof-failed";
      if (cause === "cleanup") cleanup = false;
      for (const id of NATIVE_IDS) if (output[id]?.status !== "pass") output[id] = { status: "fail", cause };
    }
  } finally {
    try { rmSync(root, { recursive: true, force: true }); cleanup &&= !existsSync(root); }
    catch { cleanup = false; }
    output.cleanup = { status: cleanup ? "pass" : "fail", cause: cleanup ? "ok" : "cleanup" };
  }
  return output;
}

export async function runKimiProofs(context: ProofContext): Promise<ProofResults> {
  return await runReviewerProofs(context, fixture => runKimiNativeProofs(context, fixture));
}
