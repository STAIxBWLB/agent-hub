import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ADAPTERS } from "../src/adapters/registry.ts";
import { ControlClient, readControl } from "../src/hub/control-client.ts";
import { HUB_DB_SCHEMA, HubDbSchemaError } from "../src/hub/db-schema.ts";
import { realPath } from "../src/hub/project.ts";
import { Registry, type Project } from "../src/hub/registry.ts";
import { packageDigest, preserveRuntimePackage, verifyPackage } from "../src/cli/recovery-package.ts";
import { VERSION } from "../src/version.ts";
import type { DaemonOptions } from "../src/hub/daemon.ts";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");

/** Every subprocess and imported lifecycle uses only this fixture's homes and native discovery path. */
function isolated(root: string): { env: NodeJS.ProcessEnv; restore(): void } {
  const before = { ...process.env }, env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || key.startsWith("OMNIROUTE_") || key.startsWith("CF_ACCESS_")
    || /(?:_API_KEY|_ACCESS_TOKEN|_SECRET|_TOKEN)$/.test(key)) delete env[key];
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"]) delete env[key];
  const bin = join(root, "bin"); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "git"), '#!/bin/sh\nexec /usr/bin/git "$@"\n'); chmodSync(join(bin, "git"), 0o700);
  Object.assign(env, { HOME: join(root, "home"), AGENTHUB_HOME: join(root, "hub-home"), AMEM_HOME: join(root, "amem-home"),
    CLAUDE_CONFIG_DIR: join(root, "claude-home"), CODEX_HOME: join(root, "codex-home"), KIMI_CODE_HOME: join(root, "kimi-home"),
    PI_CODING_AGENT_DIR: join(root, "pi-home"), QWEN_CODE_HOME: join(root, "qwen-home"), GEMINI_CLI_HOME: join(root, "gemini-home"),
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PATH: bin });
  for (const key of ["HOME", "AGENTHUB_HOME", "AMEM_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "KIMI_CODE_HOME", "PI_CODING_AGENT_DIR", "QWEN_CODE_HOME", "GEMINI_CLI_HOME"])
    mkdirSync(env[key]!, { recursive: true });
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(env, key)) delete process.env[key];
  Object.assign(process.env, env);
  return { env, restore() {
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(before, key)) delete process.env[key];
    Object.assign(process.env, before);
  } };
}
async function command(argv: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const child = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0); return stdout;
}

