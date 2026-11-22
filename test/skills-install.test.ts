import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SUPPORTED_PEERS } from "../src/adapters/registry.ts";
import {
  SKILL_HOSTS, SKILL_MARKER, applySkillPlan, applySkillUndo, hostSkillDir, installHubSkills,
  skillHostStates, skillInstallPlan, skillStateRow, skillUndoPlan,
} from "../src/cli/skills-install.ts";
import { VERSION } from "../src/version.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function writeTree(source: string, name: string, body: string): void {
  mkdirSync(join(source, name), { recursive: true });
  writeFileSync(join(source, name, "SKILL.md"), body);
}

function fixture(hosts: readonly string[] = SKILL_HOSTS) {
  const root = mkdtempSync(join(tmpdir(), "ahub-skills-"));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const source = join(root, "source");
  writeTree(source, "ahub-status", "# status\n");
  writeTree(source, "ahub", "# person control\n");
  const env: NodeJS.ProcessEnv = {};
  for (const host of hosts) mkdirSync(dirname(hostSkillDir(host as never, home, env)), { recursive: true });
  return { root, home, env, source };
}

const skillsDir = (f: ReturnType<typeof fixture>, host: string) => hostSkillDir(host as never, f.home, f.env);
const skillDir = (f: ReturnType<typeof fixture>, host: string, name: string) => join(skillsDir(f, host), name);
const expected = ["ahub", "ahub-status"];

test("each host's user skill directory comes from its own home variable or default", () => {
  const home = "/home/fixture";
  expect(hostSkillDir("codex", home, {})).toBe(join(home, ".codex", "skills"));
  expect(hostSkillDir("codex", home, { CODEX_HOME: "/x/codex" })).toBe(join("/x/codex", "skills"));
  expect(hostSkillDir("kimi", home, {})).toBe(join(home, ".kimi-code", "skills"));
  expect(hostSkillDir("kimi", home, { KIMI_CODE_HOME: "/x/kimi" })).toBe(join("/x/kimi", "skills"));
  expect(hostSkillDir("qwen", home, {})).toBe(join(home, ".qwen", "skills"));
  expect(hostSkillDir("qwen", home, { QWEN_HOME: "/x/qwen" })).toBe(join("/x/qwen", "skills"));
  expect(hostSkillDir("jcode", home, {})).toBe(join(home, ".jcode", "skills"));
  expect(hostSkillDir("jcode", home, { JCODE_HOME: "/x/jcode" })).toBe(join("/x/jcode", "skills"));
  expect(hostSkillDir("pi", home, {})).toBe(join(home, ".pi", "agent", "skills"));
  expect(hostSkillDir("pi", home, { PI_CODING_AGENT_DIR: "/x/pi" })).toBe(join("/x/pi", "skills"));
  expect(hostSkillDir("agy", home, {})).toBe(join(home, ".gemini", "config", "skills"));
});

test("the skill host list is every supported peer that reads a user skill directory", () => {
  // Claude Code reads the plugin's copy and the hub's local worker gets the hub tools directly, so neither has one.
  const readers = SUPPORTED_PEERS.filter(peer => peer !== "claude" && peer !== "local");
  expect([...SKILL_HOSTS].sort().join(",")).toBe([...readers].sort().join(","));
});

test("the source lists one skill per directory and ignores a file beside them", () => {
  const f = fixture();
  writeFileSync(join(f.source, "README.md"), "not a skill");
  const names = [...new Set(skillInstallPlan(f.source, f).map(entry => entry.skill))];
  expect(names).toEqual(["ahub", "ahub-status"]);
});

