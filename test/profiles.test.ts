import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, planInit, upsertBlock } from "../src/cli/init.ts";
import { profileClass, projectProfile, PROFILE_NAMES, type ProfileName } from "../src/hub/profiles.ts";
import { DEFAULT_ROLES, roleContract, TASK_TOOLS, profileTaskTools } from "../src/hub/hub-tools.ts";
import { loadRoleCatalog, selectedRoles } from "../src/hub/roles.ts";
import { loadConfig } from "../src/hub/daemon.ts";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting, assign } from "../src/hub/routing.ts";
import { citationKeys } from "../src/hub/citations.ts";
import { taskRecords } from "../src/hub/research.ts";
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
const until = async (f: () => boolean) => { for (let i = 0; i < 300 && !f(); i++) await Bun.sleep(5); expect(f()).toBe(true); };
const root = () => { const dir = mkdtempSync(join(tmpdir(), "ahub-profile-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
class Peer extends BasePeer {
  async start() { this.setState("idle"); } async stop() {} async deliver() {}
}
async function rig(profile?: ProfileName, check?: { resolve: boolean }) {
  const dir = root(), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 }), notices: string[] = [];
  cleanup.push(() => board.close());
  for (const name of ["claude", "codex", "kimi", "local"]) { const peer = new Peer(name); bus.add(peer); await peer.start(); }
  const tasks = new Tasks({ board, bus, cwd: dir, project: "fixture", profile, roles: DEFAULT_ROLES, routing: () => loadRouting(dir), notify: text => notices.push(text),
    ...(check ? { check: (_base, task) => task?.profileClass === "fact_check" ? "citations" : undefined, runCheck: async () => ({ code: citationKeys("Claim [@source]", check.resolve ? "@article{source, title={Evidence}}" : "").missing.length ? 1 : 0, timedOut: false, tail: "citation check" }) } : {}) });
  return { tasks, board, dir, notices };
}
test("profile init preserves dev bytes and surrounding instructions; explicit conflicts are pre-write (#259)", () => {
  const dir = root(); init(dir);
  expect(readFileSync(join(dir, ".agenthub/config.json"), "utf8")).toBe(readFileSync(join(import.meta.dir, "../templates/config.json"), "utf8"));
  expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe(upsertBlock("", readFileSync(join(import.meta.dir, "../templates/AGENTS.block.md"), "utf8")));
  expect(planInit(dir, "dev")).toEqual([]);
  const before = readFileSync(join(dir, ".agenthub/config.json"), "utf8"); expect(() => init(dir, "research")).toThrow("differs"); expect(readFileSync(join(dir, ".agenthub/config.json"), "utf8")).toBe(before);
  for (const name of PROFILE_NAMES.filter(v => v !== "dev")) {
    const target = root(); writeFileSync(join(target, "AGENTS.md"), "Keep my instructions\n"); init(target, name);
    expect(loadConfig(target).profile).toBe(name); expect(readFileSync(join(target, "AGENTS.md"), "utf8")).toContain("Keep my instructions"); expect(readFileSync(join(target, "AGENTS.md"), "utf8")).toContain(`Project profile: ${name}`); expect(init(target)).toEqual([]);
  }
});
test("profile aliases route and budget on a persisted base while unknown/prototype classes refuse atomically (#259)", async () => {
  const { tasks, board, dir } = await rig("research");
  for (const bad of ["unknown", "toString", "__proto__", "outline"]) await expect(tasks.propose("codex", { title: "unknown", class: bad, owner: "codex" })).rejects.toThrow("class must be");
  expect(board.list()).toEqual([]);
  const task = await tasks.propose("codex", { title: "Survey", class: "survey", owner: "codex" });
  expect(task).toMatchObject({ class: "summarize", profile: "research", profileClass: "survey" }); expect(board.get(task.id)).toMatchObject({ profileClass: "survey" });
  const routing = loadRouting(dir), states = { claude: "idle", codex: "idle", kimi: "idle", local: "idle" } as const;
  expect(assign(task, states, routing)).toEqual(assign({ class: "summarize", signals: task.signals }, states, routing));
  expect(tasks.explain(task.id).join("\n")).toContain("survey (base summarize, research)");
  const legacy = await rig(); const dev = await legacy.tasks.propose("codex", { title: "Dev", class: "implement", owner: "codex", plan: { sections: ["ignored"], paths: ["a.ts"] } });
  expect(dev.profile).toBeUndefined(); expect(dev.profileClass).toBeUndefined(); expect(dev.plan).toEqual({ paths: ["a.ts"] }); await expect(legacy.tasks.propose("codex", { title: "Wrong alias", class: "survey" })).rejects.toThrow();
});
test("document plans overlap only on declared shared anchors/sources and preserve all keys (#259)", async () => {
  const { tasks, board, notices } = await rig("research");
  await tasks.propose("codex", { title: "Methods", class: "draft", owner: "codex", plan: { paths: ["report.md"], sections: ["report.md#methods"], sources: ["doi:first"], claims: ["c1"] } }); notices.length = 0;
  const other = await tasks.propose("kimi", { title: "Results", class: "draft", owner: "kimi", plan: { paths: ["report.md"], sections: ["report.md#results"], sources: ["doi:other"], claims: ["c2"] } });
  expect(tasks.overlaps(other)).toBe(""); expect(other.plan).toMatchObject({ sections: ["report.md#results"], sources: ["doi:other"], claims: ["c2"] });
  tasks.accept("kimi", other.id, { paths: ["report.md"], sections: ["report.md#results"], sources: ["doi:first"] });
  expect(tasks.overlaps(board.get(other.id)!)).toContain("doi:first");
});
test("profile fact_check runs deterministic citation evidence and cannot pass on an unresolved source (#259)", async () => {
  const check = { resolve: false }, { tasks, board } = await rig("research", check);
  const task = await tasks.propose("codex", { title: "Check sources", class: "fact_check", owner: "codex" });
  await tasks.done("codex", task.id, "Model says supported"); await until(() => tasks.checksPending() === 0); expect(board.get(task.id)!.state).not.toBe("in_review"); expect(board.get(task.id)!.history.some(h => h.event === "check failed")).toBe(true);
  check.resolve = true; await tasks.done("codex", task.id, "Bibliography fixed"); await until(() => tasks.checksPending() === 0); expect(board.get(task.id)!.state).toBe("in_review");
  expect(citationKeys("Claim [@first; @missing]", "@article{first, title={One}}")).toEqual({ cited: ["first", "missing"], missing: ["missing"] });
});
test("profile guidance preserves dev contracts and research defaults match existing flow bases (#259)", () => {
  const catalog = loadRoleCatalog();
  for (const [peer, ids] of Object.entries(projectProfile("research").catalog_roles)) expect(selectedRoles(peer, DEFAULT_ROLES, { [peer]: ids }, catalog)).toHaveLength(ids.length);
  expect(profileTaskTools("dev")).toBe(TASK_TOOLS); expect(JSON.stringify(profileTaskTools("research"))).toContain("fact_check");
  expect(roleContract("codex", DEFAULT_ROLES, [], "dev")).toBe(roleContract("codex"));
  expect(roleContract("kimi", DEFAULT_ROLES, [], "research")).toContain("Model judgment is advisory"); expect(profileClass("fact_check", "writing")).toBe("test");
});
test("profile research records carry closed profile and both classes without task text (#259)", () => {
  const row = taskRecords([{ v: 1, at: "2026-10-11T00:00:00Z", type: "task", id: 1, event: "approved", by: "user", state: "approved", owner: "codex", reviewer: "user", class: "summarize", profile: "research", profileClass: "survey", pii: true }], "fixture", { version: "test", source: "backfill" });
  expect(row).toHaveLength(1); expect(row[0]).toMatchObject({ class: "summarize", profile: "research", profileClass: "survey", pii: true });
});

test("new document plan fields retain existing PII routing and public redaction (#259)", async () => {
  const { tasks, board } = await rig("research"), marker = "patient 900101-1234567 needs a follow-up";
  const task = await tasks.propose("user", { title: "Private claims", class: "fact_check", owner: "local", plan: { claims: [marker], sources: [marker] } });
  expect(tasks.isPii(task)).toBe(true); expect(task.owner).toBe("local");
  expect(JSON.stringify(tasks.publicView(board.get(task.id)!))).not.toContain(marker);
});
