import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ReceiptError, type ProofContext, type ProofResults } from "../types.ts";
import type { ReviewerLaunch, ReviewerPrepareContext } from "../../../src/adapters/reviewer-print.ts";

const contained = (root: string, value: string): boolean => {
  const part = relative(resolve(root), resolve(value));
  return part !== ".." && !part.startsWith("../") && !isAbsolute(part);
};
function check(value: unknown): asserts value { if (!value) throw new ReceiptError("proof-failed"); }
function mark(result: ProofResults, ids: readonly string[], status: "pass" | "fail", cause: "ok" | "proof-failed" | "cancelled" | "timeout" = "ok"): void {
  for (const id of ids) result[id] = { status, cause };
}
function failure(error: unknown, context: ProofContext): "proof-failed" | "cancelled" | "timeout" {
  if (context.signal.aborted) return "cancelled";
  return error instanceof ReceiptError && error.causeCode === "timeout" ? "timeout" : "proof-failed";
}
function fixtureEnvironment(context: ProofContext): void {
  if (resolve(process.env.HOME ?? "") !== resolve(context.home) || resolve(homedir()) !== resolve(context.home)) throw new ReceiptError("input");
  for (const key of ["HOME", "AGENTHUB_HOME", "AMEM_HOME", "TMPDIR", "XDG_CONFIG_HOME", context.id === "codex-review" ? "CODEX_HOME" : "KIMI_CODE_HOME"]) {
    const value = process.env[key];
    if (!value || !isAbsolute(value) || !contained(context.root, value)) throw new ReceiptError("input");
  }
}
function boundedText(file: string, context: ProofContext): string {
  const info = lstatSync(file);
  check(info.isFile() && !info.isSymbolicLink() && info.size <= context.limits.outputBytes);
  return readFileSync(file, "utf8");
}
async function release(launch: ReviewerLaunch | undefined): Promise<void> {
  try { await launch?.cleanup?.(); } catch { throw new ReceiptError("cleanup"); }
}
function removeFixture(file: string, recursive = false): void {
  try { rmSync(file, { recursive, force: true }); } catch { throw new ReceiptError("cleanup"); }
}

const CODEX_ATTESTED = ["model-free-mcp-inventory-disabled-ambient", "hub-tools-exact-allowlist", "plugins-and-hooks-disabled", "legacy-notify-disabled",
  "apps-disabled-effective-feature-readback", "web-search-disabled", "project-untrusted", "native-public-read-private-deny-write-deny",
  "native-glob-and-symlink-private-deny", "portable-core-name-and-state-deny", "standard-host-credential-roots-denied", "binary-config-stable",
  "binary-hash-once-metadata-fence", "session-ephemeral"] as const;

