import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import { loadConfig } from "../src/hub/daemon.ts";
import { idFor } from "../src/hub/registry.ts";
import { projectRoot } from "../src/hub/project.ts";
import { HUB_SKILL_NAMES } from "../src/adapters/definitions/native-cli-claude-setup.ts";
import { hubJcodeHomePath, jcodeOwnHome, planJcodeHome, sameJcodeHome } from "../src/adapters/definitions/native-cli-jcode-home.ts";
import { installHubSkillsInJcodeHomes, installSkillsInJcodeHome, jcodeHomeApplicable, jcodeHomeSkillStates, jcodeSkillHomes, planJcodeHomeInit } from "../src/adapters/definitions/native-cli-jcode-home-init.ts";

// #1627 A: init creates a separate hub-owned jcode home. Every test uses fixture homes only and never reads or writes the person's real ~/.jcode.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const SOURCE = join(import.meta.dir, "..", "plugins", "agent-hub", "skills");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-jcode-home-")); roots.push(root);
  const user = join(root, "user"), hub = join(root, "hub"), own = join(user, ".jcode"), project = join(root, "project");
  mkdirSync(own, { recursive: true }); mkdirSync(join(project, ".agenthub"), { recursive: true });
  writeFileSync(join(own, "mcp.json"), JSON.stringify({ servers: { amem: { command: "amem", args: ["mcp"] }, vmem: { command: "vmem" }, ares: { command: "ares" }, "computer-use": { command: "cu" } } }));
  writeFileSync(join(own, "auth.json"), "SECRET-AUTH");
  writeFileSync(join(own, "config.toml"), "model = \"x\"\n");
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH"]) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { HOME: user, AGENTHUB_HOME: hub, GIT_CONFIG_GLOBAL: "/dev/null" });
  expect(hubGitSync(["init", "-q"], { cwd: project, env, encoding: "utf8", timeout: 3000 }).status).toBe(0);
  const run = (args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...args], { cwd: project, env, stdin: null });
  const digest = (dir: string): string => {
    const hash = createHash("sha256");
    const walk = (path: string) => { for (const name of readdirSync(path).sort()) { const full = join(path, name), info = lstatSync(full); hash.update(full.slice(dir.length)); if (info.isDirectory()) walk(full); else hash.update(readFileSync(full)); } };
    walk(dir); return hash.digest("hex");
  };
  return { root, user, hub, own, project, env, run, digest, home: hubJcodeHomePath(hub, idFor(projectRoot(project))) };
}
const text = (result: { stdout: Buffer; stderr: Buffer }) => `${result.stdout.toString()}${result.stderr.toString()}`;
const stageJcode = (project: string, extra: Record<string, unknown> = {}) => writeFileSync(join(project, ".agenthub", "config.local.json"), JSON.stringify({ roster: { jcode: true }, jcode_mcp_allow: ["amem", "ares", "vmem"], ...extra }));

test("AC1: init creates the hub-owned home with only the hub entry plus allowed entries, sets jcode_home, and leaves the person's home byte-identical", () => {
  const f = fixture(); stageJcode(f.project);
  const before = f.digest(f.own);
  const done = f.run(["init", "--yes"]);
  expect(done.exitCode, text(done)).toBe(0);
  expect(existsSync(f.home)).toBe(true);
  const servers = JSON.parse(readFileSync(join(f.home, "mcp.json"), "utf8")).servers;
  expect(Object.keys(servers).sort()).toEqual(["agent-hub-jcode", "amem", "ares", "vmem"]); // computer-use is not allowed, so it is not copied
  expect(servers.amem).toEqual({ command: "amem", args: ["mcp"] });
  expect(existsSync(join(f.home, "auth.json"))).toBe(false); // no login, session or history is copied
  expect(readdirSync(f.home).sort()).toEqual(["mcp.json", "skills"]);
  expect(lstatSync(join(f.home, "mcp.json")).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(join(f.project, ".agenthub", "config.local.json"), "utf8")).jcode_home).toBe(f.home);
  expect(f.digest(f.own)).toBe(before); // the person's own home is byte-identical
  expect(text(done)).toContain(`JCODE_HOME='${f.home}' jcode login`); // the complete person step
  expect(readFileSync(join(f.project, ".agenthub", "config.json"), "utf8")).not.toContain("jcode_home"); // never the tracked config
});

test("AC1b: the hub-owned home and every instance home get the hub skill trees, and the doctor read reports them", async () => {
  const f = fixture(); stageJcode(f.project);
  expect(f.run(["init", "--yes"]).exitCode).toBe(0);
  const instance = join(f.root, "instance-home"); mkdirSync(instance);
  const config = { ...loadConfig(f.project), instances: { "jcode-two": { kind: "jcode", jcode_home: instance } } } as ReturnType<typeof loadConfig>;
  const homes = jcodeSkillHomes(config, f.env, f.user);
  expect(homes.sort()).toEqual([f.home, instance].sort());
  const lines: string[] = [];
  await installHubSkillsInJcodeHomes({ source: SOURCE, homes, yes: true, print: line => lines.push(line) });
  for (const home of homes) expect(HUB_SKILL_NAMES.every(name => existsSync(join(home, "skills", name, ".ahub-skill.json")))).toBe(true);
  expect(jcodeHomeSkillStates(homes, HUB_SKILL_NAMES).map(state => state.state)).toEqual(["installed", "installed"]);
  // A tree the person edited is reported and left alone.
  writeFileSync(join(instance, "skills", HUB_SKILL_NAMES[0], "SKILL.md"), "edited\n");
  expect(jcodeHomeSkillStates([instance], HUB_SKILL_NAMES)[0]!.state).toBe("modified");
  // The person's own home never receives them from this path.
  expect(existsSync(join(f.own, "skills"))).toBe(false);
  // Undo removes only the unmodified trees.
  await installHubSkillsInJcodeHomes({ homes: [f.home], undo: true, yes: true, print: line => lines.push(line) });
  expect(HUB_SKILL_NAMES.some(name => existsSync(join(f.home, "skills", name)))).toBe(false);
});

