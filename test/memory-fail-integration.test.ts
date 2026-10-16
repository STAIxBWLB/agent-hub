import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "@staix/agent-mem";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { Tasks } from "../src/hub/tasks.ts";
import { loadRouting } from "../src/hub/routing.ts";
import { MemoryClient } from "../src/memory/client.ts";
import { composeRememberText } from "../src/hub/memory-fail.ts";

class ObserverMemory extends MemoryClient {
  readonly saved: Parameters<MemoryClient["save"]>[0][] = [];
  constructor() { super("http://127.0.0.1:1"); }
  override async save(note: Parameters<MemoryClient["save"]>[0]): Promise<unknown> {
    this.saved.push(structuredClone(note));
    return { saved: true };
  }
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ahub-structured-fail-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "private"));
  const bus = new Bus({ batchMs: 0 }); cleanup.push(() => bus.closeJournal());
  const board = new Board(join(dir, "hub.db")); cleanup.push(() => board.close());
  const store = new MemoryStore({ home: join(dir, "isolated-home"), screen: () => "promote" }); cleanup.push(() => store.close());
  const memory = new ObserverMemory(), notices: string[] = [], shared: string[] = [], nativeIds: string[] = [], screens: string[] = [];
  const base = loadRouting(dir), routing = { ...base, signals: { ...base.signals, pii_patterns: ["STRUCTURED-PII"], pii_screen: "local" as const }, constraints: { ...base.constraints, pii: "local_only" as const } };
  const tasks = new Tasks({ board, bus, cwd: dir, project: "synthetic-project", routing: () => routing,
    piiPaths: ["private/"], memory, store: { store, project: "synthetic-project", repo: "synthetic/project", onNote: id => nativeIds.push(id) },
    piiScreen: async text => { screens.push(text); return { label: "clear", ms: 0 }; },
    notify: text => notices.push(text), share: (_by, text) => shared.push(text),
  });
  const rows = () => ["log", "local"].flatMap(sub => readdirSync(join(store.dir, sub)).sort().flatMap(file => readFileSync(join(store.dir, sub, file), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)));
  return { tasks, store, board, memory, notices, shared, nativeIds, screens, rows };
}
function unchanged(f: ReturnType<typeof fixture>, before: string) {
  expect(f.store.dump()).toBe(before); expect(f.rows()).toEqual([]); expect(f.board.list()).toEqual([]);
  expect(f.memory.saved).toEqual([]); expect(f.shared).toEqual([]); expect(f.notices).toEqual([]); expect(f.nativeIds).toEqual([]);
}

test("Tasks.remember stores structured-only fail text exactly in ordinary v1 and mocked claude-mem", async () => {
  const f = fixture();
  const input = { kind: "fail", approach: "retrying a stale snapshot", symptom: "wrong revision observed", cause: "missing current revision check", evidence: "test:revision-regression", retry_when: "the current revision check is present" };
  const expected = "Approach: retrying a stale snapshot\nSymptom: wrong revision observed\nCause: missing current revision check\nEvidence: test:revision-regression\nRetry when: the current revision check is present";
  expect(composeRememberText(input)).toBe(expected);
  expect(await f.tasks.remember("codex", input)).toContain("saved to shared memory");
  expect(f.rows()).toHaveLength(1);
  expect(f.rows()[0]).toMatchObject({ schema: "agent-hub.memory/v1", op: "note", text: expected, kind: "fail", source: "hub", peer: "codex" });
  for (const field of ["approach", "symptom", "cause", "evidence", "retry_when"]) expect(Object.hasOwn(f.rows()[0]!, field)).toBe(false);
  expect(f.store.list({ project: "synthetic-project" })[0]?.text).toBe(expected);
  expect(f.memory.saved).toHaveLength(1); expect(f.memory.saved[0]).toMatchObject({ text: expected, project: "synthetic-project", metadata: { kind: "fail", peer: "codex" } });
  expect(f.shared).toHaveLength(1); expect(f.shared[0]).toContain(expected.replace(/\s+/g, " ")); expect(f.nativeIds).toHaveLength(1);
  expect(f.screens).toHaveLength(1); expect(f.screens[0]).toContain(expected);
});

test("Tasks.remember rejects oversized structured UTF-8 before native, cloud, share or PII-screen effects", async () => {
  const f = fixture(), before = f.store.dump(), evidence = "가".repeat(1334);
  const bytes = Buffer.byteLength(`Evidence: ${evidence}`, "utf8");
  await expect(f.tasks.remember("codex", { kind: "fail", evidence })).rejects.toThrow(`${bytes} UTF-8 bytes; maximum is 4000 bytes`);
  unchanged(f, before); expect(f.screens).toEqual([]);
});

for (const [field, value, reason] of [
  ["cause", "STRUCTURED-PII", "matches a PII pattern"],
  ["retry_when", "password: synthetic-fixture-only", "looks like it holds a secret"],
  ["evidence", "private/retained.txt", "path the project keeps private"],
] as const) test(`Tasks.remember screens structured ${field} before either backend or shared delivery`, async () => {
  const f = fixture(), before = f.store.dump();
  await expect(f.tasks.remember("codex", { kind: "fail", [field]: value })).rejects.toThrow(reason);
  unchanged(f, before); expect(f.screens).toEqual([]);
});

test("Tasks.remember keeps plain fail compatibility in native memory and mocked claude-mem", async () => {
  const f = fixture(), text = "the plain legacy fail and its reason";
  await f.tasks.remember("codex", { kind: "fail", text });
  expect(f.rows()).toHaveLength(1); expect(f.rows()[0]).toMatchObject({ text, kind: "fail" });
  expect(f.memory.saved[0]?.text).toBe(text); expect(f.shared[0]).toContain(text);
});
