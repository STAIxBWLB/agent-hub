// hub task 1028 (#1545 Root Cause 1): the memory sync policy version is cached on a stat tuple of the
// metadata the profile fence resolves, and never queries bridgeStatus.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, appendAlias, migrateShards, type NoteInput } from "@staix/agent-mem";
import { createMemoryPolicyVersion, openProfileMemory } from "../src/hub/memory-profile.ts";
import { realPath } from "../src/hub/project.ts";

const A = "github.com/example/version-a", B = "github.com/example/version-b";
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const note = (project: string, text: string): NoteInput => ({ op: "note", project, scope: "project", tier: "long", kind: "contract", peer: "person", source: "person", text, about: [] });

/** A split home with one project shard, as the daemon binds it. */
async function split() {
  const home = realPath(mkdtempSync(join(tmpdir(), "hub-memory-version-")));
  homes.push(home);
  const store = new MemoryStore({ home });
  store.note(note(A, "alpha contract"));
  store.close();
  const memory = join(home, "memory");
  await migrateShards({ memoryDir: memory, mode: "apply", authorizedPerson: true, tty: true });
  return { home, memory };
}

/** The daemon's composition: a cheap key, and the profile read reached only on a change. */
function policy(binding: ReturnType<typeof openProfileMemory>["binding"], store: MemoryStore, inputs: () => readonly unknown[]) {
  let reads = 0;
  const version = createMemoryPolicyVersion(
    () => JSON.stringify([binding.fenceStamp(), inputs()]),
    () => { reads++; return { profile: binding.status(store, { skippedRows: false }), inputs: inputs() }; },
  );
  return { version, reads: () => reads };
}

test("an unchanged home resolves the profile once across many fence checks", async () => {
  const { home } = await split();
  const { store, binding } = openProfileMemory({ home, project: A, projectKey: A });
  try {
    const p = policy(binding, store, () => [["deny"], ["pii"], ["pattern"]]);
    const first = p.version();
    for (let call = 0; call < 50; call++) expect(p.version()).toBe(first);
    expect(p.reads()).toBe(1);
    expect(binding.status(store, { skippedRows: false })).toMatchObject({ state: "ready", skippedRows: 0 });
  } finally { store.close(); }
});

test("a policy change moves the version", async () => {
  const { home } = await split();
  const { store, binding } = openProfileMemory({ home, project: A, projectKey: A });
  try {
    let inputs: readonly unknown[] = [["deny"], ["pii"], ["pattern"]];
    const p = policy(binding, store, () => inputs);
    const first = p.version();
    inputs = [["deny"], ["pii"], ["pattern", "new-pattern"]];
    expect(p.version()).not.toBe(first);
    expect(p.version()).toBe(p.version());
  } finally { store.close(); }
});

test("a rewritten profile marker moves the version and the fence refuses it", async () => {
  const { home, memory } = await split();
  const { store, binding } = openProfileMemory({ home, project: A, projectKey: A });
  try {
    const p = policy(binding, store, () => [["deny"]]);
    const first = p.version();
    writeFileSync(join(memory, "profile.json"), '{"schema":"agent-mem.profile/v1","kind":"shared-v1"}');
    expect(p.version()).not.toBe(first);
    expect(binding.status(store, { skippedRows: false }).state).toBe("unavailable");
  } finally { store.close(); }
});