test("AC2: init is idempotent and reports drift", () => {
  const f = fixture(); stageJcode(f.project);
  expect(f.run(["init", "--yes"]).exitCode).toBe(0);
  const homeDigest = f.digest(f.home), config = readFileSync(join(f.project, ".agenthub", "config.local.json"), "utf8");
  const again = f.run(["init", "--yes"]);
  expect(again.exitCode, text(again)).toBe(0);
  expect(f.digest(f.home)).toBe(homeDigest); expect(readFileSync(join(f.project, ".agenthub", "config.local.json"), "utf8")).toBe(config);
  expect(text(again)).toContain("drift"); // no login there yet
  expect(text(again)).toContain(`JCODE_HOME='${f.home}' jcode login`);
  // An allowed server missing from the hub-owned home is named with its fix.
  const mcp = JSON.parse(readFileSync(join(f.home, "mcp.json"), "utf8")); delete mcp.servers.vmem;
  writeFileSync(join(f.home, "mcp.json"), JSON.stringify(mcp));
  const drifted = f.run(["init", "--yes"]);
  expect(text(drifted)).toContain("lacks vmem");
  expect(JSON.parse(readFileSync(join(f.home, "mcp.json"), "utf8")).servers.vmem).toBeUndefined(); // reported, never rewritten
});

test("AC2: --no-jcode-home and --dry-run write nothing for the jcode home", () => {
  const f = fixture(); stageJcode(f.project);
  const skipped = f.run(["init", "--yes", "--no-jcode-home"]);
  expect(skipped.exitCode, text(skipped)).toBe(0);
  expect(existsSync(f.home)).toBe(false);
  expect(readFileSync(join(f.project, ".agenthub", "config.local.json"), "utf8")).not.toContain("jcode_home");
  const dry = f.run(["init", "--dry-run", "--json"]);
  expect(dry.exitCode, text(dry)).toBe(0);
  expect(existsSync(f.home)).toBe(false);
  const plan = JSON.parse(dry.stdout.toString()) as { path: string; reason: string }[];
  expect(plan.some(row => row.path === f.home)).toBe(true);
  expect(JSON.stringify(plan)).not.toContain("SECRET");
});

test("init offers nothing when jcode is neither installed nor rostered, or when jcode_home is already separate", () => {
  const f = fixture();
  const config = loadConfig(f.project);
  const base = { ...config, jcode_home: f.own, roster: {} } as ReturnType<typeof loadConfig>;
  expect(jcodeHomeApplicable(base, f.env, false, f.user)).toBe(false);
  expect(jcodeHomeApplicable(base, f.env, true, f.user)).toBe(true);
  expect(jcodeHomeApplicable({ ...base, jcode_home: join(f.root, "elsewhere") } as typeof base, f.env, true, f.user)).toBe(false);
  const alias = join(f.root, "alias"); symlinkSync(f.own, alias);
  expect(sameJcodeHome(alias, f.own)).toBe(true); // a link spelling the person's home is still the person's home
  const plan = planJcodeHomeInit({ cwd: f.project, stateDir: join(f.project, ".agenthub", "state"), bundle: "/x/server.js", hubHome: f.hub, config: { ...base, jcode_home: join(f.root, "elsewhere") } as typeof base, env: f.env, installed: true, user: f.user });
  expect(plan.plan?.home).toBe(join(f.root, "elsewhere")); // an existing separate home is kept and only checked
});

test("a tracked config.local.json is never written for jcode_home", () => {
  const f = fixture(); stageJcode(f.project);
  expect(hubGitSync(["add", "-f", ".agenthub/config.local.json"], { cwd: f.project, encoding: "utf8", env: f.env }).status).toBe(0);
  const done = f.run(["init", "--yes"]);
  expect(text(done)).toContain("committed to git");
  expect(done.exitCode).toBe(1);
  expect(readFileSync(join(f.project, ".agenthub", "config.local.json"), "utf8")).not.toContain("jcode_home");
});

test("the planner copies only allowed entries and names an allowed server the person's mcp.json lacks", () => {
  const f = fixture();
  const plan = planJcodeHome({ home: join(f.root, "new"), own: jcodeOwnHome({}, f.user), cwd: f.project, stateDir: "/s", bundle: "/b.js", allow: ["amem", "missing-one"] });
  expect(Object.keys(plan.servers).sort()).toEqual(["agent-hub-jcode", "amem"]);
  expect(plan.absentAllowed).toEqual(["missing-one"]);
  expect(plan.exists).toBe(false);
  expect(installSkillsInJcodeHome).toBeTypeOf("function");
});
