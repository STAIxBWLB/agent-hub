import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, memoryProjectKey } from "@staix/agent-mem";
import { memoryCommand } from "../src/cli/memory.ts";
import { memoryRead } from "../src/hub/read-tools.ts";

test("0.27.1 groups visible CLI search hits by task while the hub tool keeps individual hits", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ahub-grouping-")));
  const project = memoryProjectKey(root), store = new MemoryStore({ home: join(root, "home") });
  try {
    const base = { op: "note" as const, project, scope: "project" as const, tier: "long" as const, kind: "finding" as const, peer: "codex", source: "person" as const, about: [], task: `${project}#12@1` };
    const first = store.note({ ...base, text: "groupingneedle first" });
    const second = store.note({ ...base, text: "groupingneedle second" });
    const grouped = JSON.parse(await memoryCommand(["search", "groupingneedle", "--json"], root, { store, person: true }));
    const separate = JSON.parse(await memoryCommand(["search", "groupingneedle", "--ungrouped", "--json"], root, { store, person: true }));
    expect(grouped).toHaveLength(1);
    expect(grouped[0].folded).toBe(1);
    expect(separate.map((row: { id: string }) => row.id).sort()).toEqual([first, second].sort());
    const agent = JSON.parse(await memoryCommand(["search", "groupingneedle", "--ungrouped", "--json"], root, { store, person: false }));
    expect(agent.map((row: { id: string }) => row.id).sort()).toEqual([first, second].sort());
    const tool = JSON.parse(memoryRead(store, project, rows => rows, "hub_memory_search", { query: "groupingneedle", limit: 8 }));
    expect(tool.lines).toHaveLength(2);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