test("a rewritten shard journal moves the version and the fence refuses it", async () => {
  const { home, memory } = await split();
  const { store, binding } = openProfileMemory({ home, project: A, projectKey: A });
  try {
    const p = policy(binding, store, () => [["deny"]]);
    const first = p.version();
    const journal = JSON.parse(readFileSync(join(memory, "shards.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(memory, "shards.json"), JSON.stringify({ ...journal, generation: "0".repeat(32) }));
    expect(p.version()).not.toBe(first);
    expect(binding.status(store, { skippedRows: false }).state).toBe("unavailable");
  } finally { store.close(); }
});

test("an alias that remaps this project moves the version and the fence refuses it", async () => {
  const { home, memory } = await split();
  const { store, binding } = openProfileMemory({ home, project: A, projectKey: A });
  try {
    const p = policy(binding, store, () => [["deny"]]);
    const first = p.version();
    appendAlias(memory, { alias: A, key: B, actor: "person", machine: "version-test" });
    expect(p.version()).not.toBe(first);
    expect(binding.status(store, { skippedRows: false }).state).toBe("unavailable");
  } finally { store.close(); }
});

test("a rewrite that keeps the identity re-reads once and keeps the same version", async () => {
  const { home, memory } = await split();
  const { store, binding } = openProfileMemory({ home, project: A, projectKey: A });
  try {
    const p = policy(binding, store, () => [["deny"]]);
    const first = p.version();
    writeFileSync(join(memory, "shards.json"), readFileSync(join(memory, "shards.json")));
    expect(p.version()).toBe(first);
    expect(p.reads()).toBe(2);
  } finally { store.close(); }
});

test("a retargeted home symlink moves the version and the fence refuses it", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "hub-memory-anchor-")));
  homes.push(root);
  const parent = join(root, "a");
  const seed = new MemoryStore({ home: parent });
  seed.note(note(A, "alpha contract"));
  seed.close();
  await migrateShards({ memoryDir: join(parent, "memory"), mode: "apply", authorizedPerson: true, tty: true });
  const other = join(root, "b");
  mkdirSync(join(other, "memory"), { recursive: true });
  const link = join(root, "link");
  symlinkSync(parent, link);
  const { store, binding } = openProfileMemory({ home: link, project: A, projectKey: A });
  try {
    const p = policy(binding, store, () => [["deny"]]);
    const first = p.version();
    unlinkSync(link);
    symlinkSync(other, link);
    expect(p.version()).not.toBe(first);
    expect(binding.status(store, { skippedRows: false }).state).toBe("unavailable");
  } finally { store.close(); }
});

test("a retargeted link at the environment memory home moves the version and the fence refuses it", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "hub-memory-anchor-env-")));
  homes.push(root);
  const first = join(root, "a");
  const seed = new MemoryStore({ home: first });
  seed.note(note(A, "alpha contract"));
  seed.close();
  await migrateShards({ memoryDir: join(first, "memory"), mode: "apply", authorizedPerson: true, tty: true });
  const other = join(root, "b");
  mkdirSync(join(other, "memory"), { recursive: true });
  // The hub home above the memory dir is stamped nowhere, so only the link's own tuple sees this retarget.
  const hub = join(root, "hub");
  mkdirSync(hub);
  symlinkSync(join(first, "memory"), join(hub, "memory"));
  const saved = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = hub;
  try {
    const { store, binding } = openProfileMemory({ project: A, projectKey: A });
    try {
      const p = policy(binding, store, () => [["deny"]]);
      const version = p.version();
      unlinkSync(join(hub, "memory"));
      symlinkSync(join(other, "memory"), join(hub, "memory"));
      expect(p.version()).not.toBe(version);
      expect(binding.status(store, { skippedRows: false }).state).toBe("unavailable");
    } finally { store.close(); }
  } finally {
    if (saved === undefined) delete process.env.AGENTHUB_HOME;
    else process.env.AGENTHUB_HOME = saved;
  }
});

