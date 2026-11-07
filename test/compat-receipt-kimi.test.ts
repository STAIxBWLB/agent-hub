import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runKimiNativeProofs, runKimiProofs } from "../scripts/compat-receipts/proofs/kimi.ts";
import type { KimiPreparedFixture } from "../scripts/compat-receipts/proofs/reviewers.ts";
import type { CommandResult, ProofContext, ReceiptCommand } from "../scripts/compat-receipts/types.ts";
import { createReviewerMcpSession, type ReviewerMcpSession } from "../src/adapters/reviewer-mcp.ts";
import { realPath } from "../src/hub/project.ts";

const roots: string[] = [], brokers: ReviewerMcpSession[] = [];
afterEach(() => {
  for (const broker of brokers.splice(0)) broker.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const TOOLS = ["mcp__agent-hub__hub_review", "mcp__agent-hub__hub_task_show"];
const ok = (): CommandResult => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, ownedStopConfirmed: true,
  processCleanup: "unproven", processCleanupReason: "Typed executable fixture; disposable-runner lifetime is separate." });
function fixture(): { context: ProofContext; prepared: KimiPreparedFixture; effects: string } {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-kimi-receipt-test-"))); roots.push(root);
  const home = join(root, "home"), prefix = join(root, "prefix"), cwd = join(root, "cwd"), tool = join(root, "prepared"), bin = join(root, "bin");
  for (const dir of [home, prefix, cwd, tool, bin]) mkdirSync(dir, { mode: 0o700 });
  const effects = join(root, "candidate-effect"), binary = join(prefix, "fake-kimi");
  writeFileSync(binary, `#!/bin/sh\n: > '${effects}'\n`, { mode: 0o700 });
  // Only lookup occurs: the command port below implements both executables' protocols.
  writeFileSync(join(bin, "node"), "#!/bin/sh\nexit 97\n", { mode: 0o700 });
  const agent = join(tool, "reviewer.md");
  writeFileSync(agent, `---\ntools:\n  - ${TOOLS[0]}\n  - ${TOOLS[1]}\nsubagents: []\n---\nSynthetic fixture.\n`, { mode: 0o600 });
  writeFileSync(join(tool, "config.toml"), 'telemetry=false\nhooks=[]\ndefault_model="fixture"\n[providers."managed:kimi-code"]\ntype="kimi"\nbase_url="https://api.kimi.ai/coding/v1"\n[providers."managed:kimi-code".oauth]\nstorage="file"\nkey="oauth/kimi-code"\noauth_host="https://auth.kimi.ai"\n[models.fixture]\nprovider="managed:kimi-code"\nmodel="kimi-for-coding"\nprotocol="anthropic"\nmax_context_size=32768\ncapabilities=["tool_use"]\n', { mode: 0o600 });
  const calls: string[] = [];
  const broker = createReviewerMcpSession({ task: 7, current: () => true,
    tools: ["hub_review", "hub_task_show"].map(name => ({ name, description: "fixture", inputSchema: { type: "object" as const, properties: { id: { type: "integer" } }, required: ["id"], additionalProperties: false as const } })),
    call: async name => { calls.push(name); return "synthetic result"; } }); brokers.push(broker);
  const context: ProofContext = { id: "kimi-review", version: "2.5.1", root, home, prefix, cwd,
    env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, LANG: "C" }, signal: new AbortController().signal,
    artifact: { method: "fixture", integrity: "sha256:fixture", packageRoot: prefix, command: [binary] },
    entry: { receipt: "fixture.md", runnerOS: ["linux", "macos"], nativePlatform: "fixture", autoAdmit: true, install: { method: "fixture" }, legs: [] },
    limits: { totalMs: 10_000, installMs: 5_000, legMs: 5_000, outputBytes: 64 * 1024, artifactBytes: 1024, expandedBytes: 1024, archiveEntries: 10 },
    run: async () => { throw Error("unexpected executable call"); } };
  const prepared: KimiPreparedFixture = { brokerConfig: broker.config, calls, launch: { command: [binary], args: ["--agent-file", agent, "--skills-dir", join(root, "skills")],
    env: { HOME: home, KIMI_CODE_HOME: tool }, envMode: "replace", current: () => true,
    isolation: { backend: "kimi", version: context.version, binary: "fixture", profile: "fixture", readOnly: true, strictMcp: true, ephemeral: true, evidence: [] } } };
  return { context, prepared, effects };
}
type Fault = "extra-tool" | "missing-call" | "missing-write" | "forged-receipt" | "timeout" | "owned-stop" | "survivor" | "network-control" | "config-changed";
function executablePort(fault?: Fault): ReceiptCommand {
  return async (argv, options) => {
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.timeoutMs).toBe(5_000);
    expect(options.maxBytes).toBe(64 * 1024);
    const log = options.env.PROBE_NETWORK_LOG!;
    if (argv.includes("--require")) {
      expect(argv[argv.indexOf("--require") + 1]?.endsWith("kimi-loopback-only.cjs")).toBe(true);
      if (fault !== "network-control") writeFileSync(log, "blocked external network attempt\n");
      return { ...ok(), stdout: "BLOCKED" };
    }
    expect(argv.slice(1, 5)).toEqual(["-p", "Run only the synthetic fixture operations.", "--output-format", "stream-json"]);
    expect(options.env.KIMI_CODE_TRUST_WORKSPACE).toBeUndefined();
    expect(options.env.KIMI_DISABLE_OAUTH_LOCK).toBeUndefined();
    expect(options.env.NODE_OPTIONS).toContain("kimi-loopback-only.cjs");
    if (fault === "forged-receipt") return { ...ok(), stdout: '{"passed":true,"cleanup":true}' };
    if (fault === "timeout") return { ...ok(), exitCode: null, timedOut: true };
    if (fault === "owned-stop") return { ...ok(), ownedStopConfirmed: false };
    if (fault === "survivor") return { ...ok(), survivorDetected: true };
    const agent = readFileSync(argv[argv.indexOf("--agent-file") + 1]!, "utf8"), end = agent.indexOf("\n---", 4);
    const names = (Bun.YAML.parse(agent.slice(4, end)) as { tools: string[] }).tools;
    const tool = options.env.KIMI_CODE_HOME!;
    const config = Bun.TOML.parse(readFileSync(join(tool, "config.toml"), "utf8")) as { providers: Record<string, { base_url: string; oauth: { oauth_host: string } }> };
    const provider = config.providers["managed:kimi-code"]!;
    expect(new URL(provider.base_url).hostname).toBe("127.0.0.1");
    expect(new URL(provider.oauth.oauth_host).hostname).toBe("127.0.0.1");
    const binding = JSON.parse(readFileSync(join(tool, "mcp.json"), "utf8")).mcpServers["agent-hub"] as { url: string; headers: Record<string, string> };
    const messages: { role: string; content: unknown[] }[] = [];
    for (let turn = 0; turn < 5; turn++) {
      const response = await fetch(`${provider.base_url}/messages`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ tools: [...names, ...(fault === "extra-tool" ? ["Read"] : [])].map(name => ({ name })), messages }), signal: options.signal });
      if (response.status !== 200) return { ...ok(), exitCode: 1 };
      const events = (await response.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)) as { type: string; content_block?: { type: string; name?: string }; delta?: { partial_json?: string; stop_reason?: string } });
      if (events.some(event => event.delta?.stop_reason === "end_turn")) break;
      const call = events.find(event => event.content_block?.type === "tool_use")!.content_block!;
      const input = JSON.parse(events.find(event => event.delta?.partial_json)?.delta?.partial_json ?? "{}") as { path: string; content: string };
      let content: unknown;
      if (call.name === "Write") {
        if (names.includes("Write")) { if (fault !== "missing-write") writeFileSync(input.path, input.content); content = "written"; }
        else content = "ERROR: Tool execution failed. Tool Write not found";
      } else if (fault !== "missing-call") {
        const rpc = await fetch(binding.url, { method: "POST", headers: { ...binding.headers, "content-type": "application/json" }, signal: options.signal,
          body: JSON.stringify({ jsonrpc: "2.0", id: turn, method: "tools/call", params: { name: call.name!.replace("mcp__agent-hub__", ""), arguments: input } }) });
        content = await rpc.json();
      } else content = "forged callback success";
      messages.push({ role: "user", content: [{ type: "tool_result", content }] });
    }
    if (fault === "config-changed") writeFileSync(join(tool, "config.toml"), "changed");
    return ok();
  };
}

