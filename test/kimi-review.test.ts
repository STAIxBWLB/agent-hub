import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kimiReviewerBackend } from "../src/adapters/kimi-review.ts";
import { realPath } from "../src/hub/project.ts";
import type { ReviewerPrepareContext } from "../src/adapters/reviewer-print.ts";

const drops: (() => unknown)[] = [];
afterEach(() => { for (const drop of drops.splice(0).reverse()) drop(); });
function fixture(version = "2.2.0") {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-kimi-review-test-")));
  drops.push(() => rmSync(root, { recursive: true, force: true }));
  const nativeHome = join(root, "native"), project = join(root, "project");
  for (const dir of [nativeHome, project, join(nativeHome, "credentials"), join(nativeHome, "oauth")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(nativeHome, "device_id"), "fixture-device");
  writeFileSync(join(nativeHome, "credentials/kimi-code.json"), "synthetic-credential-canary");
  writeFileSync(join(nativeHome, "oauth/kimi-code"), "synthetic-oauth-sentinel-canary");
  writeFileSync(join(nativeHome, "config.toml"), 'default_model = "managed-model"\n[providers."managed:kimi-code"]\ntype = "kimi"\nbase_url = "https://api.kimi.ai/coding/v1"\napi_key = ""\n[providers."managed:kimi-code".oauth]\nstorage = "file"\nkey = "oauth/kimi-code"\noauth_host = "https://auth.kimi.ai"\n[providers.ambient]\ntype = "openai"\napi_key = "must-not-copy"\n[models.managed-model]\nprovider = "managed:kimi-code"\nmodel = "kimi-for-coding"\n[models.ambient-model]\nprovider = "ambient"\nmodel = "not-selected"\n');
  writeFileSync(join(nativeHome, "mcp.json"), '{"mcpServers":{"decoy":{}}}');
  const fake = join(root, "fake-kimi.ts"); writeFileSync(fake, `if(process.argv.at(-1)==="--version")console.log(${JSON.stringify(version)});else process.exit(9);`);
  const old = process.env.KIMI_CODE_HOME; process.env.KIMI_CODE_HOME = nativeHome;
  drops.push(() => { if (old === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = old; });
  const context: ReviewerPrepareContext = { peer: "kimi-review", cwd: project, sessionId: "fixture-session", task: 7,
    mcpConfig: JSON.stringify({ mcpServers: { "agent-hub": { transport: "http", url: "http://127.0.0.1:12345/mcp", headers: { Authorization: "Bearer fixture" } } } }),
    systemPrompt: "Fixture role", input: "Fixture public task facts", privatePaths: [], command: [process.execPath, fake], signal: new AbortController().signal };
  return { context, nativeHome, project };
}

test("Kimi reviewer shares auth directories but isolates config, prompt and native cwd", async () => {
  const f = fixture(); const launch = await kimiReviewerBackend.prepare(f.context);
  expect("unavailable" in launch).toBe(false); if ("unavailable" in launch) return;
  drops.push(() => launch.cleanup?.());
  expect(launch.envMode).toBe("replace");
  expect(launch.watchCurrent).toBe(true);
  expect(launch.cwd).not.toBe(f.project);
  expect(launch.env?.KIMI_DISABLE_OAUTH_LOCK).toBeUndefined();
  const home = launch.env!.KIMI_CODE_HOME!;
  expect(readlinkSync(join(home, "credentials"))).toBe(join(f.nativeHome, "credentials"));
  expect(readlinkSync(join(home, "oauth"))).toBe(join(f.nativeHome, "oauth"));
  expect(readlinkSync(join(home, "device_id"))).toBe(join(f.nativeHome, "device_id"));
  const config = readFileSync(join(home, "config.toml"), "utf8");
  expect(config).not.toContain("ambient"); expect(config).not.toContain("must-not-copy");
  const index = launch.args.indexOf("--agent-file");
  const agent = readFileSync(launch.args[index + 1]!, "utf8");
  expect(agent).toContain("Fixture public task facts");
  expect(launch.args).not.toContain("Fixture public task facts");
  expect(launch.isolation.enforcement).toBe("native-policy");
  expect(launch.current?.()).toBe(true);
  await launch.cleanup?.();
  expect(readFileSync(join(f.nativeHome, "device_id"), "utf8")).toBe("fixture-device");
  expect(readFileSync(join(f.nativeHome, "credentials/kimi-code.json"), "utf8")).toBe("synthetic-credential-canary");
  expect(readFileSync(join(f.nativeHome, "oauth/kimi-code"), "utf8")).toBe("synthetic-oauth-sentinel-canary");
});

test("Kimi reviewer frontmatter permits exactly two MCP tools and no subagents", async () => {
  const f = fixture(), launch = await kimiReviewerBackend.prepare(f.context);
  expect("unavailable" in launch).toBe(false); if ("unavailable" in launch) return;
  try {
    const agent = readFileSync(launch.args[launch.args.indexOf("--agent-file") + 1]!, "utf8");
    const lines = agent.split("\n"); expect(lines.shift()).toBe("---");
    const end = lines.indexOf("---"); expect(end).toBeGreaterThan(0);
    const frontmatter = Bun.YAML.parse(lines.slice(0, end).join("\n")) as { tools: unknown; subagents: unknown };
    expect(frontmatter.tools).toEqual(["mcp__agent-hub__hub_review", "mcp__agent-hub__hub_task_show"]);
    expect(frontmatter.subagents).toEqual([]);
  } finally { await launch.cleanup?.(); }
});

for (const marker of [".git", ".kimi-code", "AGENTS.md"]) test(`Kimi refuses private cwd beneath an ambient ${marker} ancestor`, async () => {
  const f = fixture(), temporary = join(f.project, "temporary"); mkdirSync(temporary);
  // A gitfile and a dangling MCP symlink are still existing ambient marker names.
  if (marker === ".kimi-code") symlinkSync(join(f.project, "missing-target"), join(f.project, marker));
  else writeFileSync(join(f.project, marker), "synthetic ambient marker");
  const previous = process.env.TMPDIR; process.env.TMPDIR = temporary;
  drops.push(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; });
  const result = await kimiReviewerBackend.prepare(f.context);
  if (!("unavailable" in result)) drops.push(() => result.cleanup?.());
  expect(result).toHaveProperty("unavailable");
  if ("unavailable" in result) expect(result.unavailable).toContain("private cwd ancestor contains ambient configuration");
});

test("Kimi refuses an ambient lexical ancestor even when TMPDIR resolves through a clean symlink target", async () => {
  const f = fixture(), lexical = join(f.project, "lexical"), safe = join(f.nativeHome, "clean-temp");
  mkdirSync(lexical); mkdirSync(safe); writeFileSync(join(lexical, "AGENTS.md"), "synthetic lexical instructions");
  const link = join(lexical, "temp-link"); symlinkSync(safe, link, "dir");
  const previous = process.env.TMPDIR; process.env.TMPDIR = link;
  drops.push(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; });
  const result = await kimiReviewerBackend.prepare(f.context);
  if (!("unavailable" in result)) drops.push(() => result.cleanup?.());
  expect(result).toHaveProperty("unavailable");
  if ("unavailable" in result) expect(result.unavailable).toContain("private cwd ancestor contains ambient configuration");
});

