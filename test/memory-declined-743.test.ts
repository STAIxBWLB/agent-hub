import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "@staix/agent-mem";
import { memoryCommand, composeMemorySyncOptions } from "../src/cli/memory.ts";
import { createMemorySyncPolicy, inspectDeclinedMemoryRows } from "../src/hub/memory-sync-policy.ts";

const clean: (() => void)[] = [];
afterEach(() => { for (const close of clean.splice(0).reverse()) close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "memory-declined-743-"));
  clean.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "memory");
  const store = new MemoryStore({ memoryDir: home });
  clean.push(() => store.close());
  writeFileSync(join(home, "amem.config.json"), JSON.stringify({ piiPatterns: ["PRIVATE-CANARY-743"] }));
  const note = (text: string) => store.note({ op: "note", project: "synthetic-project", scope: "project", tier: "long", kind: "decision", text, about: [], peer: "person", source: "person" });
  return { root, home, store, note };
}

test("person declined CLI lists physical forgotten ids and rules completely without note text (#1173)", async () => {
  const f = fixture(), id = f.note("PRIVATE-CANARY-743 remains in the physical original");
  f.store.forget(id, "person");
  f.note("ordinary permitted note");
  const json = await memoryCommand(["declined", "--json"], f.root, { store: f.store, person: true });
  expect(JSON.parse(json)).toMatchObject({ complete: true, rows: [{ id, rule: "personal-data" }] });
  expect(json).not.toContain("PRIVATE-CANARY-743");
  expect(json).not.toContain("ordinary permitted note");
  const human = await memoryCommand(["declined"], f.root, { store: f.store, person: true });
  expect(human).toContain(`mem:${id} personal-data`);
  expect(human).not.toContain("incomplete");
  expect(human).not.toContain("PRIVATE-CANARY-743");
  await expect(memoryCommand(["declined", "--json"], f.root, { store: f.store, person: false })).rejects.toThrow("person authority");
});

test("inspection policy changes return incomplete with no partial ids (#1173)", () => {
  const f = fixture(); f.note("PRIVATE-CANARY-743");
  let version = 0;
  const result = inspectDeclinedMemoryRows(f.store, createMemorySyncPolicy({ home: f.home }), () => String(version++));
  expect(result).toMatchObject({ complete: false, rows: [], reason: "policy-unavailable" });
  expect(JSON.stringify(result)).not.toContain("PRIVATE-CANARY-743");
});

test("canonical SDK callbacks retain meaningful target content while write screening stays compatible (#1173)", () => {
  const f = fixture();
  const policy = createMemorySyncPolicy({ home: f.home });
  const canonical = { target: "PRIVATE-CANARY-743", text: "ordinary content" };
  expect(policy.screen(canonical, true).ok).toBe(false);
  expect(policy.screen(canonical).ok).toBe(true);
  let received: Record<string, unknown> | undefined;
  const options = composeMemorySyncOptions({ screen: row => { received = row; return policy.screen(row, true).ok; } }, undefined, true);
  expect(options.screen?.(canonical)).toBe(false);
  expect(received).toEqual(canonical);
});
