// #237 (agent-mem#15 T2 host prerequisite): the hub opens a split memory home through openShardStore.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, appendAlias, memoryProjectKey, migrateShards, openShardStore, type NoteInput } from "@staix/agent-mem";
import { realPath } from "../src/hub/project.ts";
import { MEMORY_PROFILE_UNAVAILABLE, MEMORY_SPLIT_INCOMPLETE, bindProfileMemory, memoryProjectFor, memoryProjectForStore, openProfileMemory, selectedMemoryProfile } from "../src/hub/memory-profile.ts";
import { evaluateMemoryProfileCheck, type ProfileEvidence } from "../src/hub/memory-profile-check.ts";
import { goalCommand, memoryCommand } from "../src/cli/memory.ts";

const A = "github.com/example/hub-a", B = "github.com/example/hub-b", C = "github.com/example/hub-new";
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const note = (project: string, text: string, shared = false): NoteInput => ({ op: "note", project, scope: shared ? "shared" : "project", tier: "long", kind: "contract", peer: "person", source: "person", text, about: [] });

/** An old-layout home with a private note per project and one shared note, before any split. */
function seeded() {
  const home = realPath(mkdtempSync(join(tmpdir(), "hub-memory-shards-")));
  homes.push(home);
  const store = new MemoryStore({ home });
  const ids = { a: store.note(note(A, "alpha private contract")), b: store.note(note(B, "beta private contract")), shared: store.note(note(B, "shared contract", true)) };
  const log = join(store.dir, "log", `${store.machine.id}.jsonl`);
  store.close();
  return { home, memory: join(home, "memory"), log, ids };
}
const split = (memory: string) => migrateShards({ memoryDir: memory, mode: "apply", authorizedPerson: true, tty: true });

test("an unsplit home opens as before, with or without a project key", () => {
  const { home, ids } = seeded();
  const plain = openProfileMemory({ home }), keyed = openProfileMemory({ home, project: A });
  try {
    expect(keyed.store.profile).toEqual(plain.store.profile);
    expect(keyed.store.profile.sharded).toBeUndefined();
    expect(keyed.store.get(ids.b, B)?.text).toBe("beta private contract");
    expect(keyed.binding.status(keyed.store).state).toBe("ready");
  } finally { plain.store.close(); keyed.store.close(); }
});

test("a split home opens this project's shard with the shared overlay, never another project's notes", async () => {
  const { home, memory, ids } = seeded();
  await split(memory);
  const { store, binding } = openProfileMemory({ home, project: A });
  try {
    expect(store.profile).toMatchObject({ sharded: true, shardKey: A });
    expect(store.get(ids.a, A)?.text).toBe("alpha private contract");
    expect(store.get(ids.shared, A)?.text).toBe("shared contract");
    expect(store.get(ids.b, B)).toBeUndefined();
    expect(binding.status(store)).toMatchObject({ state: "ready", profile: "generation" });
    const id = binding.run(() => store.note(note(A, "written after the split")));
    expect(store.get(id, A)?.text).toBe("written after the split");
    expect(() => bindProfileMemory(store)).not.toThrow();
  } finally { store.close(); }
});

test("a project first seen after the split gets its own shard", async () => {
  const { home, memory } = seeded();
  await split(memory);
  const { store, binding } = openProfileMemory({ home, project: C });
  try {
    expect(store.profile).toMatchObject({ sharded: true, shardKey: C });
    const id = binding.run(() => store.note(note(C, "new project contract")));
    expect(store.get(id, C)?.text).toBe("new project contract");
  } finally { store.close(); }
});

test("a split home without a project key refuses", async () => {
  const { home, memory } = seeded();
  await split(memory);
  expect(() => openProfileMemory({ home })).toThrow(MEMORY_PROFILE_UNAVAILABLE);
});