async function codex(context: ProofContext, result: ProofResults, trust: () => void): Promise<void> {
  const { codexReviewerBackend } = await import("../../../src/adapters/codex-review-isolation.ts");
  const { assessVersion } = await import("../../../src/adapters/compat.ts");
  const tool = process.env.CODEX_HOME!, config = join(tool, "config.toml");
  mkdirSync(tool, { recursive: true, mode: 0o700 });
  if (existsSync(config)) throw new ReceiptError("input");
  const prepare = async (name: string) => {
    const cwd = join(context.root, name); mkdirSync(cwd, { mode: 0o700 });
    const input: ReviewerPrepareContext = { peer: "codex-review", cwd, sessionId: "fixture-review", command: context.artifact.command,
      mcpConfig: JSON.stringify({ mcpServers: { "agent-hub": { command: "/usr/bin/false" } } }), systemPrompt: "Isolated model-free preparation only.",
      privatePaths: ["**/*.env", ".private", "nested/secret", "~/private-proof"], signal: context.signal };
    return await codexReviewerBackend.prepare(input);
  };
  // This is a real version refusal, not a patched COMPAT array. Already-admitted versions have no negative candidate leg.
  if (assessVersion("codex-review", context.version, []).ok) result["version-negative"] = { status: "not-run", cause: "not-applicable" };
  else {
    let negative: ReviewerLaunch | undefined;
    try {
      const value = await prepare("codex-version-negative");
      if (!("unavailable" in value)) negative = value;
      check("unavailable" in value && value.causeClass === "version");
      mark(result, ["version-negative"], "pass");
    } catch (error) { mark(result, ["version-negative"], "fail", failure(error, context)); }
    finally { await release(negative); }
  }
  trust();
  let binary: string | undefined;
  try {
    for (const ambient of [false, true]) {
      const id = ambient ? "ambient-prepare" : "empty-home-prepare";
      let launch: ReviewerLaunch | undefined;
      try {
        if (context.signal.aborted) throw new ReceiptError("cancelled");
        if (ambient) writeFileSync(config, 'notify = ["/usr/bin/false"]\n[features]\napps = true\nplugins = true\nhooks = true\n[mcp_servers.fixture_stdio]\ncommand = "/usr/bin/false"\n[mcp_servers.fixture_http]\nurl = "http://127.0.0.1:1"\n', { mode: 0o600 });
        const value = await prepare(ambient ? "codex-ambient" : "codex-empty");
        if ("unavailable" in value) throw new ReceiptError(value.causeClass === "timeout" ? "timeout" : "proof-failed");
        launch = value;
        check(launch.isolation.backend === "codex" && launch.isolation.version === context.version && launch.isolation.readOnly === true
          && launch.isolation.strictMcp === true && launch.isolation.ephemeral === true && launch.current?.() === true);
        check(/^sha256:[a-f0-9]{64}$/.test(launch.isolation.binary) && /^sha256:[a-f0-9]{64}$/.test(launch.isolation.profile));
        check(binary === undefined || binary === launch.isolation.binary); binary = launch.isolation.binary;
        check(launch.args[0] === "exec" && ["--ephemeral", "--ignore-user-config", "--ignore-rules", "notify=[]", 'web_search="disabled"'].every(arg => launch!.args.includes(arg)));
        // Trusted production prepare executes the metadata and sandbox canaries before returning this launch.
        // Do not inspect its descriptive evidence strings, and never execute the returned model command.
        mark(result, [id], "pass");
      } catch (error) { mark(result, [id], "fail", failure(error, context)); }
      finally { await release(launch); if (ambient) removeFixture(config); }
    }
    if (result["empty-home-prepare"]?.status === "pass" && result["ambient-prepare"]?.status === "pass") mark(result, CODEX_ATTESTED, "pass");
  } finally { removeFixture(config); }
}

export interface KimiPreparedFixture { launch: ReviewerLaunch; brokerConfig: string; calls: readonly string[] }
export type KimiNativeProof = (fixture: KimiPreparedFixture) => Promise<ProofResults>;

