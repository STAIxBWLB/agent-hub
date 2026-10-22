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
import { realPath } from "../src/hub/project.ts";
import { taskRecords } from "../src/hub/research.ts";
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
const until = async (f: () => boolean) => { for (let i = 0; i < 300 && !f(); i++) await Bun.sleep(5); expect(f()).toBe(true); };
const root = () => { const dir = realPath(mkdtempSync(join(tmpdir(), "ahub-profile-"))); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
class Peer extends BasePeer {
  async start() { this.setState("idle"); } async stop() {} async deliver() {}
}
async function rig(profile?: ProfileName, check?: { resolve: boolean }, profileDataOverride?: any) {
  const dir = root(), board = new Board(join(dir, "hub.db")), bus = new Bus({ batchMs: 0 }), notices: string[] = [];
  cleanup.push(() => board.close());
  for (const name of ["claude", "codex", "kimi", "local"]) { const peer = new Peer(name); bus.add(peer); await peer.start(); }
  const tasks = new Tasks({ board, bus, cwd: dir, project: "fixture", profile, profileData: profileDataOverride, roles: DEFAULT_ROLES, routing: () => loadRouting(dir), notify: text => notices.push(text),
    ...(check ? { check: (_base, task) => task?.profileClass === "fact_check" ? "citations" : undefined, runCheck: async () => ({ code: citationKeys("Claim [@source]", check.resolve ? "@article{source, title={Evidence}}" : "").missing.length ? 1 : 0, timedOut: false, tail: "citation check" }) } : {}) });
  return { tasks, board, bus, dir, notices };
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
async function profileCli(dir: string, args: string[]) {
  const cli = join(import.meta.dir, "../src/cli/main.ts"), wrapper = join(dir, `cli-${crypto.randomUUID()}.ts`);
  writeFileSync(wrapper, `for (const name of ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "AGENTHUB_UNATTENDED", "AGENTHUB_RECOVERY_OPERATION", "AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID"]) delete process.env[name];\nprocess.env.AGENTHUB_HOME = ${JSON.stringify(join(dir, "home"))};\nprocess.argv = [process.execPath, ${JSON.stringify(cli)}, ...${JSON.stringify(args)}];\nawait import(${JSON.stringify(cli)});\n`);
  const proc = Bun.spawn([process.execPath, wrapper], { cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe" }); let expired = false; const timer = setTimeout(() => { expired = true; proc.kill("SIGKILL"); }, 8000);
  try { const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]); if (expired || code > 1 || /SyntaxError|Cannot find module|ModuleNotFound|timed out|^error:/im.test(stderr)) throw new Error("CLI fixture setup or timeout failed: " + stderr); return { code, stdout, stderr }; }
  finally { clearTimeout(timer); }
}
test("profile CLI dry-run/JSON switches are valueless and positional aliases reach Tasks (#259)", async () => {
  const dir = root();
  for (const args of [["init", "--dry-run"], ["init", "--dry-run", "--json"], ["init", "--profile", "research", "--dry-run"], ["init", "--profile", "research", "--dry-run", "--json"]]) {
    const preview = await profileCli(dir, args); expect(preview.code).toBe(0); expect(preview.stdout).toContain("config.json");
  }
  expect(planInit(dir)).toHaveLength(4); init(dir, "research");
  const { DEFAULT_CONFIG, startDaemon } = await import("../src/hub/daemon.ts");
  const daemon = await startDaemon({ cwd: dir, stateDir: join(dir, ".agenthub/state"), controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, profile: "research", memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false }, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false } } }); cleanup.push(() => daemon.stop());
  const result = await profileCli(dir, ["task", "propose", "survey", "API landscape", "--owner", "user"]);
  expect(result.code).toBe(0); expect(result.stderr).toContain('"survey" was taken as the class');
  const persisted = new Board(join(dir, ".agenthub/state/hub.db")); cleanup.push(() => persisted.close());
  expect(persisted.list()[0]).toMatchObject({ title: "API landscape", class: "summarize", profileClass: "survey" });
});
test("accept schemas retain both document and dev plan fields across profile changes (#259)", async () => {
  for (const profile of PROFILE_NAMES) {
    const schema = profileTaskTools(profile).find(t => t.name === "hub_task_accept")!.inputSchema.properties.plan as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(["paths", "symbols", "signatures", "insertion_points", "sections", "sources", "claims"].sort());
  }
  const { tasks, board } = await rig("research");
  const legacy = board.propose("codex", { title: "Legacy dev task", class: "implement", plan: { paths: ["a.ts"] } }); board.update(legacy.id, "codex", "assigned", { state: "in_progress", owner: "codex" });
  tasks.accept("codex", legacy.id, { symbols: ["LegacySymbol"], sections: ["ignored"] }); expect(board.get(legacy.id)!.plan).toEqual({ symbols: ["LegacySymbol"] });
});

