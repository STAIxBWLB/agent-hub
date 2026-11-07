import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateStore, MemoryStore, taskKey } from "@staix/agent-mem";
import { HUB, newEnvelope } from "../src/hub/envelope.ts";
import { MemoryTelemetry } from "../src/hub/memory-candidates.ts";
import { MemoryObservations } from "../src/hub/memory-observations.ts";
import { matchingPlanFails } from "../src/hub/memory-plan-guard.ts";
import { memoryFigures, UNKNOWN_MEMORY_FIGURES } from "../src/hub/research-memory.ts";
import type { MemoryScreen } from "../src/hub/read-tools.ts";

// #1279 AC1 to AC4 over the real agent-mem stores: delivered and cited come from the sidecar's own counters, never from a hub-side copy, and the figures are counts only.

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const screen: MemoryScreen = rows => rows.filter(row => !JSON.stringify(row).includes("WITHHELD"));
const project = "agent-hub";

function world() {
  const home = mkdtempSync(join(tmpdir(), "ahub-research-memory-"));
  const store = new MemoryStore({ home, deferPromotions: true }), sidecar = new CandidateStore({ home });
  cleanup.push(() => { sidecar.close(); store.close(); rmSync(home, { recursive: true, force: true }); });
  const note = (text: string, kind: "fail" | "decision", about: string[] = []) => store.note({ op: "note", project, scope: "project", tier: "long", kind, peer: "codex", source: "person", text, about });
  const task = { id: 7, created: 1_700_000_000_000 };
  const key = taskKey(project, task);
  const telemetry = new MemoryTelemetry(sidecar, store, project, screen);
  const observations = new MemoryObservations(telemetry, () => ({ task: key, turn: "turn-1", session: "session-1" }));
  const brief = (ids: string[]) => newEnvelope(HUB, `Memory brief (hub memory first):\n${ids.map(id => `mem:${id.slice(0, 8)} note`).join("\n")}`, { to: ["codex"], refs: { task: "7" } });
  const figures = (plan: { paths?: string[]; symbols?: string[] } = {}, taskId = key) => {
    const views = new Map(screen(store.list({ project, limit: 1000, includeSuperseded: true })).map(v => [v.id, v]));
    const input = { id: task.id, created: task.created, title: "", refs: { paths: [] as string[] }, plan };
    return memoryFigures({ counters: sidecar.counters(project), taskKey: taskId, view: id => views.get(id),
      matchingPlan: fails => matchingPlanFails(input, fails, { cwd: "/nonexistent-ahub-fixture", project, repo: "agent-hub" }) });
  };
  return { store, sidecar, note, key, observations, brief, figures, task };
}

test("AC1: a delivered brief records delivered for each rendered entry; one that never completes leaves delivered null", () => {
  const w = world();
  const a = w.note("alpha decision", "decision"), b = w.note("beta fail", "fail");
  const first = w.brief([a, b]);
  w.observations.delivery("codex", "d-1", [first], "rendered");
  expect(w.figures()).toMatchObject({ rendered: 2, delivered: null, cited: 0 }); // rendered, acknowledgement not seen yet
  w.observations.delivery("codex", "d-1", [first], "delivered");
  expect(w.figures()).toMatchObject({ rendered: 2, delivered: 2, cited: 0 });
  // A second brief rendered but never completed adds to rendered only.
  const c = w.note("gamma decision", "decision");
  w.observations.delivery("codex", "d-2", [w.brief([c])], "rendered");
  expect(w.figures()).toMatchObject({ rendered: 3, delivered: 2 });
});

test("AC2: a citation of a brief entry counts, and an id that was not in the brief does not", () => {
  const w = world();
  const inBrief = w.note("in brief", "decision"), outside = w.note("never shown", "decision");
  w.observations.delivery("codex", "d-1", [w.brief([inBrief])], "rendered");
  w.observations.cite("codex", `done: used mem:${inBrief.slice(0, 8)}`, "summary:7:3");
  w.observations.cite("codex", `done: also mem:${outside.slice(0, 8)}`, "summary:7:4");
  expect(w.figures()).toMatchObject({ rendered: 1, cited: 1 });
  expect(w.sidecar.counters(project).filter(row => row.cited === 1)).toHaveLength(2); // the sidecar saw both, the task's exposure counts the one it was shown
});

test("AC3: the fail-retry signal counts exposed fail notes the plan touches that were not cited, and is 0 when it was cited", () => {
  const w = world();
  const planned = w.note("do not use approach X", "fail", ["path:src/hub/research.ts"]), unrelated = w.note("another fail", "fail", ["path:docs/other.md"]), decision = w.note("a decision", "decision", ["path:src/hub/research.ts"]);
  w.observations.delivery("codex", "d-1", [w.brief([planned, unrelated, decision])], "rendered");
  const plan = { paths: ["src/hub/research.ts"] };
  expect(w.figures(plan)).toMatchObject({ rendered: 3, failsExposed: 2, failsCited: 0, failRetrySignal: 1 });
  // The same fixture, with the planned fail note cited by the done summary: the signal is 0.
  w.observations.cite("codex", `read mem:${planned.slice(0, 8)} first`, "summary:7:1");
  expect(w.figures(plan)).toMatchObject({ failsExposed: 2, failsCited: 1, failRetrySignal: 0 });
  // A plan that touches nothing the fail notes are about leaves the signal at 0 too, with the exposure still counted.
  expect(w.figures({ paths: ["src/other/file.ts"] })).toMatchObject({ failsExposed: 2, failRetrySignal: 0 });
});