async function kimi(context: ProofContext, result: ProofResults, trust: () => void, native?: KimiNativeProof): Promise<void> {
  const { kimiReviewerBackend } = await import("../../../src/adapters/kimi-review.ts");
  const { createReviewerMcpSession } = await import("../../../src/adapters/reviewer-mcp.ts");
  const source = process.env.KIMI_CODE_HOME!;
  mkdirSync(source, { recursive: true, mode: 0o700 });
  if (["config.toml", "credentials", "oauth", "device_id"].some(name => existsSync(join(source, name)))) throw new ReceiptError("input");
  for (const name of ["credentials", "oauth"]) mkdirSync(join(source, name), { mode: 0o700 });
  const config = 'default_model="fixture"\ntelemetry=false\nhooks=[]\n[providers."managed:kimi-code"]\ntype="kimi"\nbase_url="https://api.kimi.ai/coding/v1"\n[providers."managed:kimi-code".oauth]\nstorage="file"\nkey="oauth/kimi-code"\noauth_host="https://auth.kimi.ai"\n[models.fixture]\nprovider="managed:kimi-code"\nmodel="kimi-for-coding"\nprotocol="anthropic"\nmax_context_size=32768\ncapabilities=["tool_use"]\n';
  const token = JSON.stringify({ access_token: "synthetic-access-only", expires_at: Math.floor(Date.now() / 1000) + 7200, expires_in: 7200, token_type: "Bearer", scope: "fixture" });
  writeFileSync(join(source, "config.toml"), config, { mode: 0o600 });
  writeFileSync(join(source, "device_id"), "synthetic-fixture-device", { mode: 0o600 });
  writeFileSync(join(source, "credentials/kimi-code.json"), token, { mode: 0o600 });
  const decoy = process.env.KIMI_CODE_TRUST_WORKSPACE;
  process.env.KIMI_CODE_TRUST_WORKSPACE = "fixture-decoy";
  const tools = ["hub_review", "hub_task_show", "hub_task_propose"].map(name => ({ name, description: "Synthetic host fixture", inputSchema: { type: "object" as const, properties: { id: { type: "integer" }, verdict: { type: "string" }, note: { type: "string" } }, required: ["id"], additionalProperties: false as const } }));
  let active = true; const calls: string[] = [];
  let broker: ReturnType<typeof createReviewerMcpSession> | undefined;
  let launch: ReviewerLaunch | undefined;
  let phase = "prepare";
  try {
    broker = createReviewerMcpSession({ task: 7, current: () => active, tools, call: async name => { calls.push(name); return "fixture result"; } });
    trust();
    const value = await kimiReviewerBackend.prepare({ peer: "kimi-review", cwd: context.cwd, sessionId: "fixture-review", task: 7,
      mcpConfig: broker.config, systemPrompt: "Synthetic preparation only; no native print child.", input: "Public fixture facts", privatePaths: [],
      command: context.artifact.command, signal: context.signal });
    check(!("unavailable" in value)); launch = value;
    check(launch.isolation.backend === "kimi" && launch.isolation.version === context.version && launch.current?.() === true && launch.envMode === "replace");
    mark(result, ["prepare"], "pass");
    phase = "inventory";
    const tool = launch.env?.KIMI_CODE_HOME, agent = launch.args[launch.args.indexOf("--agent-file") + 1], skills = launch.args[launch.args.indexOf("--skills-dir") + 1];
    check(tool && agent && skills && contained(context.root, tool) && contained(context.root, agent) && contained(context.root, skills));
    const text = boundedText(agent, context), end = text.indexOf("\n---", 4);
    check(text.startsWith("---\n") && end > 0);
    const front = Bun.YAML.parse(text.slice(4, end)) as { tools?: unknown; subagents?: unknown };
    check(JSON.stringify(front.tools) === JSON.stringify(["mcp__agent-hub__hub_review", "mcp__agent-hub__hub_task_show"]) && JSON.stringify(front.subagents) === "[]");
    check([agent, join(tool, "config.toml"), join(tool, "mcp.json")].every(file => (lstatSync(file).mode & 0o777) === 0o600));
    check(boundedText(join(tool, "mcp.json"), context) === broker.config);
    const preparedConfig = Bun.TOML.parse(boundedText(join(tool, "config.toml"), context)) as { providers?: object; hooks?: unknown; telemetry?: boolean };
    check(Object.keys(preparedConfig.providers ?? {}).join() === "managed:kimi-code" && JSON.stringify(preparedConfig.hooks) === "[]" && preparedConfig.telemetry === false);
    check(readdirSync(skills).length === 0);
    mark(result, ["inventory"], "pass");
    phase = "environment-decoy";
    check(launch.env?.KIMI_CODE_TRUST_WORKSPACE === undefined);
    mark(result, ["environment-decoy"], "pass");
    phase = "native-tool-loop";
    if (native) Object.assign(result, await native({ launch, brokerConfig: broker.config, calls }));
    phase = "broker-refusals";
    const callbackBaseline = calls.length;
    const binding = JSON.parse(broker.config).mcpServers["agent-hub"] as { url: string; headers: Record<string, string> };
    const rpc = async (name: string, id: number, authorize = true) => {
      const response = await fetch(binding.url, { method: "POST", signal: context.signal,
        headers: { "content-type": "application/json", ...(authorize ? binding.headers : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { id } } }) });
      if (!authorize) { check(response.status === 401); return; }
      const body = await response.json() as { error?: unknown }; check(body.error !== undefined);
    };
    await rpc("hub_review", 8); await rpc("hub_task_accept", 7); await rpc("hub_task_show", 7, false);
    active = false; await rpc("hub_task_show", 7); check(calls.length === callbackBaseline);
    mark(result, ["broker-refusals"], "pass");
    phase = "cleanup";
    check(boundedText(join(source, "config.toml"), context) === config && boundedText(join(source, "device_id"), context) === "synthetic-fixture-device");
    for (const name of ["credentials", "oauth", "device_id"]) check(readlinkSync(join(tool, name)) === join(source, name));
    await release(launch); launch = undefined;
    check(!existsSync(tool));
    check(boundedText(join(source, "config.toml"), context) === config && boundedText(join(source, "device_id"), context) === "synthetic-fixture-device");
    check(boundedText(join(source, "credentials/kimi-code.json"), context) === token);
    check(readdirSync(join(source, "credentials")).join() === "kimi-code.json" && readdirSync(join(source, "oauth")).length === 0);
    // Without the native callback this proves preparation cleanup only; native cleanup stays not-run.
  } catch (error) {
    if (error instanceof ReceiptError && error.causeCode === "cleanup") throw error;
    mark(result, [phase], "fail", failure(error, context));
  } finally {
    active = false; broker?.close();
    try { await release(launch); }
    finally {
      if (decoy === undefined) delete process.env.KIMI_CODE_TRUST_WORKSPACE; else process.env.KIMI_CODE_TRUST_WORKSPACE = decoy;
      for (const name of ["config.toml", "credentials", "oauth", "device_id"]) removeFixture(join(source, name), true);
    }
  }
}

