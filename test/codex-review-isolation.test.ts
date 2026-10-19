import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { realPath } from "../src/hub/project.ts";
import { codexCoreDenyGlobs, codexReviewerBackend } from "../src/adapters/codex-review-isolation.ts";
import type { ReviewerPrepareContext } from "../src/adapters/reviewer-print.ts";

function fixture(mode = "ok") {
  const root = mkdtempSync(join(tmpdir(), "ahub-codex-review-proof-")), cwd = join(root, "repo");
  mkdirSync(cwd);
  const script = join(root, "fake.ts"), calls = join(root, "calls.jsonl");
  writeFileSync(calls, "");
  writeFileSync(script, `import { appendFileSync } from "node:fs";
const [mode, calls, ...a] = process.argv.slice(2);
appendFileSync(calls!, JSON.stringify(a) + "\\n");
if(a[0] === "--version") { console.log(mode === "version" ? "codex-cli 0.163.0" : "codex-cli 0.146.0"); process.exit(0); }
if(a[0] === "exec") { throw new Error("model must not run in isolation prepare"); }
if(mode === "abort") await new Promise(() => {});
if(mode === "overflow") { console.log("x".repeat(140000)); process.exit(0); }
if(a[0] === "features" && a[1] === "list") {
 const rows = mode === "featuresmissing" ? "plugins stable false" : mode === "featuresduplicate" ? "apps stable false\\napps stable false" : mode === "featuresmalformed" ? "apps stable unknown" : "apps stable " + (mode === "apps" ? "true" : "false") + "\\nplugins stable false\\nhooks stable false";
 console.log(rows);
} else if(a[0] === "mcp" && a[1] === "list") {
 const overridden = a.some(x => x.startsWith("mcp_servers="));
 const rows = [{name:"ambient",enabled:!overridden,transport:{type:mode === "transport" ? "unknown" : "stdio",command:"/usr/bin/false"}}];
 if(overridden) rows.push({name:"agent-hub",enabled:true,transport:{type:"stdio",command:"/usr/bin/false"}});
 if(mode === "collision") rows.push({name:"agent-hub",enabled:true,transport:{type:"stdio",command:"/usr/bin/false"}});
 if(mode === "drift" && overridden) rows.push({name:"new-ambient",enabled:true,transport:{type:"stdio",command:"/usr/bin/false"}});
 console.log(JSON.stringify(rows));
} else if(a[0] === "mcp" && a[1] === "get") console.log(JSON.stringify({name:"agent-hub",enabled:true,transport:{type:"stdio",command:mode === "hubcommand" ? "/bin/echo" : "/usr/bin/false",args:[],env:{}},enabled_tools:mode === "tools" ? ["hub_send"] : ["hub_review","hub_task_show"]}));
else if(a[0] === "sandbox") console.log(mode === "sandbox" ? "READ_ALLOWED" : "AHUB_CODEX_PUBLIC_READ\\nAHUB_CODEX_PRIVATE_DENIED\\nAHUB_CODEX_WRITE_DENIED" + (mode === "glob" ? "" : "\\nAHUB_CODEX_GLOB_PRIVATE_DENIED\\nAHUB_CODEX_ALIAS_PRIVATE_DENIED" + (mode === "core" ? "" : "\\nAHUB_CODEX_CORE_NAME_DENIED\\nAHUB_CODEX_CORE_STATE_DENIED" + (mode === "host" ? "" : "\\nAHUB_CODEX_HOST_CONFIG_DENIED\\nAHUB_CODEX_HOST_KUBE_DENIED\\nAHUB_CODEX_HOST_DOCKER_DENIED\\nAHUB_CODEX_HOST_ALIAS_DENIED"))));
else if(a[0] === "debug") console.log(mode === "catalog" ? "x".repeat(256000) : mode === "catalogoverflow" ? "x".repeat(4200000) : "{}");
else process.exit(1);
`);
  const ctx: ReviewerPrepareContext = { peer: "codex-review", cwd, sessionId: "fresh-proof", command: [process.execPath, script, mode, calls], signal: new AbortController().signal, mcpConfig: JSON.stringify({ mcpServers: { "agent-hub": { command: "/usr/bin/false", args: [] } } }), systemPrompt: "Review only", privatePaths: ["**/*.env", ".private", "nested/secret", "~/private-proof"] };
  return { root, cwd, script, calls, ctx, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("Codex isolation proves bounded MCP and sandbox before returning fixed ephemeral profile", async () => {
  const f = fixture();
  try {
    const result = await codexReviewerBackend.prepare(f.ctx);
    expect("unavailable" in result).toBe(false);
    if ("unavailable" in result) return;
    expect(result.isolation).toMatchObject({ backend: "codex", version: "0.146.0", strictMcp: true, readOnly: true, ephemeral: true });
    expect(result.args).toContain("--ignore-user-config");
    expect(result.args).toContain("--ignore-rules");
    expect(result.args).toContain("--ephemeral");
    expect(result.args.some((arg, index) => arg === "--disable" && result.args[index + 1] === "apps")).toBe(true);
    expect(result.args).toContain('web_search="disabled"');
    expect(result.args).not.toContain("--sandbox");
    expect(result.args.some(arg => arg.startsWith("default_permissions="))).toBe(true);
    const override = result.args.find(arg => arg.startsWith("mcp_servers="))!;
    const configured = Bun.TOML.parse(override) as { mcp_servers: Record<string, { enabled?: boolean; enabled_tools?: string[] }> };
    expect(configured.mcp_servers.ambient?.enabled).toBe(false);
    expect(configured.mcp_servers["agent-hub"]?.enabled_tools).toEqual(["hub_review", "hub_task_show"]);
    const permissions = Bun.TOML.parse(result.args.find(arg => arg.startsWith("permissions="))!) as { permissions: Record<string, { filesystem: Record<string, string> }> };
    const filesystem = permissions.permissions["ahub-review"]!.filesystem;
    expect(filesystem[join(realPath(f.cwd), "**", ".private")]).toBe("deny");
    expect(filesystem[join(realPath(f.cwd), "**", "*nested/secret*")]).toBe("deny");
    expect(filesystem[join(realPath(f.cwd), "**", "*.private*")]).toBe("deny");
    expect(filesystem[join(realPath(f.cwd), "**", "*.private*", "**")]).toBe("deny");
    expect(filesystem[join(homedir(), "private-proof")]).toBe("deny");
    expect(Object.keys(filesystem).some(key => key.includes("/glob/**/*.env"))).toBe(true);
    expect(filesystem["/**/.env*"]).toBe("deny");
    expect(filesystem["/**/.agenthub/state"]).toBe("deny");
    expect(filesystem["/**/.agenthub/state/**"]).toBe("deny");
    expect(result.args).not.toContain("resume");
    const calls = readFileSync(f.calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(calls.some(args => args[0] === "exec")).toBe(false);
    expect(calls.filter(args => args[0] === "mcp" && args[1] === "list")).toHaveLength(2);
    expect(calls.some(args => args[0] === "features" && args[1] === "list")).toBe(true);
    await result.cleanup?.();
  } finally { f.close(); }
});

for (const mode of ["version", "apps", "featuresmissing", "featuresduplicate", "featuresmalformed", "transport", "collision", "drift", "tools", "hubcommand", "sandbox", "glob", "core", "host", "overflow"]) test(`Codex isolation refuses ${mode} without a model turn`, async () => {
  const f = fixture(mode);
  try {
    const result = await codexReviewerBackend.prepare(f.ctx);
    expect(result).toHaveProperty("unavailable");
    expect(readFileSync(f.calls, "utf8")).not.toContain('["exec"');
  } finally { f.close(); }
});

test("Codex isolation refuses project-owned command prefixes", async () => {
  const f = fixture();
  try {
    const local = join(f.cwd, "fake.ts"); writeFileSync(local, "throw new Error('must not run')");
    expect(await codexReviewerBackend.prepare({ ...f.ctx, command: [process.execPath, local] })).toHaveProperty("unavailable");
  } finally { f.close(); }
});

test("Codex isolation abort stops the owned metadata process", async () => {
  const f = fixture("abort"), controller = new AbortController();
  try {
    const pending = codexReviewerBackend.prepare({ ...f.ctx, signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    expect(await pending).toHaveProperty("unavailable");
  } finally { f.close(); }
});


test("Codex receipt current rejects binary or config drift before model spawn", async () => {
  const f = fixture();
  try {
    const result = await codexReviewerBackend.prepare(f.ctx);
    expect("unavailable" in result).toBe(false);
    if ("unavailable" in result) return;
    expect(result.current?.()).toBe(true);
    mkdirSync(join(f.cwd, ".codex")); writeFileSync(join(f.cwd, ".codex", "config.toml"), "# changed");
    expect(result.current?.()).toBe(false);
    await result.cleanup?.();
  } finally { f.close(); }
  const other = fixture();
  try {
    const result = await codexReviewerBackend.prepare(other.ctx);
    expect("unavailable" in result).toBe(false);
    if ("unavailable" in result) return;
    writeFileSync(other.script, readFileSync(other.script, "utf8") + "\n// changed");
    expect(result.current?.()).toBe(false);
    await result.cleanup?.();
  } finally { other.close(); }
});

// Native 0.146.0 bundles a catalog larger than the MCP inventory limit. Only its exit status is needed.
test("Codex configuration proof drains a bounded catalog without retaining it", async () => {
  for (const mode of ["catalog", "catalogoverflow"]) {
    const f = fixture(mode);
    try {
      const result = await codexReviewerBackend.prepare(f.ctx);
      expect("unavailable" in result).toBe(mode === "catalogoverflow");
      if (!("unavailable" in result)) await result.cleanup?.();
    } finally { f.close(); }
  }
});


test("Codex core policy translation conservatively adapts literals and refuses unfamiliar regexes", () => {
  expect(codexCoreDenyGlobs(["^credentials(\\.|$)", "\\.pem$", "^auth\\.json$"], [".agenthub/state"])).toEqual([
    "/**/credentials*", "/**/credentials*/**", "/**/*.pem", "/**/*.pem/**", "/**/auth.json", "/**/auth.json/**", "/**/.agenthub/state", "/**/.agenthub/state/**",
  ]);
  expect(() => codexCoreDenyGlobs(["^unknown[0-9]"], [])).toThrow("unverified core deny pattern");
  expect(() => codexCoreDenyGlobs(["unanchored"], [])).toThrow("unverified core deny pattern");
  expect(() => codexCoreDenyGlobs([], ["../state"])).toThrow("unverified core deny segment");
});


test("Codex metadata fence detects a same-content binary-prefix replacement while no child is running", async () => {
  const f = fixture();
  try {
    const result = await codexReviewerBackend.prepare(f.ctx);
    expect("unavailable" in result).toBe(false);
    if ("unavailable" in result) return;
    expect(result.current?.()).toBe(true);
    const before = statSync(f.script), content = readFileSync(f.script);
    renameSync(f.script, `${f.script}.old`); writeFileSync(f.script, content);
    utimesSync(f.script, before.atime, before.mtime);
    expect(statSync(f.script).size).toBe(before.size);
    expect(result.current?.()).toBe(false);
    await result.cleanup?.();
  } finally { f.close(); }
});


test("Codex denies standard and configured credential roots from a synthetic HOME without hiding the checkout", async () => {
  const f = fixture(), home = join(f.root, "home"), xdg = join(f.root, "xdg"), linked = join(f.root, "linked-config");
  const values: Record<string, string> = { HOME: home, XDG_CONFIG_HOME: xdg, CODEX_HOME: join(f.root, "codex-home"), CLAUDE_CONFIG_DIR: join(f.root, "claude-home"), KIMI_CODE_HOME: join(f.root, "kimi-home") };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const dir of Object.values(values)) mkdirSync(dir, { recursive: true });
    mkdirSync(join(linked, "gh"), { recursive: true }); symlinkSync(linked, join(home, ".config"));
    writeFileSync(join(linked, "gh", "hosts.yml"), "synthetic credential canary");
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    const result = await codexReviewerBackend.prepare(f.ctx);
    expect("unavailable" in result).toBe(false);
    if ("unavailable" in result) return;
    const parsed = Bun.TOML.parse(result.args.find(arg => arg.startsWith("permissions="))!) as { permissions: Record<string, { filesystem: Record<string, string> }> };
    const filesystem = parsed.permissions["ahub-review"]!.filesystem;
    for (const dir of [".config", ".ssh", ".aws", ".azure", ".kube", ".docker", ".gnupg", ".codex", ".claude", ".kimi", ".kimi-code", ".gemini"]) {
      expect(filesystem[join(realPath(home), dir)]).toBe("deny");
      expect(filesystem[join(realPath(home), dir, "**")]).toBe("deny");
    }
    for (const dir of [xdg, linked, values.CODEX_HOME!, values.CLAUDE_CONFIG_DIR!, values.KIMI_CODE_HOME!]) expect(filesystem[realPath(dir)]).toBe("deny");
    expect(filesystem[realPath(f.cwd)]).not.toBe("deny");
    expect(result.isolation.evidence).toContain("standard-host-credential-roots-denied");
    await result.cleanup?.();
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    f.close();
  }
});

for (const mode of ["checkout", "glob"] as const) test(`Codex refuses an unsafe configured credential root (${mode}) without a model turn`, async () => {
  const f = fixture(), previous = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = mode === "checkout" ? f.root : join(f.root, "config[unsupported]");
    expect(await codexReviewerBackend.prepare(f.ctx)).toHaveProperty("unavailable");
    expect(readFileSync(f.calls, "utf8")).not.toContain('["exec"');
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous;
    f.close();
  }
});