test("Kimi producer observes exact native inventories, broker callbacks, Write controls, bytes and owned cleanup", async () => {
  const f = fixture(), before = readdirSync(f.context.root), results = await runKimiNativeProofs({ ...f.context, run: executablePort() }, f.prepared);
  expect(Object.keys(results).sort()).toEqual(["cleanup", "native-tool-loop", "network-guard-control", "write-absent", "write-positive-control"]);
  expect(Object.values(results).every(result => result.status === "pass" && result.cause === "ok")).toBe(true);
  expect(f.prepared.calls).toEqual(["hub_task_show", "hub_review"]);
  expect(readdirSync(f.context.root)).toEqual(before);
  expect(existsSync(f.effects)).toBe(false);
});
for (const fault of ["extra-tool", "missing-call", "forged-receipt", "config-changed"] as const) test(`Kimi cannot qualify ${fault} from a successful executable exit`, async () => {
  const f = fixture(), results = await runKimiNativeProofs({ ...f.context, run: executablePort(fault) }, f.prepared);
  expect(results["native-tool-loop"]).toEqual({ status: "fail", cause: "proof-failed" });
  expect(readdirSync(f.context.root).some(name => name.startsWith("kimi-native-"))).toBe(false);
});
test("Kimi explicit Write positive control must change the marker", async () => {
  const f = fixture(), results = await runKimiNativeProofs({ ...f.context, run: executablePort("missing-write") }, f.prepared);
  expect(results["write-absent"]).toEqual({ status: "pass", cause: "ok" });
  expect(results["write-positive-control"]).toEqual({ status: "fail", cause: "proof-failed" });
});
for (const fault of ["owned-stop", "survivor"] as const) test(`Kimi ${fault} prevents native and cleanup proof`, async () => {
  const f = fixture(), results = await runKimiNativeProofs({ ...f.context, run: executablePort(fault) }, f.prepared);
  expect(results["native-tool-loop"]).toEqual({ status: "fail", cause: "cleanup" });
  expect(results.cleanup).toEqual({ status: "fail", cause: "cleanup" });
});
test("Kimi timeout remains a timeout and removes owned temporary files", async () => {
  const f = fixture(), results = await runKimiNativeProofs({ ...f.context, run: executablePort("timeout") }, f.prepared);
  expect(results["native-tool-loop"]).toEqual({ status: "fail", cause: "timeout" });
  expect(readdirSync(f.context.root).some(name => name.startsWith("kimi-native-"))).toBe(false);
});
test("Kimi network positive control must produce the guard's actual refusal log", async () => {
  const f = fixture(), results = await runKimiNativeProofs({ ...f.context, run: executablePort("network-control") }, f.prepared);
  expect(results["network-guard-control"]).toEqual({ status: "fail", cause: "proof-failed" });
  expect(f.prepared.calls).toEqual([]);
});
test("Kimi wrapper refuses caller HOME before preparation or fake executable effects", async () => {
  const f = fixture();
  await expect(runKimiProofs({ ...f.context, run: executablePort() })).rejects.toMatchObject({ causeCode: "input" });
  expect(existsSync(f.effects)).toBe(false);
});
test("promoted Kimi preload is byte-identical to receipt-bound source", () => {
  const guard = readFileSync(new URL("../scripts/compat-receipts/proofs/kimi-loopback-only.cjs", import.meta.url));
  expect(createHash("sha256").update(guard).digest("hex")).toBe("f4e4714ac846c9e1861306f19c1c656350d1d4180818bd834aa34d1ae0ced8df");
});
