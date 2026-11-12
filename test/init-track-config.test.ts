import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import { ROLES_TRACKED, ROLES_UNTRACKED, ignoreRule } from "../src/cli/init.ts";
import { DEFAULT_CONFIG, loadConfig } from "../src/hub/daemon.ts";
import { ALL_MACHINE_LOCAL } from "../src/hub/config-trust.ts";
import { realPath } from "../src/hub/project.ts";

// #1411 T1: `ahub init --track-config | --no-track-config`, the block's role sentence, ignore entries through git check-ignore, and "config.local.json wins".
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const made = mkdtempSync(join(tmpdir(), "ahub-init-track-")); roots.push(made);
  const root = realPath(made), user = join(root, "user"), home = join(root, "hub"); mkdirSync(user);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || key.startsWith("CODEX_") || key === "CLAUDECODE" || key === "CLAUDE_CODE_SESSION_ID" || key.startsWith("ORCA_") || key === "CI") delete env[key];
  // GIT_CONFIG_GLOBAL keeps the person's own global ignore file out of the verdicts.
  Object.assign(env, { HOME: user, AGENTHUB_HOME: home, CLAUDE_CONFIG_DIR: join(user, "claude"), AMEM_HOME: join(root, "memory"), GIT_CONFIG_GLOBAL: "/dev/null" });
  const cwd = join(root, "project"); mkdirSync(cwd);
  expect(hubGitSync(["init", "-q"], { cwd, env, encoding: "utf8", timeout: 3000 }).status).toBe(0);
  const run = (args: string[]) => { const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), "init", ...args], { cwd, env, stdin: "ignore" }); return { code: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}` }; };
  const ignored = (path: string) => hubGitSync(["check-ignore", "-q", "--no-index", "--", path], { cwd, env, encoding: "utf8", timeout: 3000 }).status === 0;
  const text = (path: string) => existsSync(join(cwd, path)) ? readFileSync(join(cwd, path), "utf8") : "";
  return { cwd, run, ignored, text };
}
const SHARED = [".agenthub/config.json", ".agenthub/routing.toml", ".agenthub/sdlc.toml"];

test("--track-config leaves the shared files visible to git and names them; --no-track-config ignores them; the role sentence follows (AC1)", () => {
  const tracked = fixture();
  const on = tracked.run(["--track-config"]);
  expect(on.code, on.out).toBe(0);
  for (const path of SHARED) expect(tracked.ignored(path)).toBe(false);
  expect(on.out).toContain("commit AGENTS.md and .agenthub/config.json, .agenthub/routing.toml");
  expect(on.out).toContain("it wins over config.json");
  expect(tracked.text("AGENTS.md")).toContain(ROLES_TRACKED);
  expect(tracked.text("AGENTS.md")).not.toContain(ROLES_UNTRACKED);

  const untracked = fixture();
  const off = untracked.run(["--no-track-config"]);
  expect(off.code, off.out).toBe(0);
  for (const path of SHARED) expect(untracked.ignored(path)).toBe(true);
  expect(off.out).toContain("stay untracked: each checkout and each machine holds its own roles");
  expect(untracked.text("AGENTS.md")).toContain(ROLES_UNTRACKED);
  expect(untracked.text("AGENTS.md")).not.toContain(ROLES_TRACKED);
});

test("init with neither flag on an existing project changes neither the ignore state nor the role sentence (AC2)", () => {
  for (const choice of ["--track-config", "--no-track-config"]) {
    const p = fixture();
    expect(p.run([choice]).code).toBe(0);
    const before = { ignore: p.text(".gitignore"), agents: p.text("AGENTS.md") };
    const again = p.run([]);
    expect(again.code, again.out).toBe(0);
    expect(p.text(".gitignore")).toBe(before.ignore);
    expect(p.text("AGENTS.md")).toBe(before.agents);
  }
});

test("--track-config with a rule that ignores .agenthub/ names the rule and the file and writes nothing (AC3)", () => {
  const p = fixture();
  writeFileSync(join(p.cwd, ".gitignore"), "node_modules/\n.agenthub/\n");
  const refused = p.run(["--track-config"]);
  expect(refused.code).toBe(1);
  expect(refused.out).toContain(".agenthub/config.json is ignored by .gitignore:2:.agenthub/");
  expect(refused.out).toContain("nothing was written");
  expect(refused.out).not.toContain("Next steps:");
  expect(existsSync(join(p.cwd, "AGENTS.md"))).toBe(false);
  expect(existsSync(join(p.cwd, ".agenthub"))).toBe(false);
  expect(p.text(".gitignore")).toBe("node_modules/\n.agenthub/\n");
});

test("a ! rule that re-includes a file is not an ignore rule; a directory rule is", () => {
  const p = fixture();
  mkdirSync(join(p.cwd, ".agenthub"));
  writeFileSync(join(p.cwd, ".gitignore"), "/.agenthub/*\n!/.agenthub/config.json\n");
  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null"; // this process's own global ignore file stays out of the verdict
  try {
    expect(ignoreRule(p.cwd, ".agenthub/config.json")).toBeNull();
    expect(ignoreRule(p.cwd, ".agenthub/routing.toml")).toBe(".gitignore:1:/.agenthub/*");
    const plain = mkdtempSync(join(tmpdir(), "ahub-init-norepo-")); roots.push(plain);
    expect(ignoreRule(realPath(plain), ".agenthub/config.json")).toBeUndefined();
  } finally { if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved; }
});

test("init adds no .gitignore line for a path git already ignores (AC6)", () => {
  const p = fixture();
  writeFileSync(join(p.cwd, ".gitignore"), ".agenthub/\n");
  const done = p.run([]);
  expect(done.code, done.out).toBe(0);
  expect(p.text(".gitignore")).toBe(".agenthub/\n");
  const fresh = fixture();
  expect(fresh.run([]).code).toBe(0);
  expect(fresh.text(".gitignore")).toBe(".agenthub/state/\n.agenthub/config.local.json\n.agenthub/routing.local.toml\n");
});

test("--track-config keeps a routing.toml that names a machine endpoint out of git and reports personal values in config.json", () => {
  const p = fixture();
  mkdirSync(join(p.cwd, ".agenthub"));
  writeFileSync(join(p.cwd, ".agenthub/routing.toml"), '[hub_routes."hub/decision"]\ntype = "stage"\nefficient = "fast"\ncapable = "coding"\ndecision_backend = "adec"\nadec_endpoint = "http://127.0.0.1:8740/v1/route"\n');
  writeFileSync(join(p.cwd, ".agenthub/config.json"), JSON.stringify({ kimi_cmd: ["/opt/kimi/bin/kimi", "acp"] }, null, 2) + "\n");
  const done = p.run(["--track-config"]);
  expect(done.code, done.out).toBe(0);
  expect(p.ignored(".agenthub/routing.toml")).toBe(true);
  expect(p.ignored(".agenthub/config.json")).toBe(false);
  expect(done.out).toContain('.agenthub/routing.toml stays untracked: hub_routes."hub/decision".adec_endpoint');
  expect(done.out).not.toContain("commit AGENTS.md and .agenthub/config.json, .agenthub/routing.toml");
  expect(done.out).toContain("move kimi_cmd from .agenthub/config.json to .agenthub/config.local.json");
});

test("config.local.json wins over config.json key by key, for a key of every top-level block and per peer in roles (#1411 owner comment)", () => {
  const p = fixture();
  const exceptions = new Set<string>(["release", "action_policy", "rooms", "research.runners", ...ALL_MACHINE_LOCAL]);
  const shared: Record<string, Record<string, unknown>> = {}, local: Record<string, Record<string, unknown>> = {};
  const expected: [string, string, unknown][] = [];
  for (const [block, value] of Object.entries(DEFAULT_CONFIG as unknown as Record<string, unknown>)) {
    if (exceptions.has(block) || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const leaf = Object.entries(value as Record<string, unknown>).find(([key, item]) => !exceptions.has(`${block}.${key}`) && (typeof item === "boolean" || typeof item === "number" && Number.isInteger(item) && item > 2));
    if (!leaf) continue;
    const [key, item] = leaf;
    const [mine, theirs] = typeof item === "boolean" ? [!item, item] : [(item as number) - 1, (item as number) - 2];
    (shared[block] ??= {})[key] = theirs; (local[block] ??= {})[key] = mine;
    expected.push([block, key, mine]);
  }
  expect(expected.length).toBeGreaterThan(5);
  const config = loadConfig(p.cwd, [
    { name: "config.json", raw: { ...shared, roles: { claude: ["planner"], codex: ["implementer"] } } },
    { name: "config.local.json", raw: { ...local, roles: { claude: ["reviewer"] } } },
  ] as never) as unknown as Record<string, Record<string, unknown>>;
  for (const [block, key, mine] of expected) expect({ [`${block}.${key}`]: config[block]![key] }).toEqual({ [`${block}.${key}`]: mine });
  expect(config.roles!.claude).toEqual(["reviewer"]);
  expect(config.roles!.codex).toEqual(["implementer"]);
});