test("install writes one tree and marker per skill, and a second plan is unchanged", () => {
  const f = fixture();
  const plan = skillInstallPlan(f.source, f);
  expect(plan).toHaveLength(SKILL_HOSTS.length * 2);
  expect(plan.every(entry => entry.action === "install")).toBe(true);

  const done = applySkillPlan(f.source, plan);
  expect(done.every(entry => entry.action === "install")).toBe(true);
  const dir = skillDir(f, "codex", "ahub-status");
  expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe("# status\n");
  const marker = JSON.parse(readFileSync(join(dir, SKILL_MARKER), "utf8")) as Record<string, unknown>;
  expect(marker["tool"]).toBe("agent-hub");
  expect(marker["version"]).toBe(VERSION);
  expect(marker["sha256"]).toMatch(/^[a-f0-9]{64}$/);

  expect(skillInstallPlan(f.source, f).every(entry => entry.action === "unchanged")).toBe(true);
  expect(skillHostStates(f, expected).every(state => state.state === "installed")).toBe(true);
});

test("another tool's skills in the same directory are never read, replaced or removed", () => {
  const f = fixture();
  const mine = skillDir(f, "codex", "my-own");
  mkdirSync(mine, { recursive: true });
  writeFileSync(join(mine, "SKILL.md"), "# mine\n");
  applySkillPlan(f.source, skillInstallPlan(f.source, f));
  expect(readFileSync(join(mine, "SKILL.md"), "utf8")).toBe("# mine\n");
  expect(existsSync(join(mine, SKILL_MARKER))).toBe(false);
  expect(skillHostStates(f, expected).find(state => state.host === "codex")!.state).toBe("installed");
  applySkillUndo(skillUndoPlan(f));
  expect(readFileSync(join(mine, "SKILL.md"), "utf8")).toBe("# mine\n");
  expect(existsSync(skillDir(f, "codex", "ahub-status"))).toBe(false);
});

test("a hub tree whose marker names an older version is replaced", () => {
  const f = fixture();
  applySkillPlan(f.source, skillInstallPlan(f.source, f));
  const dir = skillDir(f, "kimi", "ahub-status");
  const marker = JSON.parse(readFileSync(join(dir, SKILL_MARKER), "utf8")) as Record<string, unknown>;
  writeFileSync(join(dir, SKILL_MARKER), JSON.stringify({ ...marker, version: "0.0.0" }) + "\n");

  const stale = skillInstallPlan(f.source, f).find(entry => entry.host === "kimi" && entry.skill === "ahub-status")!;
  expect(stale.action).toBe("replace");
  expect(stale.detail).toContain("0.0.0");
  applySkillPlan(f.source, skillInstallPlan(f.source, f));
  const rewritten = JSON.parse(readFileSync(join(dir, SKILL_MARKER), "utf8")) as Record<string, unknown>;
  expect(rewritten["version"]).toBe(VERSION);
  expect(skillInstallPlan(f.source, f).find(entry => entry.host === "kimi" && entry.skill === "ahub-status")!.action).toBe("unchanged");
});

test("source content changed at the same version replaces the hub's own tree", () => {
  const f = fixture();
  applySkillPlan(f.source, skillInstallPlan(f.source, f));
  writeTree(f.source, "ahub-status", "# status v2\n");
  const plan = skillInstallPlan(f.source, f);
  expect(plan.filter(entry => entry.skill === "ahub-status").every(entry => entry.action === "replace")).toBe(true);
  expect(plan.filter(entry => entry.skill === "ahub").every(entry => entry.action === "unchanged")).toBe(true);
  applySkillPlan(f.source, plan);
  expect(readFileSync(join(skillDir(f, "qwen", "ahub-status"), "SKILL.md"), "utf8")).toBe("# status v2\n");
});

test("a locally modified tree is reported and left exactly as it is", () => {
  const f = fixture();
  applySkillPlan(f.source, skillInstallPlan(f.source, f));
  const dir = skillDir(f, "pi", "ahub-status");
  const edited = join(dir, "SKILL.md");
  writeFileSync(edited, "# edited\n");
  const markerBefore = readFileSync(join(dir, SKILL_MARKER), "utf8");

  const plan = skillInstallPlan(f.source, f);
  expect(plan.find(entry => entry.host === "pi" && entry.skill === "ahub-status")!.action).toBe("modified");
  expect(plan.find(entry => entry.host === "pi" && entry.skill === "ahub")!.action).toBe("unchanged");
  applySkillPlan(f.source, plan);
  expect(readFileSync(edited, "utf8")).toBe("# edited\n");
  expect(readFileSync(join(dir, SKILL_MARKER), "utf8")).toBe(markerBefore);
});