test("no counter row for the task is unknown, never zero, and other tasks' rows are not this task's", () => {
  const w = world();
  const a = w.note("alpha", "decision");
  expect(w.figures()).toEqual(UNKNOWN_MEMORY_FIGURES);
  w.observations.delivery("codex", "d-1", [w.brief([a])], "rendered");
  expect(w.figures(undefined, taskKey(project, { id: 8, created: 1 }))).toEqual(UNKNOWN_MEMORY_FIGURES);
});

test("an entry the store no longer shows leaves the fail figures unknown, not short", () => {
  const w = world();
  const plain = w.note("plain", "decision");
  w.observations.delivery("codex", "d-1", [w.brief([plain])], "rendered");
  // A second entry is rendered while visible and hidden afterwards, as when a note is forgotten or screened out later.
  const visible = w.note("visible fail", "fail", ["path:src/hub/research.ts"]);
  w.observations.delivery("codex", "d-2", [w.brief([visible])], "rendered");
  const hidden = new Set([visible]);
  const views = new Map(w.store.list({ project, limit: 1000, includeSuperseded: true }).filter(v => !hidden.has(v.id)).map(v => [v.id, v]));
  const f = memoryFigures({ counters: w.sidecar.counters(project), taskKey: w.key, view: id => views.get(id), matchingPlan: x => x });
  expect(f).toMatchObject({ rendered: 2, failsExposed: null, failsCited: null, failRetrySignal: null });
});

test("AC4: the figures hold only counts: no entry id, text or path leaves with them", () => {
  const w = world();
  const secret = w.note("CANARY-TEXT-77aa about /Users/secret/path.ts", "fail", ["path:src/hub/research.ts"]);
  w.observations.delivery("codex", "d-1", [w.brief([secret])], "rendered");
  const text = JSON.stringify(w.figures({ paths: ["src/hub/research.ts"] }));
  expect(text).not.toContain(secret.slice(0, 8));
  expect(text).not.toContain("CANARY");
  expect(text).not.toContain("/Users/secret");
  for (const value of Object.values(JSON.parse(text))) expect(value === null || typeof value === "number").toBe(true);
});

// #1297 review: the live writer builds every terminal task's record from the log and keeps one, so the memory reader must run once, for the task being recorded.
test("a live write with many earlier terminal tasks calls the memory reader once, for the recorded task", async () => {
  const { taskRecords } = await import("../src/hub/research.ts");
  const { onlyTaskMemory } = await import("../src/hub/research-memory.ts");
  const { taskEvent } = await import("./helpers/research-fixture.ts");
  const log = [];
  for (let id = 1; id <= 12; id++) log.push(taskEvent(id * 10, id, "proposed", "proposed"), taskEvent(id * 10 + 1, id, "accepted", "in_progress", { owner: "codex" }), taskEvent(id * 10 + 2, id, "approved", "approved"));
  const calls: number[] = [];
  const read = (task: number) => { calls.push(task); return { rendered: 1, delivered: null, cited: 0, failsExposed: 0, failsCited: 0, failRetrySignal: 0 }; };
  const records = taskRecords(log, "p", { version: "t", source: "live" }, { tasks: new Map(), board: false, memory: onlyTaskMemory(12, read) });
  expect(records).toHaveLength(12); // the log still yields every record: the live writer filters to its task afterwards
  expect(calls).toEqual([12]);
  expect(records.find(r => r.task === 12)!.memory).toMatchObject({ rendered: 1, cited: 0 });
  // Every other task reads unknown, never another task's figures and never zero.
  expect(records.find(r => r.task === 3)!.memory).toMatchObject({ rendered: null, delivered: null, cited: null, failsExposed: null, failRetrySignal: null });
  // A backfill passes its reader directly and wants all of them.
  calls.length = 0;
  taskRecords(log, "p", { version: "t", source: "backfill" }, { tasks: new Map(), board: false, memory: read });
  expect(calls).toHaveLength(12);
});

test("a task with no rendered counter never touches the store, and one with a rendered entry reads it once, whatever its fail count", () => {
  const w = world();
  let listed = 0;
  const a = w.note("alpha", "decision"), b = w.note("beta fail", "fail", ["path:src/hub/research.ts"]);
  const views = new Map(screen(w.store.list({ project, limit: 1000, includeSuperseded: true })).map(v => [v.id, v]));
  const run = () => memoryFigures({ counters: w.sidecar.counters(project), taskKey: w.key, view: id => { listed++; return views.get(id); }, matchingPlan: x => x });
  expect(run()).toEqual(UNKNOWN_MEMORY_FIGURES);
  expect(listed).toBe(0);
  w.observations.delivery("codex", "d-1", [w.brief([a, b])], "rendered");
  run();
  expect(listed).toBe(2); // one lookup per rendered entry, nothing for the rest of the store
});
