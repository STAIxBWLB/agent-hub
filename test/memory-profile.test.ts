import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, candidateTargetRevision, migrate } from "@staix/agent-mem";
import { realPath } from "../src/hub/project.ts";
import { AGENT_MEM_HOST_API_RANGE, AGENT_MEM_RANGE, agentMemHostApiOk } from "../src/hub/agent-mem-range.ts";
import {
  AGENT_MEM_VERSION, MEMORY_PROFILE_UNAVAILABLE, assertAgentMemVersion, bindProfileMemory, MemoryProfileBinding, openProfileCandidates, openProfileMemory, selectedMemoryProfile,
} from "../src/hub/memory-profile.ts";

const homes: string[] = [];
const NOW = Date.parse("2026-10-18T00:00:00Z"), G = "a".repeat(32);
function temporary(): string {
  const home = realPath(mkdtempSync(join(tmpdir(), "hub-memory-profile-")));
  homes.push(home); return home;
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const note = { op: "note", project: "agent-hub", scope: "project", tier: "long", kind: "contract", peer: "person", source: "person", text: "synthetic profile contract", about: [] as string[] } as const;

test("selected profile inspection is read-only even for a nonexistent memory home", () => {
  const home = temporary(), dir = join(home, "memory");
  expect(selectedMemoryProfile({ home })).toEqual({ home: dir, profile: "shared-v1", selectorRevision: "absent", agentMemVersion: AGENT_MEM_VERSION, state: "ready", skippedRows: 0 });
  expect(existsSync(dir)).toBe(false);
});

test("invalid selection refuses before opening a store or candidate sidecar", () => {
  const home = temporary();
  const { store } = openProfileMemory({ home }); store.close();
  const selector = join(home, "memory", "profile.json"); writeFileSync(selector, "{malformed");
  expect(() => selectedMemoryProfile({ home })).toThrow();
  expect(() => openProfileMemory({ home })).toThrow();
  expect(() => new MemoryProfileBinding({ home })).toThrow();
  expect(existsSync(join(home, "memory", "candidates.db"))).toBe(false);
});

test("selector invalidation latches explicit entry fences and raw store close remains usable", () => {
  const home = temporary(), callbacks: string[] = [];
  const { store, binding } = openProfileMemory({ home, now: () => NOW }, reason => { callbacks.push(reason); throw new Error("observer error"); });
  const id = store.note(note), retainedGet = store.get;
  const selector = join(home, "memory", "profile.json");
  writeFileSync(selector, "{invalid");
  expect(() => binding.run(() => retainedGet.call(store, id, "agent-hub"))).toThrow(MEMORY_PROFILE_UNAVAILABLE);
  rmSync(selector);
  expect(() => binding.run(() => store.note({ ...note, text: "must not append" }))).toThrow(MEMORY_PROFILE_UNAVAILABLE);
  expect(() => binding.assertCurrent()).toThrow(MEMORY_PROFILE_UNAVAILABLE);
  expect(binding.status(store)).toMatchObject({ state: "unavailable", error: MEMORY_PROFILE_UNAVAILABLE });
  expect(callbacks).toEqual([MEMORY_PROFILE_UNAVAILABLE]);
  expect(() => store.close()).not.toThrow();
});

test("candidate storage remains at root M when the selected profile is a generation", async () => {
  const home = temporary(), first = openProfileMemory({ home, now: () => NOW });
  const id = first.store.note(note);
  const target = first.store.get(id, "agent-hub");
  expect(target).toBeDefined();
  const revision = candidateTargetRevision(target!);
  first.store.close();
  const before = openProfileCandidates(first.binding, { now: () => NOW });
  const candidateId = before.put({ project: "agent-hub", kind: "decay", target: { id, revision }, reason: "synthetic review" }, "public"); before.close();
  await migrate({ memoryDir: join(home, "memory"), mode: "apply", generation: G, authorizedPerson: true, tty: true, now: () => NOW });
  expect(() => first.binding.assertCurrent()).toThrow(MEMORY_PROFILE_UNAVAILABLE);
  const selected = openProfileMemory({ home, now: () => NOW, profile: "shared-v1" });
  expect(selected.store.profile).toMatchObject({ kind: "generation", generation: G });
  expect(selectedMemoryProfile({ home, profile: "shared-v1" })).toMatchObject({ profile: "generation", generation: G });
  const candidates = openProfileCandidates(selected.binding, { now: () => NOW });
  try {
    expect(selected.binding.status(selected.store)).toMatchObject({ profile: "generation", generation: G, state: "ready" });
    expect(candidates.dir).toBe(join(home, "memory"));
    expect(candidates.get(candidateId, "agent-hub")?.id).toBe(candidateId);
    expect(existsSync(join(selected.store.dir, "candidates.db"))).toBe(false);
    expect(() => openProfileCandidates(selected.binding, { home: temporary() })).toThrow(MEMORY_PROFILE_UNAVAILABLE);
    const seal = join(selected.store.dir, "generation-seal.json"), bytes = readFileSync(seal, "utf8");
    writeFileSync(seal, "{invalid");
    expect(() => selected.binding.run(() => candidates.list({ project: "agent-hub" }))).toThrow(MEMORY_PROFILE_UNAVAILABLE);
    writeFileSync(seal, bytes);
    expect(() => selected.binding.run(() => selected.store.get(id, "agent-hub"))).toThrow(MEMORY_PROFILE_UNAVAILABLE);
    expect(selected.binding.status(selected.store).state).toBe("unavailable");
  } finally { candidates.close(); selected.store.close(); }
});

// The owner contract requires quiescing and closing consumers before migration.
// Explicit operation-entry fences do not claim an in-flight lock-wait guarantee.


test("binding an injected store uses its direct canonical home and rejects mismatched selection", async () => {
  const home = temporary(), raw = new MemoryStore({ home, now: () => NOW });
  const injected = bindProfileMemory(raw);
  expect(injected.store).toBe(raw);
  expect(injected.binding.home).toBe(join(home, "memory"));
  const id = injected.store.note(note);
  expect(injected.store.get(id, "agent-hub")?.id).toBe(id);
  raw.close();
  await migrate({ memoryDir: join(home, "memory"), mode: "apply", generation: G, authorizedPerson: true, tty: true, now: () => NOW });
  const override = new MemoryStore({ home, profile: "shared-v1", now: () => NOW });
  try { expect(() => bindProfileMemory(override)).toThrow(MEMORY_PROFILE_UNAVAILABLE); }
  finally { override.close(); }
});


test("loaded core attestation accepts a plain release inside the declared range and refuses everything else", () => {
  const installed = JSON.parse(readFileSync(new URL("../package.json", import.meta.resolve("@staix/agent-mem")), "utf8")).version as string;
  const match = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)\.0\.0$/.exec(AGENT_MEM_RANGE);
  expect(match, AGENT_MEM_RANGE).not.toBeNull();
  const [major, minor, patch] = [Number(match![1]), Number(match![2]), Number(match![3])];
  const floor = `${major}.${minor}.${patch}`;
  expect(AGENT_MEM_VERSION).toBe(installed);
  for (const ok of [floor, `${major}.${minor}.${patch + 1}`, `${major}.${minor + 1}.0`, `${major}.${minor + 7}.3`]) {
    expect(assertAgentMemVersion({ name: "@staix/agent-mem", version: ok }), ok).toBe(ok);
  }
  const below = patch > 0 ? `${major}.${minor}.${patch - 1}` : `${major}.${minor - 1}.9`;
  for (const metadata of [undefined, {}, { name: "@staix/agent-mem", version: below }, { name: "@staix/agent-mem", version: `${major + 1}.0.0` },
    { name: "@staix/agent-mem", version: `${floor}-beta.1` }, { name: "@staix/agent-mem", version: `${major}.${minor}` },
    { name: "foreign-package", version: floor }, { name: "@staix/agent-mem", version: "unknown" }]) {
    expect(() => assertAgentMemVersion(metadata)).toThrow(/declared range/);
  }
});