test("a foreign tree is never replaced: no marker or another tool's marker", () => {
  const f = fixture();
  const codex = skillDir(f, "codex", "ahub-status");
  mkdirSync(codex, { recursive: true });
  writeFileSync(join(codex, "SKILL.md"), "# theirs\n");
  const kimi = skillDir(f, "kimi", "ahub-status");
  mkdirSync(kimi, { recursive: true });
  writeFileSync(join(kimi, SKILL_MARKER), JSON.stringify({ tool: "vmem", version: "1.0.0", sha256: "0".repeat(64) }));

  const plan = skillInstallPlan(f.source, f);
  expect(plan.find(entry => entry.host === "codex" && entry.skill === "ahub-status")!.action).toBe("foreign");
  expect(plan.find(entry => entry.host === "kimi" && entry.skill === "ahub-status")!.action).toBe("foreign");
  applySkillPlan(f.source, plan);
  expect(readFileSync(join(codex, "SKILL.md"), "utf8")).toBe("# theirs\n");
  expect(existsSync(join(codex, SKILL_MARKER))).toBe(false);
  expect(readFileSync(join(kimi, SKILL_MARKER), "utf8")).toContain("vmem");
  // The hub's other skill still installs on that host.
  expect(existsSync(join(skillDir(f, "codex", "ahub"), SKILL_MARKER))).toBe(true);
});

test("a tree that appears while the question is open is kept, never written over", () => {
  const f = fixture();
  const plan = skillInstallPlan(f.source, f);
  const dir = skillDir(f, "qwen", "ahub-status");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "# appeared\n");

  const entry = applySkillPlan(f.source, plan).find(item => item.host === "qwen" && item.skill === "ahub-status")!;
  expect(entry.action).toBe("foreign");
  expect(entry.detail).toContain("changed since the plan");
  expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe("# appeared\n");
  expect(existsSync(join(dir, SKILL_MARKER))).toBe(false);
  expect(existsSync(join(skillDir(f, "qwen", "ahub"), SKILL_MARKER))).toBe(true);
});

test("a linked skill directory is refused, the link target is untouched, and the other skill still installs", () => {
  const f = fixture();
  const dir = skillDir(f, "jcode", "ahub-status");
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "SKILL.md"), "# outside\n");
  mkdirSync(skillsDir(f, "jcode"), { recursive: true });
  symlinkSync(outside, dir);

  const entry = skillInstallPlan(f.source, f).find(item => item.host === "jcode" && item.skill === "ahub-status")!;
  expect(entry.action).toBe("linked");
  applySkillPlan(f.source, skillInstallPlan(f.source, f));
  expect(readFileSync(join(outside, "SKILL.md"), "utf8")).toBe("# outside\n");
  expect(existsSync(join(outside, SKILL_MARKER))).toBe(false);
  expect(existsSync(join(skillDir(f, "jcode", "ahub"), SKILL_MARKER))).toBe(true);
});

test("a symlinked skills directory is refused and nothing is written through the link", () => {
  const f = fixture();
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, skillsDir(f, "pi"));

  const plan = skillInstallPlan(f.source, f);
  const pi = plan.filter(entry => entry.host === "pi");
  expect(pi).toHaveLength(1);
  expect(pi[0]!.action).toBe("linked");
  applySkillPlan(f.source, plan);
  expect(existsSync(join(outside, "ahub"))).toBe(false);
  expect(existsSync(join(outside, "ahub-status"))).toBe(false);
  expect(existsSync(join(skillDir(f, "codex", "ahub"), SKILL_MARKER))).toBe(true);
  expect(skillHostStates(f, expected).find(state => state.host === "pi")!.state).toBe("linked");
  expect(skillUndoPlan(f).filter(entry => entry.host === "pi")).toHaveLength(1);
});

