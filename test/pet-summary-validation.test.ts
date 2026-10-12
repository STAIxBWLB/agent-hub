import { expect, test } from "bun:test";
import { parseNeedsSummary } from "../src/cli/pet.ts";

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
