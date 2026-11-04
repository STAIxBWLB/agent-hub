import { expect, test } from "bun:test";
import { parseNeedsSummary } from "../src/cli/pet.ts";
import { summarizeNeeds } from "../src/ui/needs.ts";

test("pet snapshot state and level require a consistent first structural item", () => {
  for (const [state, kind] of [["waiting", "review"], ["blocked", "approval"], ["review", "delivery"], ["review", "budget"]]) {
    expect(parseNeedsSummary({ act: 1, watch: 0, state, first: { kind, level: "act", id: 7 } })).toBeUndefined();
  }
  for (const kind of ["approval", "default", "storage", "delivery", "review"]) {
    expect(parseNeedsSummary({ act: 0, watch: 1, state: "idle", first: { kind, level: "watch", id: 7 } })).toBeUndefined();
  }
  expect(parseNeedsSummary({ act: 1, watch: 0, state: "review", first: { kind: "review", level: "act", id: 7 } })?.act).toBe(1);
  expect(parseNeedsSummary({ act: 0, watch: 1, state: "idle", first: { kind: "recovery", level: "watch", id: "operation" } })?.watch).toBe(1);
});

test("#1054 an unread result is a watch need the pet snapshot accepts, never an act need, and never a waiting, blocked or review state", () => {
  const first = { kind: "result" as const, level: "watch" as const, peer: "codex", id: "cmp-0123456789ab", since: 5 };
  expect(parseNeedsSummary({ act: 0, watch: 1, state: "sleeping", first })).toEqual({ act: 0, watch: 1, state: "sleeping", first });
  expect(parseNeedsSummary({ act: 0, watch: 2, state: "idle", first })?.watch).toBe(2);
  expect(parseNeedsSummary({ act: 1, watch: 0, state: "waiting", first: { ...first, level: "act" } })).toBeUndefined();     // a result is never an act need
  for (const state of ["waiting", "blocked", "review"]) expect(parseNeedsSummary({ act: 0, watch: 1, state, first }), state).toBeUndefined();
  expect(parseNeedsSummary({ act: 0, watch: 1, state: "sleeping", first: { ...first, id: "x y" } })).toBeUndefined();         // the id is still checked
  // the real producer's own output is accepted: what summarizeNeeds writes is what the pet must read
  const written = summarizeNeeds({ results: [{ id: "cmp-0123456789ab", peer: "codex", since: 5 }] } as never, 1000);
  expect(written.first).toMatchObject({ kind: "result", level: "watch" });
  expect(parseNeedsSummary(written)).toEqual(written);
});
