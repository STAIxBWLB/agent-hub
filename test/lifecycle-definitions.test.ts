import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSdlc, sdlcConfig, sdlcReceipt, sdlcStatus, stageDefinition, SDLC_STAGES, type SdlcGh, type SdlcMode } from "../src/hub/sdlc.ts";
import { profileTaskTools, TASK_TOOLS } from "../src/hub/hub-tools.ts";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { USER } from "../src/hub/envelope.ts";
import { loadRouting } from "../src/hub/routing.ts";
const A = "a".repeat(40), B = "b".repeat(40);
const cleanup: (() => void)[] = []; afterEach(() => { for (const f of cleanup.splice(0).reverse()) f(); });
const raw = (mode: SdlcMode = "advise") => ({ mode, required_checks: ["gate"], stages: ["question", "draft", "approve", "publish"], definitions: {
  question: { base: "plan", actor: "planner", entry_gates: ["issue"] },
  draft: { base: "implement", actor: "owner", after: ["question"], exit_gates: ["local"] },
  approve: { base: "review", actor: "reviewer", after: ["draft"], exit_gates: ["review"] },
  publish: { base: "merge", actor: "person", after: ["approve"] },
} });
const evidence = (head = A) => ({ head, state: "OPEN" as const, checks: [{ name: "gate", state: "passed" as const }], review: "approved" as const, pendingReviews: 0, unresolved: 0, paths: [] });
test("bounded custom lifecycle data preserves defaults and rejects unknown actor gate base and dependency authority (#257)", () => {
  const before = JSON.stringify(sdlcConfig(undefined)), r = raw(), config = sdlcConfig(r);
  expect(config.stages).toEqual(r.stages); expect(stageDefinition(config, "draft")?.base).toBe("implement");
  expect(stageDefinition(config, "constructor")).toBeUndefined();
  r.definitions.draft.after.push("approve"); expect(config.definitions?.draft?.after).toEqual(["question"]);
  const broken = (edit: (r: ReturnType<typeof raw>) => void) => { const r = raw(); edit(r); expect(() => sdlcConfig(r)).toThrow(); };
  broken(r => { r.stages.push("draft"); }); broken(r => { r.stages.splice(2, 1); delete (r.definitions as Record<string, unknown>).approve; });
  broken(r => { r.definitions.draft.actor = "conductor"; }); broken(r => { r.definitions.draft.base = "auto-approve"; });
  broken(r => { r.definitions.draft.exit_gates = ["shell"]; }); broken(r => { r.definitions.draft.exit_gates = ["local", "local"]; });
  broken(r => { r.definitions.draft.after = ["draft"]; }); broken(r => { r.definitions.draft.after = ["publish"]; }); broken(r => { r.definitions.draft.after = ["missing"]; });
  expect(() => sdlcConfig({ ...raw(), definitions: { ...raw().definitions, merge: { base: "plan" } }, stages: [...raw().stages, "merge"] })).toThrow();
  expect(() => sdlcConfig({ ...raw(), stages: Array(33).fill("draft") })).toThrow();
  expect(() => sdlcConfig({ ...raw(), definitions: { ...raw().definitions, draft: { ...raw().definitions.draft, exec: "run" } } })).toThrow();
  expect(JSON.stringify(sdlcConfig(undefined))).toBe(before); expect(sdlcConfig(undefined).stages).toEqual([...SDLC_STAGES]);
});
test("custom receipt identities and stage readiness never bypass the existing approval floor (#257)", () => {
  const config = sdlcConfig(raw("enforce"));
  expect(sdlcReceipt({ issue: 1 }, undefined, config).stage).toBe("question");
  expect(() => sdlcReceipt({ stage: "implement" }, undefined, config)).toThrow("unknown stage");
  const receipt = sdlcReceipt({ stage: "draft", repo: "owner/repo", issue: 1, pr: 2, localHead: A, localResult: "passed" }, undefined, config);
  const status = sdlcStatus(config, receipt, evidence()); expect(status.entry).toEqual([]); expect(status.exit).toEqual([]); expect(status.ready).toBe(false); expect(status.actor).toBe("owner");
  expect(status.blockers).toContain("current head has not been reviewed");
  expect(sdlcStatus(config, receipt, evidence(B)).exit).toContain("local gate on current head missing or failed");
  expect(sdlcStatus(sdlcConfig(undefined), receipt, evidence()).blockers).toContain("lifecycle stage definition unknown");
  expect(sdlcStatus(config, { ...receipt, reviewedHead: A }, evidence()).ready).toBe(true);
});
test("custom native stage schemas remain isolated and preserve default profile tool bytes (#257)", () => {
  const before = JSON.stringify(TASK_TOOLS), config = sdlcConfig(raw());
  const tool = profileTaskTools("dev", config.stages).find(t => t.name === "hub_sdlc_record")!;
  expect(JSON.stringify(tool)).toContain('"question","draft","approve","publish"');
  expect(profileTaskTools("dev", config.stages).find(t => t.name === "hub_task_propose")).toEqual(TASK_TOOLS.find(t => t.name === "hub_task_propose"));
  expect(profileTaskTools("dev", SDLC_STAGES)).toBe(TASK_TOOLS); expect(JSON.stringify(TASK_TOOLS)).toBe(before);
});
function rig(mode: SdlcMode) {
  const dir = mkdtempSync(join(tmpdir(), "ahub-custom-lifecycle-")), board = new Board(join(dir, "hub.db")); cleanup.push(() => { board.close(); rmSync(dir, { recursive: true, force: true }); });
  let config = sdlcConfig(raw(mode)), head = A;
  const gh: SdlcGh = async args => ({ code: 0, stdout: JSON.stringify(args[0] === "pr" ? { headRefOid: head, state: "OPEN", reviewDecision: "APPROVED", reviewRequests: [], statusCheckRollup: [{ name: "gate", conclusion: "SUCCESS" }], files: [] } : { data: { repository: { pullRequest: { headRefOid: head, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }) });
  const tasks = new Tasks({ board, bus: new Bus({ batchMs: 0 }), cwd: dir, project: "fixture", notify: () => {}, routing: () => loadRouting(dir), roles: { codex: ["implementer"], kimi: ["reviewer"] }, sdlc: { config: () => config, gh } });
  const task = board.propose(USER, { title: "fixture", class: "implement" }); board.update(task.id, USER, "fixture", { state: "in_progress", owner: "codex", reviewer: "kimi" });
  tasks.recordLifecycle(USER, task.id, { stage: "draft", repo: "owner/repo", issue: 1, pr: 2, localHead: A, localResult: "passed" });
  return { tasks, board, id: task.id, setHead: (v: string) => { head = v; }, setConfig: (v: typeof config) => { config = v; } };
}
test("custom stage actors restrict eligible holder claims and actual done review transitions retain configured ids (#257)", async () => {
  const r = rig("enforce"), before = JSON.stringify(r.board.get(r.id));
  expect(() => r.tasks.recordLifecycle("codex", r.id, { stage: "publish" })).toThrow("person");
  expect(() => r.tasks.recordLifecycle("stranger", r.id, { stage: "draft" })).toThrow("owner, reviewer or console"); expect(JSON.stringify(r.board.get(r.id))).toBe(before);
  await r.tasks.done("codex", r.id, "checked"); expect(r.board.get(r.id)?.sdlc?.stage).toBe("approve");
  expect(() => r.tasks.recordLifecycle("codex", r.id, { reviewedHead: A })).toThrow("only its reviewer");
  await r.tasks.review("kimi", r.id, "approved", "reviewed", undefined, A); expect(r.board.get(r.id)?.sdlc?.stage).toBe("publish");
  expect(r.board.get(r.id)?.state).toBe("approved");
});
test("custom exit checks and removed stage definitions block before effects while advise remains nonblocking (#257)", async () => {
  const r = rig("enforce"), def = raw("enforce"); def.definitions.draft.exit_gates = ["checks"]; r.setConfig(sdlcConfig(def));
  r.setHead(B); const before = JSON.stringify(r.board.get(r.id)); await expect(r.tasks.done("codex", r.id, "checked")).rejects.toThrow("SDLC review blocked"); expect(JSON.stringify(r.board.get(r.id))).toBe(before);
  r.setConfig(sdlcConfig(undefined)); expect((await r.tasks.lifecycleStatus(r.id, false)).blockers).toContain("lifecycle stage definition unknown");
  const advice = rig("advise"); advice.setHead(B); await advice.tasks.done("codex", advice.id, "checked"); expect(advice.board.get(advice.id)?.state).toBe("in_review");
});

test("lifecycle configuration reads are bounded regular files rather than symlink or oversized input (#257)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-lifecycle-file-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); mkdirSync(join(dir, ".agenthub"));
  const file = join(dir, ".agenthub/sdlc.toml"); expect(loadSdlc(dir)).toEqual(sdlcConfig(undefined));
  writeFileSync(file, 'mode = "advise"\n'); expect(loadSdlc(dir).mode).toBe("advise");
  writeFileSync(file, "#" + "x".repeat(65536)); expect(() => loadSdlc(dir)).toThrow("64 KiB");
  rmSync(file); writeFileSync(join(dir, "foreign.toml"), 'mode = "off"\n'); symlinkSync("../foreign.toml", file); expect(() => loadSdlc(dir)).toThrow();
});