test("Kimi reviewer refuses unsupported versions and cancelled preparation", async () => {
  const f = fixture("2.1.1");
  expect(await kimiReviewerBackend.prepare(f.context)).toHaveProperty("unavailable");
  const controller = new AbortController(); controller.abort();
  expect(await kimiReviewerBackend.prepare({ ...f.context, signal: controller.signal })).toHaveProperty("unavailable");
});

test("Kimi reviewer refuses an ambient or full-token MCP plan", async () => {
  const f = fixture();
  for (const mcpConfig of ['{"mcpServers":{"agent-hub":{"command":"bun","args":["server.js"]}}}', '{"mcpServers":{"other":{}}}']) {
    expect(await kimiReviewerBackend.prepare({ ...f.context, mcpConfig })).toHaveProperty("unavailable");
  }
});

test("Kimi retains selected managed protocol controls and refuses unsupported model shape", async () => {
  const f = fixture(); const file = join(f.nativeHome, "config.toml");
  writeFileSync(file, readFileSync(file, "utf8").replace('default_model = "managed-model"', 'thinking = true\ndefault_model = "managed-model"').replace('[models.managed-model]','[models.managed-model]\nbeta_api = true\nadaptive_thinking = true\noverrides = { default_effort = "high" }'));
  const result = await kimiReviewerBackend.prepare(f.context);
  expect("unavailable" in result).toBe(false); if ("unavailable" in result) return;
  try {
    const config = Bun.TOML.parse(readFileSync(join(result.env!.KIMI_CODE_HOME!, "config.toml"), "utf8")) as any;
    expect(config.thinking).toBe(true);
    expect(config.models["managed-model"]).toMatchObject({ beta_api: true, adaptive_thinking: true, overrides: { default_effort: "high" } });
  } finally { await result.cleanup?.(); }
});

