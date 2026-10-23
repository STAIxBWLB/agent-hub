import { expect, test } from "bun:test";
import { gather, type AskDeps } from "../src/hub/ask.ts";
import type { MemoryClient } from "../src/memory/client.ts";

const full = "mem:12345678" + "a".repeat(24), collision = "mem:12345678" + "b".repeat(24);
function deps(native: { id: string; text: string }[], ids: string[]): AskDeps {
  const table = ids.map((id, index) => `| #${id} | 2026-10-24 | decision | evidence row ${index} |`).join("\n");
  // Host-owned fake of the existing search/timeline interface; no store, provider or worker endpoint.
  const memory = { search: async () => table, timeline: async () => table } as unknown as MemoryClient;
  return { board: { list: () => [] } as unknown as AskDeps["board"], isPii: () => false, onCampus: async () => false, native: () => native,
    memory, project: "fixture/evidence", logFile: "/does-not-exist/amem-evidence-ids.log" };
}

test("ask counts a native short id and the client's unique full id as one memory evidence item", async () => {
  const result = await gather("evidence row", deps([{ id: "mem:12345678", text: "native evidence row" }], [full]));
  expect(result.evidence).toEqual([{ id: full, kind: "memory", text: "native evidence row" }]);
});

test("ask never merges distinct full ids sharing a short prefix; the ambiguous short id stays separate", async () => {
  const result = await gather("evidence row", deps([{ id: "mem:12345678", text: "ambiguous native evidence" }], [full, collision]));
  expect(result.evidence.map(row => row.id)).toEqual(["mem:12345678", full, collision]);
  expect(new Set(result.evidence.map(row => row.id)).size).toBe(3);
});

test("legacy native short ids remain valid when no full id is available", async () => {
  const result = await gather("evidence row", deps([{ id: "mem:12345678", text: "legacy evidence row" }], []));
  expect(result.evidence).toEqual([{ id: "mem:12345678", kind: "memory", text: "legacy evidence row" }]);
});

test("an existing full native id deduplicates directly and leaves another full row distinct", async () => {
  const result = await gather("evidence row", deps([{ id: full, text: "full native evidence" }], [full, collision]));
  expect(result.evidence.map(row => row.id)).toEqual([full, collision]);
});
