import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, migrateShards, openShardStore, realPath, type NoteInput } from "@staix/agent-mem";
import { createMemorySyncPolicy, inspectDeclinedMemoryRows } from "../src/hub/memory-sync-policy.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const PROJECT = "github.com/example/declined-targets-a";
const OTHER_PROJECT = "github.com/example/declined-targets-b";
const CANARY = "PRIVATE-TARGET-CANARY-743";
const note = (project: string, text: string, shared = false): NoteInput => ({
  op: "note", project, scope: shared ? "shared" : "project", tier: "long", kind: "contract",
  peer: "person", source: "person", text, about: [],
});

test("declined inspection covers the opened project and user targets without scanning another shard (#1173)", async () => {
  const home = realPath(mkdtempSync(join(tmpdir(), "memory-declined-targets-743-")));
  roots.push(home);
  const memory = join(home, "memory"), seed = new MemoryStore({ home });
  let projectId: string, sharedId: string, otherId: string, allowedId: string;
  try {
    projectId = seed.note(note(PROJECT, `${CANARY} project contract`));
    sharedId = seed.note(note(OTHER_PROJECT, `${CANARY} shared contract`, true));
    otherId = seed.note(note(OTHER_PROJECT, `${CANARY} unopened project contract`));
    allowedId = seed.note(note(PROJECT, "ordinary permitted contract"));
  } finally { seed.close(); }

  // Public shard migration selects project/user targets; it does not activate
  // per-row sync placement or manufacture an activation attestation.
  await migrateShards({ memoryDir: memory, mode: "apply", authorizedPerson: true, tty: true });
  writeFileSync(join(memory, "amem.config.json"), JSON.stringify({ piiPatterns: [CANARY] }));
  const store = openShardStore({ home, project: PROJECT });
  try {
    expect(store.profile).toMatchObject({ sharded: true, shardKey: PROJECT });
    expect(store.get(projectId, PROJECT)?.id).toBe(projectId);
    expect(store.get(sharedId, PROJECT)?.id).toBe(sharedId);
    expect(store.get(otherId, OTHER_PROJECT)).toBeUndefined();

    const result = inspectDeclinedMemoryRows(store, createMemorySyncPolicy({ home: memory }));
    expect(result.complete).toBe(true);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map(row => row.id).sort()).toEqual([projectId, sharedId].sort());
    for (const row of result.rows) expect(row.rule).toBe("personal-data");
    expect(result.rows.some(row => row.id === otherId || row.id === allowedId)).toBe(false);
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(JSON.stringify(result)).not.toContain("ordinary permitted contract");
  } finally { store.close(); }
});