test("Kimi current fence follows both native and private auth directory targets", async () => {
  const f = fixture(), directory = join(f.nativeHome, "credentials"), first = join(f.nativeHome, "first-credentials"), next = join(f.nativeHome, "next-credentials");
  renameSync(directory, first); mkdirSync(next); symlinkSync(first, directory, "dir");
  const result = await kimiReviewerBackend.prepare(f.context);
  expect("unavailable" in result).toBe(false); if ("unavailable" in result) return;
  try { expect(result.current?.()).toBe(true); unlinkSync(directory); symlinkSync(next, directory, "dir"); expect(result.current?.()).toBe(false); }
  finally { await result.cleanup?.(); }
});


test("Kimi refuses invalid managed auth, endpoints, slots and model overrides before launch", async () => {
  const f = fixture(), file = join(f.nativeHome, "config.toml"), original = readFileSync(file, "utf8");
  for (const [before, after] of [
    ['type = "kimi"', 'type = "openai"'],
    ['api_key = ""', 'api_key = "static-key-not-allowed"'],
    ['storage = "file"', 'storage = "keychain"'],
    ['https://api.kimi.ai/coding/v1', 'http://api.kimi.ai/coding/v1'],
    ['https://api.kimi.ai/coding/v1', 'https://example.test/coding/v1'],
    ['https://auth.kimi.ai', 'https://example.test/oauth'],
    ['key = "oauth/kimi-code"', 'key = "oauth/../other"'],
    ['[models.managed-model]', '[models.managed-model]\nunknown_option = true'],
    ['[models.managed-model]', '[models.managed-model]\noverrides = { provider = "ambient" }'],
  ]) {
    writeFileSync(file, original.replace(before!, after!));
    expect(await kimiReviewerBackend.prepare(f.context)).toHaveProperty("unavailable");
  }
  writeFileSync(file, original);
  renameSync(join(f.nativeHome, "credentials"), join(f.nativeHome, "missing-credentials"));
  expect(await kimiReviewerBackend.prepare(f.context)).toHaveProperty("unavailable");
});

test("Kimi malformed config refusal never echoes native configuration values", async () => {
  const f = fixture();
  writeFileSync(join(f.nativeHome, "config.toml"), 'api_key = "synthetic-private-value"\nbroken = ["synthetic-private-value"\n');
  const result = await kimiReviewerBackend.prepare(f.context);
  expect("unavailable" in result).toBe(true);
  if ("unavailable" in result) expect(result.unavailable).not.toContain("synthetic-private-value");
});

test("Kimi current fence refuses an ambient ancestor created after preparation", async () => {
  const f=fixture(), temporary=join(f.project,"temporary");mkdirSync(temporary);
  const prior=process.env.TMPDIR;process.env.TMPDIR=temporary;
  drops.push(()=>{if(prior===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=prior;});
  const result=await kimiReviewerBackend.prepare(f.context);
  expect("unavailable" in result).toBe(false);if("unavailable" in result)return;
  drops.push(()=>result.cleanup?.());expect(result.current?.()).toBe(true);
  writeFileSync(join(f.project,"AGENTS.md"),"synthetic ambient instruction");
  expect(result.current?.()).toBe(false);
});


test("receipt-covered Kimi 2.3.0 still requires the private runtime preparation (#373)", async () => {
  const f = fixture("2.3.0"), launch = await kimiReviewerBackend.prepare(f.context);
  expect("unavailable" in launch).toBe(false); if ("unavailable" in launch) return;
  try { expect(launch.isolation.version).toBe("2.3.0"); expect(launch.current?.()).toBe(true); }
  finally { await launch.cleanup?.(); }
});
