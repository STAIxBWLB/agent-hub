import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import type { MemoryClient } from "../src/memory/client.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture(executionRoot?: (cwd: string) => string) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-child-authority-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  const routing = loadRouting(cwd); routing.signals.pii_screen = "local";
  let live = true, entered!: () => void, release!: () => void, saves = 0, triages = 0;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const tasks = new Tasks({ board, bus, cwd, project: "fixture", routing: () => routing, notify: () => {},
    ...(executionRoot ? { executionRoot: () => executionRoot(cwd) } : {}),
    requestAuthority: by => by === "codex" ? () => live ? undefined : "child generation expired" : undefined,
    triage: { onCampus: async () => true, classify: async () => { triages++; return "test"; } },
    piiScreen: async () => { entered(); await gate; return { label: "clear", ms: 0 }; },
    memory: { save: async () => { saves++; return {}; } } as unknown as MemoryClient });
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }), () => board.close());
  return { cwd, board, tasks, reached, release, revoke: () => { live = false; }, saves: () => saves, triages: () => triages };
}

test("a revoked child cannot publish a proposal after its privacy await", async () => {
  const f = fixture();
  const pending = f.tasks.propose("codex", { title: "fixture public task", class: "test", backlog: true });
  await f.reached; f.revoke(); f.release();
  await expect(pending).rejects.toThrow("child generation expired");
  expect(f.board.list()).toEqual([]);
});

test("a revoked child cannot save memory after its privacy await", async () => {
  const f = fixture(); const pending = f.tasks.remember("codex", { text: "public fixture finding" });
  await f.reached; f.revoke(); f.release();
  await expect(pending).rejects.toThrow("child generation expired");
  expect(f.saves()).toBe(0); expect(f.board.list()).toEqual([]);
});

test("already stale child authority refuses before screen or task lookup", async () => {
  const f = fixture(); f.revoke();
  await expect(f.tasks.acceptReviewed("codex", 1)).rejects.toThrow("child generation expired");
  await expect(f.tasks.done("codex", 1)).rejects.toThrow("child generation expired");
});

test("a revoked child cannot finish its task after the summary screen", async () => {
  const f = fixture();
  const task = f.board.propose("user", { title: "public fixture task", class: "test" });
  f.board.update(task.id, "user", "assigned", { owner: "codex", state: "in_progress" });
  const before = f.board.get(task.id)!;
  const pending = f.tasks.done("codex", task.id, "public fixture summary");
  await f.reached; f.revoke(); f.release();
  await expect(pending).rejects.toThrow("child generation expired");
  expect(f.board.get(task.id)).toEqual(before);
});


test("a revoked child cannot invoke triage after the awaited privacy screen", async () => {
  const f = fixture();
  const pending = f.tasks.propose("codex", { title: "public unclassified fixture", backlog: true });
  await f.reached; f.revoke(); f.release();
  await expect(pending).rejects.toThrow("child generation expired");
  expect(f.triages()).toBe(0); expect(f.board.list()).toEqual([]);
});

test("child authority lost during deliverable hashing refuses completion without recording its hashes", async () => {
  let reads = 0, revoke = () => {};
  const f = fixture(cwd => { if (++reads === 2) revoke(); return cwd; });
  revoke = f.revoke;
  writeFileSync(join(f.cwd, "report.md"), "public fixture report");
  const task = f.board.propose("user", { title: "public fixture task", class: "test" });
  f.board.update(task.id, "user", "assigned", { owner: "codex", state: "in_progress" });
  const before = f.board.get(task.id)!;
  const pending = f.tasks.done("codex", task.id, "public fixture summary", undefined, [{ path: "report.md", format: "md" }]);
  await f.reached; f.release();
  await expect(pending).rejects.toThrow("child generation expired");
  expect(reads).toBe(2); // Claim vetting and the actual hash read each use the host-verified root.
  expect(f.board.get(task.id)).toEqual(before);
});