for (const marker of ['{"schema":"agent-mem.shards/v1","phase":"captured"}', "malformed"]) {
  test(`a ${marker === "malformed" ? "malformed" : "captured"} split marker refuses with the resume remedy and reads nothing`, () => {
    const { home, memory, log } = seeded();
    writeFileSync(join(memory, "shards.json"), marker);
    const before = readFileSync(log);
    expect(() => openProfileMemory({ home, project: A })).toThrow(MEMORY_SPLIT_INCOMPLETE);
    expect(() => openProfileMemory({ home })).toThrow(MEMORY_SPLIT_INCOMPLETE);
    expect(readFileSync(log)).toEqual(before);
  });
}

test("a split marker that appears under an open unsplit binding latches it unavailable", () => {
  const { home, memory } = seeded();
  const { store, binding } = openProfileMemory({ home, project: A });
  try {
    writeFileSync(join(memory, "shards.json"), '{"schema":"agent-mem.shards/v1","phase":"captured"}');
    expect(() => binding.run(() => store.note(note(A, "must not append")))).toThrow(MEMORY_PROFILE_UNAVAILABLE);
    expect(binding.status(store).state).toBe("unavailable");
  } finally { store.close(); }
});

test("a split home reached through a symlink opens the same shard the binding resolves", async () => {
  const { home, memory, ids } = seeded();
  const link = join(realPath(mkdtempSync(join(tmpdir(), "hub-memory-link-"))), "home");
  homes.push(join(link, ".."));
  symlinkSync(home, link);
  await split(memory);
  const { store, binding } = openProfileMemory({ home: link, project: A });
  try {
    expect(store.profile).toMatchObject({ sharded: true, shardKey: A, home: memory });
    expect(store.get(ids.a, A)?.text).toBe("alpha private contract");
    expect(binding.status(store).state).toBe("ready");
  } finally { store.close(); }
});

test("ahub memory names the resume remedy on an inactive split instead of the generic profile refusal", async () => {
  const { home, memory } = seeded();
  writeFileSync(join(memory, "shards.json"), '{"schema":"agent-mem.shards/v1","phase":"captured"}');
  const previous = process.env.AMEM_HOME;
  process.env.AMEM_HOME = memory;
  try { await expect(memoryCommand(["list"], home, { person: true })).rejects.toThrow(MEMORY_SPLIT_INCOMPLETE); }
  finally { if (previous === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = previous; }
});

/** A cwd whose raw key is aliased to A, as `amem alias add <raw> <A>` would record it. */
function aliasedCwd(memory: string, machine: string) {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "hub-memory-alias-cwd-")));
  homes.push(cwd);
  const raw = memoryProjectKey(cwd);
  appendAlias(memory, { alias: raw, key: A, actor: "person", machine });
  return { cwd, raw };
}

for (const sharded of [false, true]) test(`the hub binds the alias-resolved project key the amem CLI uses (${sharded ? "split" : "unsplit"} home)`, async () => {
  const { home, memory, ids } = seeded();
  const machine = (() => { const s = new MemoryStore({ home }); try { return s.machine.id; } finally { s.close(); } })();
  if (sharded) await split(memory);
  const { cwd, raw } = aliasedCwd(memory, machine);
  expect(raw).not.toBe(A);
  const project = memoryProjectFor(cwd, { home });
  expect(project).toBe(A);
  const { store, binding } = openProfileMemory({ home, project });
  try {
    expect(store.get(ids.a, project)?.text).toBe("alpha private contract");
    const id = binding.run(() => store.note(note(project, "written by the hub under the canonical key")));
    if (sharded) {
      // What standalone amem opens for this cwd: the canonical shard, which holds the hub's write.
      const amem = openShardStore({ home, project: A });
      try { expect(amem.get(id, A)?.text).toBe("written by the hub under the canonical key"); } finally { amem.close(); }
    } else expect(store.get(id, A)?.project).toBe(A);
  } finally { store.close(); }
});

