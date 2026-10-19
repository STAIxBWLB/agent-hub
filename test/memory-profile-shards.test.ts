// #237 (agent-mem#15 T2 host prerequisite): the hub opens a split memory home through openShardStore.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, migrateShards, type NoteInput } from "@staix/agent-mem";
import { realPath } from "../src/hub/project.ts";
import { MEMORY_PROFILE_UNAVAILABLE, MEMORY_SPLIT_INCOMPLETE, bindProfileMemory, openProfileMemory } from "../src/hub/memory-profile.ts";

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