/** Fresh isolated worker only. A Kimi callback may run fixed synthetic loopback controls. */
async function reviewerProofs(context: ProofContext, nativeKimi?: KimiNativeProof): Promise<ProofResults> {
  if (context.id !== "codex-review" && context.id !== "kimi-review") return {};
  if (context.signal.aborted) throw new ReceiptError("cancelled");
  fixtureEnvironment(context);
  const { writeTrust } = await import("../../../src/adapters/compat.ts");
  const { realPath } = await import("../../../src/hub/project.ts");
  const physicalRoot = realPath(context.root);
  for (const key of ["HOME", "AGENTHUB_HOME", "AMEM_HOME", "TMPDIR", "XDG_CONFIG_HOME", context.id === "codex-review" ? "CODEX_HOME" : "KIMI_CODE_HOME"]) {
    check(lstatSync(process.env[key]!).isDirectory() && contained(physicalRoot, realPath(process.env[key]!)));
  }
  const hub = process.env.AGENTHUB_HOME!; mkdirSync(hub, { recursive: true, mode: 0o700 });
  check(contained(realPath(context.root), realPath(hub)));
  const trustFile = join(hub, "agent-compat.json");
  if (existsSync(trustFile)) throw new ReceiptError("input");
  const result: ProofResults = {};
  if (context.id === "codex-review") {
    result["model-backed-hub-call"] = { status: "not-run", cause: "model-required" };
    result.control = { status: "not-run", cause: "install-unavailable" };
    result["source-impact"] = { status: "not-run", cause: "source-review-required" };
    result["tag-binding"] = { status: "not-run", cause: "producer-not-committed" };
  } else {
    for (const id of ["native-tool-loop", "write-absent", "write-positive-control", "network-guard-control", "cleanup"]) result[id] = { status: "not-run", cause: "producer-not-committed" };
    result["source-review"] = { status: "not-run", cause: "source-review-required" };
  }
  const trust = () => {
    if (context.signal.aborted) throw new ReceiptError("cancelled");
    writeTrust(context.id, context.version, false, trustFile);
  };
  try {
    if (context.id === "codex-review") await codex(context, result, trust); else await kimi(context, result, trust, nativeKimi);
    return result;
  } finally { removeFixture(trustFile); }
}

export async function runReviewerProofs(context: ProofContext, nativeKimi?: KimiNativeProof): Promise<ProofResults> {
  try { return await reviewerProofs(context, nativeKimi); }
  catch (error) { throw error instanceof ReceiptError ? error : new ReceiptError("proof-failed"); }
}