test("ahub memory reads the alias-resolved project the amem CLI binds", async () => {
  const { home, memory } = seeded();
  const machine = (() => { const s = new MemoryStore({ home }); try { return s.machine.id; } finally { s.close(); } })();
  await split(memory);
  const { cwd } = aliasedCwd(memory, machine);
  const previous = process.env.AMEM_HOME;
  process.env.AMEM_HOME = memory;
  try { expect(await memoryCommand(["list"], cwd, { person: true })).toContain("alpha private contract"); }
  finally { if (previous === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = previous; }
});

// #240: an injected store is bound to its own home, so its alias log, not the ambient home's, names the project.
for (const sharded of [false, true]) test(`ahub memory and goal resolve the alias against an injected store's own home (${sharded ? "split" : "unsplit"} home)`, async () => {
  const { home, memory } = seeded();
  const machine = (() => { const s = new MemoryStore({ home }); try { return s.machine.id; } finally { s.close(); } })();
  if (sharded) await split(memory);
  const { cwd } = aliasedCwd(memory, machine);
  const ambient = realPath(mkdtempSync(join(tmpdir(), "hub-memory-ambient-")));
  homes.push(ambient);
  expect(memoryProjectFor(cwd, { home: ambient })).not.toBe(A); // the ambient home has no such alias
  const previous = process.env.AMEM_HOME;
  process.env.AMEM_HOME = join(ambient, "memory");
  const { store } = openProfileMemory({ home, project: A });
  try {
    expect(await memoryCommand(["list"], cwd, { store, person: true })).toContain("alpha private contract");
    // A goal written through the injected store lands under the injected home's canonical key, not the raw one.
    const created = await goalCommand(["new", "injected goal", "--milestone", "m1"], cwd, { store, person: true });
    expect(created).toContain("injected goal");
    expect(store.goals(A).some(goal => goal.title === "injected goal")).toBe(true);
    expect(await goalCommand(["list"], cwd, { store, person: true })).toContain("injected goal");
  } finally { store.close(); if (previous === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = previous; }
});

// #240 review (P1): a sharded store opened for A must not run as B after the alias moves, through A's shard.
test("an injected sharded store refuses when the alias now resolves to another project, and a later remap latches it", async () => {
  const { home, memory } = seeded();
  const machine = (() => { const s = new MemoryStore({ home }); try { return s.machine.id; } finally { s.close(); } })();
  await split(memory);
  const { cwd, raw } = aliasedCwd(memory, machine);
  const { store } = openProfileMemory({ home, project: A });
  try {
    // Matching alias: the command runs.
    expect(await memoryCommand(["list"], cwd, { store, person: true })).toContain("alpha private contract");
    // The alias moves to B while A's store is still in use: refuse, never operate as B through A's shard.
    appendAlias(memory, { alias: raw, key: B, actor: "person", machine });
    expect(memoryProjectForStore(store, cwd)).toBe(B);
    await expect(memoryCommand(["list"], cwd, { store, person: true })).rejects.toThrow(MEMORY_PROFILE_UNAVAILABLE);
    await expect(goalCommand(["list"], cwd, { store, person: true })).rejects.toThrow(MEMORY_PROFILE_UNAVAILABLE);
    expect(store.list({ project: A }).every(row => !row.text.includes("beta"))).toBe(true);
  } finally { store.close(); }
  // Bound while the alias still matched, then remapped: the live binding latches unavailable instead of writing.
  const other = aliasedCwd(memory, machine);
  const second = openProfileMemory({ home, project: A });
  try {
    const bound = bindProfileMemory(second.store, undefined, other.raw);
    expect(() => bound.binding.assertCurrent()).not.toThrow(); // other.raw -> A still
    appendAlias(memory, { alias: other.raw, key: B, actor: "person", machine });
    expect(() => bound.binding.assertCurrent()).toThrow(MEMORY_PROFILE_UNAVAILABLE);
    expect(bound.binding.status(second.store).state).toBe("unavailable");
  } finally { second.store.close(); }
});

test("a dangling split marker refuses new opens with the resume remedy and latches an open unsplit binding", () => {
  const { home, memory, log } = seeded();
  const { store, binding } = openProfileMemory({ home, project: A });
  try {
    symlinkSync(join(memory, "missing-shards.json"), join(memory, "shards.json"));
    const before = readFileSync(log);
    expect(() => binding.run(() => store.note(note(A, "must not append behind a dangling marker")))).toThrow(MEMORY_PROFILE_UNAVAILABLE);
    expect(binding.status(store).state).toBe("unavailable");
    expect(readFileSync(log)).toEqual(before);
  } finally { store.close(); }
  expect(() => openProfileMemory({ home, project: A })).toThrow(MEMORY_SPLIT_INCOMPLETE);
});

for (const sharded of [false, true]) test(`an alias added under a running binding latches it unavailable (${sharded ? "split" : "unsplit"} home)`, async () => {
  const { home, memory } = seeded();
  const machine = (() => { const s = new MemoryStore({ home }); try { return s.machine.id; } finally { s.close(); } })();
  if (sharded) await split(memory);
  const cwd = realPath(mkdtempSync(join(tmpdir(), "hub-memory-late-alias-")));
  homes.push(cwd);
  const raw = memoryProjectKey(cwd);
  const { store, binding } = openProfileMemory({ home, project: memoryProjectFor(cwd, { home }), projectKey: raw });
  try {
    expect(() => binding.run(() => store.list({ project: raw }))).not.toThrow();
    appendAlias(memory, { alias: raw, key: A, actor: "person", machine });
    expect(() => binding.run(() => store.note(note(raw, "must not write under the superseded key")))).toThrow(MEMORY_PROFILE_UNAVAILABLE);
    expect(binding.status(store).state).toBe("unavailable");
  } finally { store.close(); }
});

// #536: profile-check and status inspection read a split home the way the bound hubs do.
function hubEvidence(home: string, root: string, reported: Record<string, unknown>): ProfileEvidence {
  const project = { id: "p_split", root, stateDir: join(home, "state"), basePort: 4600, pid: 1234, instanceId: "instance-1", pidSignature: "signed-owner" };
  return { project, liveness: "live", canonicalHome: join(home, "memory"),
    descriptor: { url: "ws://127.0.0.1:4601", token: "t", projectId: project.id, instanceId: project.instanceId, cwd: root, pid: 1234, pidSignature: "signed-owner" },
    status: { pid: 1234, projectId: project.id, instanceId: project.instanceId, cwd: root, version: "0.12.40", memoryProfile: { ...reported, agentMemVersion: "0.4.0" } } };
}

test("#536: a split home inspects as the shard generation and a bound hub passes profile-check", async () => {
  const { home, memory } = seeded();
  await split(memory);
  const root = realPath(mkdtempSync(join(tmpdir(), "hub-memory-root-")));
  homes.push(root);
  const key = memoryProjectFor(root, { home });
  const { store, binding } = openProfileMemory({ home, project: key });
  try {
    const bound = binding.status(store);
    const selected = selectedMemoryProfile({ home });
    expect(selected).toMatchObject({ profile: "generation", generation: bound.generation, selectorRevision: bound.selectorRevision, state: "ready" });
    const report = evaluateMemoryProfileCheck({ home: selected.home, profile: selected.profile, generation: selected.generation, selectorRevision: selected.selectorRevision }, [hubEvidence(home, root, bound as unknown as Record<string, unknown>)]);
    expect(report).toMatchObject({ ready: true });
    const stale = evaluateMemoryProfileCheck({ home: selected.home, profile: selected.profile, generation: selected.generation, selectorRevision: selected.selectorRevision }, [hubEvidence(home, root, { ...bound, generation: "c".repeat(32) })]);
    expect(stale.ready).toBe(false);
    expect(stale.daemons[0]?.reason).toBe("running memory binding differs from the selected profile");
  } finally { store.close(); }
});

test("#536: an inactive split reports the resume remedy instead of a profile", () => {
  const { home, memory } = seeded();
  writeFileSync(join(memory, "shards.json"), '{"schema":"agent-mem.shards/v1","phase":"captured"}');
  expect(() => selectedMemoryProfile({ home })).toThrow(MEMORY_SPLIT_INCOMPLETE);
  const report = evaluateMemoryProfileCheck({ home: memory, profile: "shared-v1", selectorRevision: "absent" }, [hubEvidence(home, home, { profile: "shared-v1", state: "ready", selectorRevision: "absent", home: memory })]);
  expect(report.ready).toBe(false);
  expect(report.daemons[0]?.reason).toBe(MEMORY_SPLIT_INCOMPLETE);
});
