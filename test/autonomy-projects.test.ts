import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry, type Project } from "../src/hub/registry.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { readAutonomyDefaults, writeAutonomyDefaults } from "../src/hub/autonomy-defaults.ts";
import { runAllProjectAutonomy, inheritMachineAutonomy, prepareAutonomyProject } from "../src/cli/autonomy-projects.ts";
import { init } from "../src/cli/init.ts";
import { planOfflineAutonomy, applyOfflineAutonomy } from "../src/cli/autonomy-offline.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-all-autonomy-")), home = join(root, "hub"); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const env = { HOME: join(root, "home"), AGENTHUB_HOME: home, CLAUDE_CONFIG_DIR: join(root, "claude"), AMEM_HOME: join(root, "memory") };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  cleanup.push(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const registry = new Registry(join(home, "registry.db")); cleanup.push(() => registry.close());
  const project = (name: string) => {
    const repo = join(root, name); mkdirSync(repo);
    expect(hubGitSync(["init", "-q"], { cwd: repo, encoding: "utf8", timeout: 1000 }).status).toBe(0);
    mkdirSync(join(repo, ".agenthub")); writeFileSync(join(repo, ".agenthub/config.json"), '{}\n');
    return registry.register(repo);
  };
  return { root, home, registry, project };
}
test("all-projects previews every target then confirms once, writes0600 defaults and closes sessions", async () => {
  const p = fixture(), projects = [p.project("one"), p.project("two")], events: string[] = [], output: string[] = [];
  await runAllProjectAutonomy(["on", "--all-projects"], { home: p.home, environment: "terminal", projects,
    prepare: async project => { events.push(`preview:${project.id}`); return { lines: ["permission modes"], apply: async () => { events.push(`apply:${project.id}`); return ["saved"]; }, close: () => { events.push(`close:${project.id}`); } }; },
    ask: async () => { events.push("confirm"); expect(events.filter(event => event.startsWith("preview:"))).toHaveLength(2); expect(readAutonomyDefaults(p.home).enabled).toBe(false); return "y"; }, print: line => { output.push(line); },
  });
  expect(events.indexOf("confirm")).toBeLessThan(events.findIndex(event => event.startsWith("apply:")));
  expect(events.filter(event => event === "confirm")).toHaveLength(1);
  expect(events.filter(event => event.startsWith("close:"))).toHaveLength(2);
  expect(readAutonomyDefaults(p.home).enabled).toBe(true);
  expect(output.at(-1)).toContain("applied to 2");
});
test("declining or refusing an on preview changes no machine or project setting", async () => {
  for (const refused of [false, true]) {
    const p = fixture(), projects = [p.project("one")]; let applied = false;
    const run = runAllProjectAutonomy(["on", "--all-projects"], { home: p.home, environment: "terminal", projects,
      prepare: async () => { if (refused) throw new Error("unsafe project"); return { lines: [], apply: async () => { applied = true; return []; }, close() {} }; }, ask: async () => "n", print() {},
    });
    if (refused) await expect(run).rejects.toThrow("no machine or project setting was changed"); else await run;
    expect(applied).toBe(false); expect(readAutonomyDefaults(p.home).enabled).toBe(false);
  }
});
test("off disables the machine default and still applies other projects when one target refuses", async () => {
  const p = fixture(), projects = [p.project("one"), p.project("two")]; writeAutonomyDefaults(p.home, true, "absent"); let applied = 0;
  await expect(runAllProjectAutonomy(["off", "--all-projects"], { home: p.home, environment: "terminal", projects,
    prepare: async project => { if (project.id === projects[0]!.id) throw new Error("unavailable"); return { lines: [], apply: async () => { applied++; return []; }, close() {} }; }, ask: async () => { throw new Error("off must not ask"); }, print() {},
  })).rejects.toThrow("1 project(s) were not applied");
  expect(readAutonomyDefaults(p.home).enabled).toBe(false); expect(applied).toBe(1);
});
test("offline apply uses validated preset/undo writes and creates no consent or witnesses", async () => {
  const p = fixture(), project = p.project("one");
  const prepared = await prepareAutonomyProject(project, "terminal", true, p.registry); await prepared.apply(); prepared.close();
  const local = () => JSON.parse(readFileSync(join(project.root, ".agenthub/config.local.json"), "utf8"));
  expect(local().permission_modes.codex).toBe("never-ask"); expect(existsSync(join(p.home, "autonomy"))).toBe(false);
  expect(p.registry.get(project.id)?.instanceId).toBeNull();
  const edited = local(); edited.permission_modes.codex = "ask"; edited._autonomy = { version: 99 }; edited.research = { enabled: false };
  writeFileSync(join(project.root, ".agenthub/config.local.json"), JSON.stringify(edited));
  const off = planOfflineAutonomy(project, "terminal", false); applyOfflineAutonomy(project, "terminal", false, off);
  expect(local().permission_modes?.codex).toBeUndefined(); expect(local().research).toEqual({ enabled: false });
});
test("offline preview and registry claim fences refuse changed files and an already claimed project", async () => {
  const p = fixture(), project = p.project("one"), preview = planOfflineAutonomy(project, "terminal", true);
  writeFileSync(join(project.root, ".agenthub/config.local.json"), '{"research":{"enabled":false}}');
  expect(() => applyOfflineAutonomy(project, "terminal", true, preview)).toThrow("preview changed");
  const prepared = await prepareAutonomyProject(project, "terminal", true, p.registry);
  expect(p.registry.claim(project.id, "other", process.pid)).toBe(true);
  await expect(prepared.apply()).rejects.toThrow("live owner"); prepared.close();
  expect(p.registry.get(project.id)?.instanceId).toBe("other"); p.registry.release(project.id, "other");
});
test("new init inherits an opted-in machine while a machine without defaults preserves ask", async () => {
  for (const optedIn of [false, true]) {
    const p = fixture(), project = p.project("new");
    if (optedIn) writeAutonomyDefaults(p.home, true, "absent");
    init(project.root);
    const lines = await inheritMachineAutonomy(project, p.home, "terminal", p.registry);
    const file = join(project.root, ".agenthub/config.local.json");
    if (optedIn) { expect(lines[0]).toContain("Inherited"); expect(JSON.parse(readFileSync(file, "utf8")).permission_modes.codex).toBe("never-ask"); }
    else { expect(lines).toEqual([]); expect(existsSync(file)).toBe(false); }
    expect(existsSync(join(p.home, "autonomy"))).toBe(false);
  }
});
