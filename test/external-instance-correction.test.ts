import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CandidateStore, MemoryStore } from "@staix/agent-mem";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";

const PROJECT = "synthetic/external-instance-correction", PEER = "fixture-reviewer";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-external-correction-"));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const home = join(cwd, "isolated-home"), store = new MemoryStore({ home, screen: () => "skip" }), candidates = new CandidateStore({ home });
  const board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  cleanup.push(() => board.close(), () => bus.closeJournal(), () => store.close(), () => candidates.close());
  const routing = loadRouting(cwd); routing.signals.pii_screen = "local";
  let live = true, screens = 0, entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const tasks = new Tasks({ board, bus, cwd, project: PROJECT, routing: () => routing, notify: () => {},
    store: { store, project: PROJECT, repo: PROJECT }, candidates,
    requestAuthority: by => by === PEER ? () => live ? undefined : "external instance launch or execution root changed" : undefined,
    piiScreen: async () => { screens++; entered(); await barrier; return { label: "clear", ms: 0 }; },
  });
  const id = store.note({ op: "note", project: PROJECT, scope: "project", tier: "long", kind: "contract", peer: "person", source: "person", text: "public retained fixture authority", about: [] });
  return { tasks, store, candidates, id, reached, release, revoke: () => { live = false; }, screens: () => screens,
    rows: () => candidates.list({ project: PROJECT, status: "all" }),
  };
}

test("#754 revoked external request authority prevents correction persistence after screening", async () => {
  const f = fixture(), before = f.store.dump();
  const outcome = f.tasks.correct(PEER, { id: f.id, text: "public correction proposal", reason: "public fixture reason" })
    .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  const reached = await Promise.race([f.reached.then(() => true), outcome.then(() => false)]);
  try {
    expect(reached).toBe(true);
    expect(f.screens()).toBe(1);
    f.revoke();
  } finally { f.release(); }
  const result = await outcome;
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toContain("external instance launch or execution root changed");
  expect(f.rows()).toEqual([]);
  expect(f.store.dump()).toBe(before);
});

test("#754 current external correction authority can create a candidate after screening", async () => {
  const f = fixture();
  const outcome = f.tasks.correct(PEER, { id: f.id, text: "public correction proposal", reason: "public fixture reason" })
    .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  const reached = await Promise.race([f.reached.then(() => true), outcome.then(() => false)]);
  try { expect(reached).toBe(true); } finally { f.release(); }
  const result = await outcome;
  expect(result.ok).toBe(true);
  expect(f.rows()).toHaveLength(1);
  expect(f.rows()[0]!.input).toMatchObject({ kind: "correction", target: { id: f.id }, proposedText: "public correction proposal" });
});

test("#754 already revoked correction authority refuses before privacy screening", async () => {
  const f = fixture(); f.revoke();
  await expect(f.tasks.correct(PEER, { id: f.id, text: "public correction proposal", reason: "public fixture reason" })).rejects.toThrow("external instance launch or execution root changed");
  expect(f.screens()).toBe(0);
  expect(f.rows()).toEqual([]);
});