test("host API constants must be positive integers, MIN <= VERSION, and intersect the supported range", () => {
  const meta = { name: "@staix/agent-mem", version: AGENT_MEM_VERSION };
  const [lo, hi] = AGENT_MEM_HOST_API_RANGE;
  expect(assertAgentMemVersion(meta, AGENT_MEM_RANGE, { min: lo, version: hi })).toBe(AGENT_MEM_VERSION);
  expect(assertAgentMemVersion(meta, AGENT_MEM_RANGE, { min: lo, version: hi + 5 })).toBe(AGENT_MEM_VERSION);
  for (const bad of [{}, { min: lo }, { version: hi }, { min: 0, version: hi }, { min: lo, version: 1.5 }, { min: "1", version: "1" },
    { min: hi + 2, version: hi + 1 }, { min: hi + 1, version: hi + 1 }, { min: -1, version: -1 }, { min: null, version: undefined }]) {
    expect(() => assertAgentMemVersion(meta, AGENT_MEM_RANGE, bad), JSON.stringify(bad)).toThrow(/host API/);
  }
  expect(agentMemHostApiOk(1, 1, [1, 1])).toBe(true);
  expect(agentMemHostApiOk(2, 3, [1, 1])).toBe(false);
  expect(agentMemHostApiOk(1, 3, [2, 2])).toBe(true);
  expect(agentMemHostApiOk(1, 1, [2, 2])).toBe(false);
});

test("memoryIndexExists accepts the package's versioned index file names and nothing else (agent-mem 0.25.0 renamed index.db to index-v4.db)", async () => {
  const { memoryIndexExists } = await import("../src/hub/memory-profile.ts");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ahub-index-name-"));
  try {
    expect(memoryIndexExists(dir)).toBe(false);
    expect(memoryIndexExists(join(dir, "missing"))).toBe(false);
    for (const unrelated of ["search.db", "mutation-lock.db", "index.db-wal", "index-v4.db-shm", "index-v2.db.bak", "xindex.db"]) writeFileSync(join(dir, unrelated), "");
    expect(memoryIndexExists(dir)).toBe(false);
    for (const name of ["index.db", "index-v4.db", "index-v12.db"]) {
      const sub = mkdtempSync(join(tmpdir(), "ahub-index-name-"));
      try { writeFileSync(join(sub, name), ""); expect(memoryIndexExists(sub)).toBe(true); } finally { rmSync(sub, { recursive: true, force: true }); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("#1747 status runs the full fence only when the fence stamp moved", () => {
  const home = temporary(), { store, binding } = openProfileMemory({ home, now: () => NOW });
  try {
    let checks = 0; const assertCurrent = binding.assertCurrent.bind(binding);
    binding.assertCurrent = () => { checks++; assertCurrent(); };
    for (let i = 0; i < 3; i++) expect(binding.status(store).state).toBe("ready");
    expect(checks).toBe(1);
    writeFileSync(join(home, "memory", "profile.json"), "{invalid");
    expect(binding.status(store)).toMatchObject({ state: "unavailable", error: MEMORY_PROFILE_UNAVAILABLE });
    expect(checks).toBe(2);
    expect(() => binding.run(() => 0)).toThrow(MEMORY_PROFILE_UNAVAILABLE);
  } finally { store.close(); }
});
