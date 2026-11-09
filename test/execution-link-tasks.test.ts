import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { USER } from "../src/hub/envelope.ts";
import { PreEffectToolRefusal } from "../src/hub/tool-refusal.ts";
import { taskExecutionReference } from "../src/hub/execution-links.ts";
import type { ExecutionReferenceV1 } from "../src/hub/execution-reference.ts";

const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0).reverse()) close(); });
class Peer extends BasePeer { async start() { this.setState("idle"); } async stop() {} async deliver() {} }
async function fixture(policy: { piiPaths?: string[]; deny?: string[] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-execution-links-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  clean.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  for (const id of ["claude", "codex", "kimi"]) { const peer = new Peer(id); bus.add(peer); await peer.start(); }
  const task = board.propose(USER, { title: "PRIVATE_TASK_TITLE", class: "implement" });
  board.update(task.id, USER, "accepted", { owner: "codex", reviewer: "claude", state: "in_progress" });
  const roles: Record<string, string[]> = { codex: ["implementer"], claude: ["reviewer"], kimi: ["implementer"] };
  const control: { private: boolean; review: boolean; held: boolean; screening: boolean; screen?: () => Promise<void>; authority?: string } = { private: false, review: false, held: false, screening: false };
  const routing = loadRouting(cwd), projectKey = "ahub-execution-fixture";
  const tasks = new Tasks({ board, bus, cwd, project: "fixture", roles, notify: () => {}, ...policy,
    routing: () => ({ ...routing, signals: { ...routing.signals, pii_screen: control.screening ? "local" : "off" }, constraints: { ...routing.constraints, pii: "local_only" } }),
    privateTurn: () => control.private, reviewObserverInput: () => control.review, sweepHeld: () => control.held,
    requestAuthority: () => () => control.authority, piiScreen: async () => { await control.screen?.(); return { label: "clear", ms: 0 }; },
    executionLineage: { projectKey, cursorKey: "fixture-private-cursor-key-0000001", readDelivery: () => undefined } });
  const reference: ExecutionReferenceV1 = { v: 1, tool: "ares", projectKey: "foreign-project", kind: "claim", id: "opaque-reference", revision: "r1", sha256: "a".repeat(64) };
  const input = () => { const current = board.get(task.id)!; return { taskId: task.id, taskCreated: current.created, flowRevision: current.history.length, reference }; };
  return { cwd, board, bus, tasks, task, roles, control, input, projectKey, reference };
}

test("Tasks write admitted declared references idempotently without changing task history or emitting text", async () => {
  const f = await fixture(), before = f.board.get(f.task.id)!;
  const first = await f.tasks.linkExecutionReference("codex", f.input());
  const again = await f.tasks.linkExecutionReference("codex", f.input());
  expect(first.strength).toBe("declared"); expect(first.already).toBe(false); expect(again.already).toBe(true); expect(again.id).toBe(first.id);
  expect(f.board.get(f.task.id)).toEqual(before);
  const page = f.tasks.executionLineage("codex", { taskId: f.task.id });
  expect(page.state).toBe("available");
  if (page.state !== "available") throw new Error("fixture unavailable");
  expect(page.nodes.find(node => node.ref.tool === "ares")?.ref).toEqual(f.reference);
  expect(page.edges[0]?.strength).toBe("declared"); expect(JSON.stringify(page)).not.toContain("PRIVATE_TASK_TITLE");
});

test("stale task identity, flow, project, role and private contexts refuse before persistence", async () => {
  const f = await fixture();
  for (const value of [{ ...f.input(), taskCreated: 0 }, { ...f.input(), flowRevision: 999 }, { ...f.input(), reference: { ...f.reference, tool: "ahub", projectKey: "other", kind: "task" } }])
    await expect(f.tasks.linkExecutionReference("codex", value)).rejects.toBeInstanceOf(PreEffectToolRefusal);
  await expect(f.tasks.linkExecutionReference("kimi", f.input())).rejects.toBeInstanceOf(PreEffectToolRefusal);
  f.roles.codex = [];
  await expect(f.tasks.linkExecutionReference("codex", f.input())).rejects.toBeInstanceOf(PreEffectToolRefusal);
  f.roles.codex = ["implementer"];
  for (const key of ["private", "review", "held"] as const) {
    f.control[key] = true;
    await expect(f.tasks.linkExecutionReference("codex", f.input())).rejects.toBeInstanceOf(PreEffectToolRefusal);
    f.control[key] = false;
  }
  expect(f.board.executionReferences(f.projectKey, f.task.id, f.task.created)).toEqual([]);
});

test("authority, task revision, owner and privacy are rechecked after held screening before the write", async () => {
  for (const change of ["authority", "revision", "owner", "private", "role"] as const) {
    const f = await fixture(); let arrive!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { arrive = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    f.control.screening = true; f.control.screen = async () => { arrive(); await gate; };
    const pending = f.tasks.linkExecutionReference("codex", f.input()).then(() => undefined, error => error);
    await entered;
    if (change === "authority") f.control.authority = "execution owner changed; reload task status";
    else if (change === "revision") f.board.update(f.task.id, USER, "note", {}, "changed");
    else if (change === "owner") f.board.update(f.task.id, USER, "assigned", { owner: "kimi" });
    else if (change === "role") f.roles.codex = [];
    else f.control.private = true;
    release(); expect(await pending).toBeInstanceOf(PreEffectToolRefusal);
    expect(f.board.executionReferences(f.projectKey, f.task.id, f.task.created)).toEqual([]);
  }
});

test("a replay does not revive a removed actor or newly private task", async () => {
  const f = await fixture(); await f.tasks.linkExecutionReference("codex", f.input());
  f.board.update(f.task.id, USER, "assigned", { owner: "kimi" });
  await expect(f.tasks.linkExecutionReference("codex", f.input())).rejects.toBeInstanceOf(PreEffectToolRefusal);
  f.board.update(f.task.id, USER, "note", { signals: ["pii"] });
  await expect(f.tasks.linkExecutionReference("kimi", f.input())).rejects.toBeInstanceOf(PreEffectToolRefusal);
  expect(f.tasks.executionLineage("kimi", { taskId: f.task.id })).toEqual({ state: "unavailable" });
});

test("read authority is uniform and administrative or malformed actors inspect no task ids", async () => {
  const f = await fixture();
  const original = f.board.get.bind(f.board); let reads = 0;
  f.board.get = id => { reads++; return original(id); };
  for (const actor of ["", "admin", "hub", "peer@room", "invalid actor", "__admin__"]) {
    expect(f.tasks.executionLineage(actor, { taskId: f.task.id })).toEqual({ state: "unavailable" });
    await expect(f.tasks.linkExecutionReference(actor, f.input())).rejects.toBeInstanceOf(PreEffectToolRefusal);
  }
  // f.input itself reads the task to bind the write, so reset before the direct read check.
  reads = 0;
  expect(f.tasks.executionLineage("admin", { taskId: f.task.id })).toEqual({ state: "unavailable" }); expect(reads).toBe(0);
  expect(f.tasks.executionLineage("kimi", { taskId: f.task.id })).toEqual({ state: "unavailable" });
  expect(f.tasks.executionLineage("kimi", { taskId: 999999 })).toEqual({ state: "unavailable" });
});

test("local targets and from references require exact recorded scoped membership, never a caller graph", async () => {
  const f = await fixture();
  const canonical = taskExecutionReference(f.projectKey, f.task.id, f.task.created);
  await expect(f.tasks.linkExecutionReference("codex", { ...f.input(), from: { ...canonical, id: "999:1" } })).rejects.toBeInstanceOf(PreEffectToolRefusal);
  await expect(f.tasks.linkExecutionReference("codex", { ...f.input(), reference: { ...canonical, revision: "forged" } })).rejects.toBeInstanceOf(PreEffectToolRefusal);
  expect((await f.tasks.linkExecutionReference("claude", { ...f.input(), from: canonical })).strength).toBe("declared");
});


test("diagnostic invalid roots and bounds stay distinct while ordinary and private callers remain neutral", async () => {
  const f = await fixture();
  for (const query of [{ taskId: f.task.id, nodes: 0 }, { root: { ...taskExecutionReference(f.projectKey, f.task.id, f.task.created), v: 2 } }, { root: { v: 1, tool: "ahub", projectKey: f.projectKey, kind: "task", id: "invalid" } }]) {
    expect(f.tasks.executionLineage(USER, query)).toEqual({ state: "unavailable", reason: "invalid" });
    expect(f.tasks.executionLineage("codex", query)).toEqual({ state: "unavailable" });
    f.control.private = true;
    expect(f.tasks.executionLineage(USER, query)).toEqual({ state: "unavailable" });
    f.control.private = false;
  }
});

test("reads use pure metadata screening and cached repository scopes without path or Git probes", async () => {
  const f = await fixture({ deny: [".git", "secrets"] });
  const fullScreen = f.tasks.publicMetadataText;
  const ports = f.tasks as unknown as { repositories: { git: (...args: unknown[]) => unknown }; projectPath: (value: string) => string };
  const git = ports.repositories.git, projectPath = ports.projectPath; let probes = 0;
  const trap = (): never => { probes++; throw new Error("read attempted a path probe"); };
  f.tasks.publicMetadataText = trap; ports.repositories.git = trap; ports.projectPath = trap;
  expect(f.tasks.executionLineage("codex", { taskId: f.task.id }).state).toBe("available");
  const refs = { paths: [join(f.cwd, "cold.txt")] };
  f.board.update(f.task.id, USER, "note", { refs });
  expect(f.tasks.executionLineage("codex", { taskId: f.task.id })).toEqual({ state: "unavailable" }); expect(probes).toBe(0);
  f.tasks.publicMetadataText = fullScreen; ports.repositories.git = git; ports.projectPath = projectPath;
  f.tasks.accept("codex", f.task.id); // normal acceptance warms the already stored refs; it does not rewrite file intent
  f.tasks.publicMetadataText = trap; ports.repositories.git = trap; ports.projectPath = trap;
  expect(f.tasks.executionLineage("codex", { taskId: f.task.id }).state).toBe("available"); expect(probes).toBe(0);
});

test("configured PII paths conservatively withhold ambiguous task paths and metadata, without hiding default task roots", async () => {
  const ordinary = await fixture({ deny: [".git"] });
  ordinary.tasks.accept("codex", ordinary.task.id, { paths: ["ordinary.txt"] });
  expect(ordinary.tasks.executionLineage("codex", { taskId: ordinary.task.id }).state).toBe("available");
  const sensitive = await fixture({ piiPaths: ["private/**"] });
  sensitive.tasks.accept("codex", sensitive.task.id, { paths: ["ordinary.txt"] });
  expect(sensitive.tasks.executionLineage("codex", { taskId: sensitive.task.id })).toEqual({ state: "unavailable" });
});


test("a conductor cannot distinguish staged backlog or private task existence from an absent root", async () => {
  const f = await fixture();
  f.roles.kimi = ["conductor"];
  const backlog = f.board.propose(USER, { title: "PRIVATE_BACKLOG_CANARY", class: "implement", backlog: true });
  const privateTask = f.board.propose(USER, { title: "PRIVATE_TASK_CANARY", class: "implement", signals: ["pii"] });
  const absent = { state: "unavailable" };
  for (const taskId of [backlog.id, privateTask.id, 999999]) {
    expect(f.tasks.executionLineage("kimi", { taskId })).toEqual(absent);
    expect(f.tasks.executionLineage("kimi", { taskId, nodes: 0 })).toEqual(absent);
  }
  // Restricting diagnostics does not revoke ordinary authorized reads of a public task.
  expect(f.tasks.executionLineage("kimi", { taskId: f.task.id }).state).toBe("available");
});