test("#607 every profile's AGENTS block carries the agy first-turn guidance", () => {
  for (const name of ["general", "research", "writing"]) {
    const profile = JSON.parse(readFileSync(join(import.meta.dir, `../templates/profiles/${name}.json`), "utf8"));
    expect(JSON.stringify(profile)).toContain("never report the hub as unavailable from the first turn alone");
  }
});

test("#507 AC1/AC2 dev profile review/done descriptions and checklist remain byte-identical; other profiles adapt", () => {
  const devTools = profileTaskTools("dev");
  expect(devTools).toBe(TASK_TOOLS);
  const devReview = devTools.find(t => t.name === "hub_review")!;
  const devDone = devTools.find(t => t.name === "hub_task_done")!;
  expect(devReview.description).toContain("map the changed signatures and call sites");
  expect((devDone.inputSchema.properties.summary as any).description).toBe("what changed, why, and the check you ran with its result");

  for (const profileName of ["research", "writing", "general"] as const) {
    const tools = profileTaskTools(profileName);
    const review = tools.find(t => t.name === "hub_review")!;
    const done = tools.find(t => t.name === "hub_task_done")!;
    expect(review.description).not.toContain("signatures and call sites");
    expect((done.inputSchema.properties.summary as any).description).not.toContain("check you ran");
    if (profileName === "research" || profileName === "writing") {
      expect(review.description).toContain("assess scope, provenance and unsupported claims");
      expect((done.inputSchema.properties.summary as any).description).toBe("changed deliverables, provenance, checks and unknowns");
    } else {
      expect(review.description).toContain("assess the deliverables against the task's plan or detail");
    }
  }
});

test("#507 AC4 research-profile review request contains no signature or test wording and uses research checklist", async () => {
  const { tasks, bus } = await rig("research");
  const published: any[] = [];
  const origPublish = bus.publish.bind(bus);
  bus.publish = (env: any) => { published.push(env); return origPublish(env); };

  const task = await tasks.propose("codex", {
    title: "Synthesize literature",
    class: "draft",
    owner: "codex",
    plan: { paths: ["summary.md"], sections: ["summary.md#intro"], sources: ["doi:example"], claims: ["claim-1"] },
  });
  await tasks.done("codex", task.id, "Drafted synthesis deliverable", { branch: "main", paths: ["summary.md"] });

  const reviewEnv = published.find(e => e.kind === "review");
  expect(reviewEnv).toBeDefined();
  const body = reviewEnv.body;

  // AC4: research review request must not contain signature or test wording
  expect(body.toLowerCase()).not.toContain("signature");
  expect(body.toLowerCase()).not.toContain("test");

  // Research checklist content
  expect(body).toContain("Assess scope, provenance and unsupported claims against");
  expect(body).toContain("No check ran for this class: verify the claims and sources yourself.");
  expect(body).toContain("List what is unmet in hub_review's unmet, one item each.");
});

test("#507 AC1 review_checklist from profile_overrides customizes the review request checklist", async () => {
  const { resolveProfile } = await import("../src/hub/profiles.ts");
  const customProfile = resolveProfile("research", {
    review_checklist: [
      "Verify all mathematical proofs against {target}.",
      "{check}",
      "Confirm dataset licensing and citations.",
    ],
  });

  const { tasks, bus } = await rig("research", undefined, customProfile);
  const published: any[] = [];
  const origPublish = bus.publish.bind(bus);
  bus.publish = (env: any) => { published.push(env); return origPublish(env); };

  const task = await tasks.propose("codex", {
    title: "Proof analysis",
    class: "draft",
    owner: "codex",
    plan: { paths: ["proof.md"], sections: ["proof.md#thm1"] },
  });
  await tasks.done("codex", task.id, "Formal proof written", { branch: "main", paths: ["proof.md"] });

  const reviewEnv = published.find(e => e.kind === "review");
  expect(reviewEnv).toBeDefined();
  const body = reviewEnv.body;

  expect(body).toContain("Verify all mathematical proofs against the plan");
  expect(body).toContain("No check ran for this class: verify the claims and sources yourself.");
  expect(body).toContain("Confirm dataset licensing and citations.");
  expect(body).not.toContain("Assess scope, provenance and unsupported claims");
});
