import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, candidateTargetRevision, migrate } from "@staix/agent-mem";
import { realPath } from "../src/hub/project.ts";
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


test("loaded core attestation rejects mismatched, unknown, or foreign package metadata", () => {
  expect(AGENT_MEM_VERSION).toBe("0.17.0");
  expect(assertAgentMemVersion({ name: "@staix/agent-mem", version: "0.17.0" })).toBe("0.17.0");
  for (const metadata of [undefined, {}, { name: "@staix/agent-mem", version: "0.2.0" }, { name: "@staix/agent-mem", version: "0.3.0" }, { name: "@staix/agent-mem", version: "0.3.1" },
    { name: "foreign-package", version: "0.7.0" }, { name: "@staix/agent-mem", version: "unknown" }]) {
    expect(() => assertAgentMemVersion(metadata)).toThrow();
  }
});