test("#607 real lifecycle daemon runs from its retained source digest after the mutable invoking install is removed", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-retained-daemon-"))), scope = isolated(root);
  let lifecycle: typeof import("../src/hub/lifecycle.ts") | undefined, project: Project | undefined, instanceId: string | undefined;
  let stopped = false;
  try {
    // Bounded package preservation copies only runtime assets and the exact first-party core, never a node_modules tree.
    const digest = verifyPackage(PACKAGE_ROOT, VERSION), fakeGlobal = join(root, "mutable-global");
    preserveRuntimePackage(PACKAGE_ROOT, fakeGlobal, digest);
    const loaded = await import(pathToFileURL(join(fakeGlobal, "src/hub/lifecycle.ts")).href) as typeof import("../src/hub/lifecycle.ts");
    lifecycle = loaded;
    const projectRoot = join(root, "project"); mkdirSync(join(projectRoot, ".agenthub"), { recursive: true });
    await command(["/usr/bin/git", "init", "-q", projectRoot], scope.env);
    writeFileSync(join(projectRoot, ".agenthub/config.json"), JSON.stringify({
      roster: Object.fromEntries(ADAPTERS.map(adapter => [adapter.kind, false])), roles: {},
      memory: { enabled: false }, inference: { enabled: false }, omniroute: { urls: [], access_hosts: [] },
      mlx: { enabled: false }, pi: { enabled: false, auto_start: false }, recovery: { auto_resume_after_crash: false },
      snapshots: { enabled: false }, task_sweep: { enabled: false }, approvals: { notify: false }, terminal: { open: [] },
    }));
    const registry = new Registry();
    try { project = registry.register(realPath(projectRoot)); } finally { registry.close(); }
    const status = await loaded.startProject(project, { env: scope.env });
    instanceId = status.instanceId;
    expect(typeof instanceId).toBe("string"); expect(status.version).toBe(VERSION);
    const retainedRoot = realPath(join(scope.env.AGENTHUB_HOME!, "releases", VERSION, `source-${digest}`));
    expect(packageDigest(retainedRoot, { ownDependencies: true })).toBe(digest);
    const argv = await command(["/bin/ps", "-p", String(status.pid), "-o", "command="], scope.env);
    expect(argv).toContain(join(retainedRoot, "src/cli/main.ts")); expect(argv).not.toContain(fakeGlobal);
    for (const peer of Object.values(status.peers) as { state: string }[]) expect(peer.state).toBe("offline");
    // The running child must remain controllable with the mutable package entirely absent.
    writeFileSync(join(fakeGlobal, "src/cli/main.ts"), 'throw new Error("replaced mutable global runtime");\n');
    rmSync(fakeGlobal, { recursive: true }); expect(existsSync(fakeGlobal)).toBe(false);
    const client = await ControlClient.connect(project.stateDir, { role: "console", projectId: project.id, projectRoot: project.root, instanceId });
    try {
      const readback = await client.request({ t: "status" });
      expect(readback.status.instanceId).toBe(instanceId); expect(readback.status.pid).toBe(status.pid); expect(readback.status.version).toBe(VERSION);
    } finally { client.close(); }
    await loaded.stopProject(project, instanceId); stopped = true;
    expect(readControl(project.stateDir)).toBeUndefined();
    expect((await loaded.inspectProject(project)).state).toBe("stopped");
  } finally {
    try {
      // Stop only this registered fixture project; a failed cleanup keeps its files for inspection.
      if (project && lifecycle && !stopped) { await lifecycle.stopProject(project, instanceId); stopped = true; }
      if (!project || stopped) rmSync(root, { recursive: true, force: true });
    } finally { scope.restore(); }
  }
}, 20_000);

test("#607 startDaemon refuses future hub_schema before configuration, external loader, log, session or control effects", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-early-schema-"))), scope = isolated(root);
  try {
    const { startDaemon } = await import("../src/hub/daemon.ts"), stateDir = join(root, "state"); mkdirSync(stateDir);
    const file = join(stateDir, "hub.db"), db = new Database(file);
    db.run("CREATE TABLE hub_schema (id INTEGER PRIMARY KEY,schema INTEGER NOT NULL,required_version TEXT NOT NULL)");
    db.query("INSERT INTO hub_schema VALUES(1,?,?)").run(HUB_DB_SCHEMA + 1, "99.0.0");
    db.run("CREATE TABLE sentinel (value TEXT)"); db.run("INSERT INTO sentinel VALUES('preserved')"); db.close();
    for (const name of ["hub.log", "events.jsonl", "sessions.json", "claude-session.json"]) writeFileSync(join(stateDir, name), `preserve fixture ${name}\n`);
    const names = readdirSync(stateDir).sort(), before = Object.fromEntries(names.map(name => [name, readFileSync(join(stateDir, name))]));
    const touched: string[] = [];
    // The external module loader requires cwd; none of its imports/factories can be reached before this getter.
    const options = Object.defineProperties({ stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0 }, {
      cwd: { get() { touched.push("cwd/external-loader"); throw new Error("startup crossed schema guard"); } },
      config: { get() { touched.push("config"); throw new Error("configuration read before schema guard"); } },
      terminal: { get() { touched.push("terminal"); throw new Error("terminal read before schema guard"); } },
    }) as DaemonOptions;
    await expect(startDaemon(options)).rejects.toThrow(HubDbSchemaError);
    await expect(startDaemon(options)).rejects.toThrow("use 99.0.0 or later");
    expect(touched).toEqual([]); expect(readdirSync(stateDir).sort()).toEqual(names);
    for (const name of names) expect(readFileSync(join(stateDir, name))).toEqual(before[name]!);
    expect(existsSync(join(stateDir, "status.json"))).toBe(false);
    expect(existsSync(join(stateDir, "control-token"))).toBe(false);
    const inspect = new Database(file, { readonly: true });
    try { expect(inspect.query("SELECT value FROM sentinel").get()).toEqual({ value: "preserved" }); }
    finally { inspect.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); scope.restore(); }
}, 20_000);