test("a skills directory turned into a link after the plan is not written through", () => {
  const f = fixture();
  const plan = skillInstallPlan(f.source, f);
  const skills = skillsDir(f, "codex");
  const outside = join(f.root, "outside-codex");
  mkdirSync(outside);
  rmSync(skills, { recursive: true, force: true });
  symlinkSync(outside, skills);

  const codex = applySkillPlan(f.source, plan).filter(entry => entry.host === "codex");
  expect(codex).toHaveLength(2);
  expect(codex.every(entry => entry.action === "linked")).toBe(true);
  expect(codex[0]!.detail).toContain("became a link");
  expect(readdirSync(outside)).toEqual([]);
});

test("undo planned before the skills directory became a link removes nothing", () => {
  const f = fixture();
  applySkillPlan(f.source, skillInstallPlan(f.source, f));
  const plan = skillUndoPlan(f);
  const skills = skillsDir(f, "kimi");
  const moved = join(f.root, "kimi-skills");
  renameSync(skills, moved);
  symlinkSync(moved, skills);

  const kimi = applySkillUndo(plan).filter(entry => entry.host === "kimi" && entry.skill);
  expect(kimi).toHaveLength(2);
  expect(kimi.every(entry => entry.action === "linked")).toBe(true);
  expect(readFileSync(join(moved, "ahub", "SKILL.md"), "utf8")).toBe("# person control\n");
});

test("a symlinked host config home is resolved through its link, the host's own choice", () => {
  const f = fixture();
  const real = join(f.root, "real-qwen");
  mkdirSync(real);
  rmSync(join(f.home, ".qwen"), { recursive: true, force: true });
  symlinkSync(real, join(f.home, ".qwen"));
  applySkillPlan(f.source, skillInstallPlan(f.source, f));
  expect(existsSync(join(real, "skills", "ahub-status", "SKILL.md"))).toBe(true);
});

test("a host with no config home gets no install and no directory", () => {
  const f = fixture([]);
  const plan = skillInstallPlan(f.source, f);
  expect(plan).toHaveLength(SKILL_HOSTS.length);
  expect(plan.every(entry => entry.skill === "" && entry.action === "absent")).toBe(true);
  applySkillPlan(f.source, plan);
  expect(existsSync(skillsDir(f, "codex"))).toBe(false);
  expect(skillStateRow(skillHostStates(f, expected))).toEqual({ ok: true, detail: "no other agent host installed on this machine" });
});

test("the file count and size bounds refuse a source before anything is written", () => {
  const f = fixture();
  const many = join(f.root, "many");
  writeTree(many, "ahub-status", "# status\n");
  for (let i = 0; i < 257; i++) writeFileSync(join(many, "ahub-status", `f${i}`), "x");
  expect(() => skillInstallPlan(many, f)).toThrow(/too many files/);
  expect(existsSync(skillsDir(f, "codex"))).toBe(false);

  const large = join(f.root, "large");
  writeTree(large, "ahub-status", "x".repeat(1024 * 1024 + 1));
  expect(() => skillInstallPlan(large, f)).toThrow(/too large/);
});

test("undo removes only the hub's own unmodified trees", () => {
  const f = fixture();
  applySkillPlan(f.source, skillInstallPlan(f.source, f));
  writeFileSync(join(skillDir(f, "kimi", "ahub-status"), "SKILL.md"), "# edited\n");

  const plan = skillUndoPlan(f);
  expect(plan.find(entry => entry.host === "codex" && entry.skill === "ahub")!.action).toBe("remove");
  expect(plan.find(entry => entry.host === "kimi" && entry.skill === "ahub-status")!.action).toBe("modified");
  const done = applySkillUndo(plan);
  expect(done.find(entry => entry.host === "codex" && entry.skill === "ahub")!.action).toBe("removed");
  expect(existsSync(skillDir(f, "codex", "ahub"))).toBe(false);
  expect(readFileSync(join(skillDir(f, "kimi", "ahub-status"), "SKILL.md"), "utf8")).toBe("# edited\n");
  expect(skillHostStates(f, expected).find(state => state.host === "kimi")!.state).toBe("modified");
});

