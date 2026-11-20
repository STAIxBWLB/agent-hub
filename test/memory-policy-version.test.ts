// hub task 1028 (#1545 Root Cause 1): the memory sync policy version is cached on a stat tuple of the
// metadata the profile fence resolves, and never queries bridgeStatus.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
