import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIntentBriefSource, createStandalonePolicy, MemoryStore } from "@staix/agent-mem";
import { Briefs, type BriefTask, type CorpusBriefPort, type NativeItem } from "../src/memory/brief.ts";
import { MemoryClient } from "../src/memory/client.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const task: BriefTask = { id: 1, created: 1, updated: 1, owner: "codex", history: [], title: "public task", refs: { paths: ["src/a.ts"] } };
const planFail: NativeItem = { id: "mem:plan-fail", line: "mem:plan-fail fail long: preserve this advice", kind: "fail" };
const note: NativeItem = { id: "note:notes/guide.md#retry", line: "note:notes/guide.md#retry When retrying, keep the temporary file.", kind: "note" };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function port(overrides: Partial<CorpusBriefPort> = {}): CorpusBriefPort {
  return { allowed: () => true, policyVersion: () => "v1", read: () => [note], ...overrides };
}
class CountingClient extends MemoryClient {
  calls = 0;
  override async search(): Promise<undefined> { this.calls++; return undefined; }
}

test("corpus notes append after priority advice, obey the cap, and share peer dedupe", async () => {
  let reads = 0;
  const briefs = new Briefs(undefined, "fixture", 2, undefined, undefined, undefined, undefined,
    port({ read: () => { reads++; return [note, note, { ...note, id: "note:notes/other.md#top" }]; } }));
  const first = await briefs.forTask("codex", task, [planFail]);
  expect(first?.split("\n").slice(1)).toEqual([planFail.line, note.line]);
  expect(first).toContain("Knowledge brief");
  expect(reads).toBe(1);
  const again = await briefs.forTask("codex", task, [planFail]);
  expect(again).toContain(planFail.line);
  expect(again).not.toContain(note.line);
  expect(reads).toBe(2);
});

test("PII refusal happens before native, intent, legacy-client, corpus, or observer access", async () => {
  const client = new CountingClient(); let native = 0, intent = 0, reads = 0, observed = 0;
  const briefs = new Briefs(client, "fixture", 3, async () => { native++; return [planFail]; }, () => { observed++; }, undefined,
    async () => { intent++; throw Error("must not run"); }, port({ allowed: () => false, read: () => { reads++; return [note]; } }));
  expect(await briefs.forTask("codex", task, [planFail])).toBeUndefined();
  expect({ native, intent, legacy: client.calls, reads, observed }).toEqual({ native: 0, intent: 0, legacy: 0, reads: 0, observed: 0 });
});

test("privacy or policy changes during a corpus await drop the brief without poisoning seen state", async () => {
  const gate = deferred(); let privateTask = false, version = "v1", observed = 0, reads = 0;
  const briefs = new Briefs(undefined, "fixture", 2, undefined, () => { observed++; }, undefined, undefined,
    port({ allowed: () => !privateTask, policyVersion: () => version, read: async () => { reads++; await gate.promise; return [note]; } }));
  const pending = briefs.forTask("codex", task);
  await Promise.resolve();
  privateTask = true;
  gate.resolve();
  expect(await pending).toBeUndefined();
  expect(observed).toBe(0);
  privateTask = false;
  expect(await briefs.forTask("codex", task)).toContain(note.line);

  const secondGate = deferred();
  const changed = new Briefs(undefined, "fixture", 2, undefined, () => { observed++; }, undefined, undefined,
    port({ policyVersion: () => version, read: async () => { await secondGate.promise; return [note]; } }));
  const stale = changed.forTask("codex", { ...task, id: 2 });
  await Promise.resolve();
  version = "v2";
  secondGate.resolve();
  expect(await stale).toBeUndefined();
  expect(observed).toBe(0);
});

test("concurrent legacy briefs share corpus note dedupe for one peer", async () => {
  const gate = deferred(), bothStarted = deferred();
  let reads = 0;
  const briefs = new Briefs(undefined, "fixture", 1, undefined, undefined, undefined, undefined,
    port({ read: async () => { if (++reads === 2) bothStarted.resolve(); await gate.promise; return [note]; } }));
  const first = briefs.forTask("codex", task);
  const second = briefs.forTask("codex", { ...task, id: 2 });
  await bothStarted.promise;
  gate.resolve();
  const delivered = await Promise.all([first, second]);
  expect(delivered.filter(Boolean)).toHaveLength(1);
  expect(delivered.filter(text => text?.includes(note.line))).toHaveLength(1);
});

test("intent-library retrieval can append a corpus citation after its memory evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-brief-corpus-")); dirs.push(dir);
  const store = new MemoryStore({ home: join(dir, "memory") });
  store.note({ op: "note", project: "fixture", scope: "project", tier: "long", peer: "person", source: "person", kind: "decision", about: [], text: "public task memory guidance" });
  const policy = createStandalonePolicy({});
  let reads = 0;
  const intent = async () => ({ source: createIntentBriefSource(store, "fixture"), options: {
    project: "fixture", cwd: dir, repo: "o/r", intent: "public task", paths: [], symbols: [],
    policy: () => policy, policyVersion: () => "memory-v1", allowed: () => true, stale: () => false, now: () => store.readNow(),
  } });
  try {
    const brief = await new Briefs(undefined, "fixture", 4, undefined, undefined, undefined, intent,
      port({ read: () => { reads++; return [note]; } })).forTask("codex", task);
    expect(brief).toContain("Knowledge brief");
    expect(brief).toContain("mem:");
    expect(brief).toContain(note.line);
    expect(reads).toBe(1);
  } finally { store.close(); }
});