test("undo checks the marker again at the effect boundary", () => {
  const f = fixture();
  applySkillPlan(f.source, skillInstallPlan(f.source, f));
  const dir = skillDir(f, "agy", "ahub-status");
  const plan = skillUndoPlan(f);
  writeFileSync(join(dir, SKILL_MARKER), JSON.stringify({ tool: "vmem", version: "1.0.0", sha256: "0".repeat(64) }));
  const done = applySkillUndo(plan);
  expect(done.find(entry => entry.host === "agy" && entry.skill === "ahub-status")!.action).toBe("foreign");
  expect(existsSync(dir)).toBe(true);
});

test("setup shows the plan before the confirmation and writes only on yes", async () => {
  const f = fixture();
  const lines: string[] = [];
  let asked = 0;
  await installHubSkills({
    ...f, yes: false, print: line => lines.push(line),
    ask: async () => {
      asked += 1;
      expect(lines.some(line => line.includes("would install"))).toBe(true);
      return "n";
    },
  });
  expect(asked).toBe(1);
  expect(lines.at(-1)).toContain("nothing written");
  expect(existsSync(skillDir(f, "codex", "ahub"))).toBe(false);

  lines.length = 0;
  await installHubSkills({ ...f, yes: true, print: line => lines.push(line) });
  const hosts = lines.filter(line => SKILL_HOSTS.some(host => line.startsWith(`hub skills: ${host} `)));
  expect(hosts.slice(0, SKILL_HOSTS.length).every(line => line.includes("would install"))).toBe(true);
  expect(hosts.slice(SKILL_HOSTS.length).every(line => line.includes(" installed"))).toBe(true);
  expect(lines.at(-1)).toBe("hub skills: 12 installed, 0 replaced, 0 removed, 0 failed, 0 left");
  expect(skillHostStates(f, expected).every(state => state.state === "installed")).toBe(true);
});

test("setup undoes without a confirmation only under --yes and reports what it leaves", async () => {
  const f = fixture();
  await installHubSkills({ ...f, yes: true, print: () => {} });
  writeFileSync(join(skillDir(f, "kimi", "ahub-status"), "SKILL.md"), "# edited\n");
  const lines: string[] = [];
  await installHubSkills({ ...f, undo: true, yes: false, print: line => lines.push(line), ask: async () => "y" });
  expect(existsSync(skillDir(f, "codex", "ahub"))).toBe(false);
  expect(lines.some(line => line.startsWith("hub skills: kimi ") && line.includes("1 modified"))).toBe(true);
  expect(lines.at(-1)).toContain("11 removed, 0 failed, 1 left");
});

test("a missing source is reported by setup, never thrown", async () => {
  const f = fixture();
  const lines: string[] = [];
  await installHubSkills({ ...f, source: join(f.root, "missing"), yes: true, print: line => lines.push(line) });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("hub skills: skipped");
  expect(existsSync(skillsDir(f, "codex"))).toBe(false);
});

test("the doctor row fails for a missing tree and warns for a tree the hub does not own", () => {
  const f = fixture();
  expect(skillStateRow(skillHostStates(f, expected))).toEqual({ ok: false, detail: SKILL_HOSTS.map(host => `${host} missing`).join("; ") });
  applySkillPlan(f.source, skillInstallPlan(f.source, f));
  expect(skillStateRow(skillHostStates(f, expected)).ok).toBe(true);
  rmSync(skillDir(f, "codex", "ahub"), { recursive: true, force: true });
  expect(skillStateRow(skillHostStates(f, expected)).detail).toContain("codex missing");
  applySkillPlan(f.source, skillInstallPlan(f.source, f));
  writeFileSync(join(skillDir(f, "pi", "ahub-status"), SKILL_MARKER), JSON.stringify({ tool: "vmem" }));
  const foreign = skillStateRow(skillHostStates(f, expected));
  expect(foreign.ok).toBeUndefined();
  expect(foreign.detail).toContain("pi foreign");
});