test("a retargeted symlink at AMEM_HOME moves the version and the fence refuses it", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "hub-memory-anchor-amem-")));
  homes.push(root);
  const first = join(root, "a");
  const seed = new MemoryStore({ home: first });
  seed.note(note(A, "alpha contract"));
  seed.close();
  await migrateShards({ memoryDir: join(first, "memory"), mode: "apply", authorizedPerson: true, tty: true });
  const other = join(root, "b");
  mkdirSync(join(other, "memory"), { recursive: true });
  // agent-mem canonicalizes AMEM_HOME, so the bound home is the link's target: only the resolved string sees a retarget.
  const link = join(root, "amem-link");
  symlinkSync(join(first, "memory"), link);
  const saved = process.env.AMEM_HOME;
  process.env.AMEM_HOME = link;
  try {
    const { store, binding } = openProfileMemory({ project: A, projectKey: A });
    try {
      const p = policy(binding, store, () => [["deny"]]);
      const version = p.version();
      unlinkSync(link);
      symlinkSync(join(other, "memory"), link);
      expect(p.version()).not.toBe(version);
      expect(binding.status(store, { skippedRows: false }).state).toBe("unavailable");
    } finally { store.close(); }
  } finally {
    if (saved === undefined) delete process.env.AMEM_HOME;
    else process.env.AMEM_HOME = saved;
  }
});

test("a rewritten config home pointer moves the version and the fence refuses it", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "hub-memory-anchor-config-")));
  homes.push(root);
  const first = join(root, "a");
  const seed = new MemoryStore({ home: first });
  seed.note(note(A, "alpha contract"));
  seed.close();
  await migrateShards({ memoryDir: join(first, "memory"), mode: "apply", authorizedPerson: true, tty: true });
  const other = join(root, "b");
  mkdirSync(join(other, "memory"), { recursive: true });
  // The pointer file lives in the default home and names the home in use. Rewriting it moves the bound home without
  // changing any stamped directory's own tuple.
  const hub = join(root, "hub");
  const configDir = join(hub, "memory");
  mkdirSync(configDir, { recursive: true });
  const pointer = join(configDir, "amem.config.json");
  writeFileSync(pointer, JSON.stringify({ home: join(first, "memory") }));
  const saved = process.env.AGENTHUB_HOME, savedAmem = process.env.AMEM_HOME;
  process.env.AGENTHUB_HOME = hub;
  delete process.env.AMEM_HOME;
  try {
    const { store, binding } = openProfileMemory({ project: A, projectKey: A });
    try {
      const p = policy(binding, store, () => [["deny"]]);
      const version = p.version();
      writeFileSync(pointer, JSON.stringify({ home: join(other, "memory") }));
      expect(p.version()).not.toBe(version);
      expect(binding.status(store, { skippedRows: false }).state).toBe("unavailable");
    } finally { store.close(); }
  } finally {
    if (saved === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = saved;
    if (savedAmem === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = savedAmem;
  }
});

test("a fenced directory replaced by a file fails closed instead of throwing", async () => {
  const { home, memory } = await split();
  const { store, binding } = openProfileMemory({ home, project: A, projectKey: A });
  try {
    const p = policy(binding, store, () => [["deny"]]);
    const first = p.version();
    // `projects` is stamped and every shard descriptor below it is too; a file there makes the child stat ENOTDIR.
    const projects = join(memory, "projects");
    rmSync(projects, { recursive: true, force: true });
    writeFileSync(projects, "");
    let moved: string | undefined;
    expect(() => { moved = p.version(); }).not.toThrow();
    expect(moved).not.toBe(first);
    expect(binding.status(store, { skippedRows: false }).state).toBe("unavailable");
  } finally { store.close(); }
});

test("the version path never asks the store for bridgeStatus", async () => {
  const { home } = await split();
  const { store, binding } = openProfileMemory({ home, project: A, projectKey: A });
  try {
    let asked = 0;
    const storeLike = { bridgeStatus: () => { asked++; return { skippedRows: 7 }; } } as unknown as MemoryStore;
    expect(binding.status(storeLike, { skippedRows: false })).toMatchObject({ state: "ready", skippedRows: 0 });
    expect(asked).toBe(0);
    expect(binding.status(storeLike)).toMatchObject({ state: "ready", skippedRows: 7 });
    expect(asked).toBe(1);
  } finally { store.close(); }
});
