import { expect, test } from "bun:test";
import { PLANNER_PEERS } from "../src/adapters/registry.ts";
import { resolveSettledRoles } from "../src/hub/settled-roles.ts";

const first = PLANNER_PEERS[0]!, second = PLANNER_PEERS[1]!;

test("an explicit readonly planner list exclusively pins all holders without mutating policy roles", () => {
  expect(PLANNER_PEERS.length).toBeGreaterThanOrEqual(2);
  const policy = Object.freeze({ [first]: Object.freeze(["planner", "implementer"]), [second]: Object.freeze(["reviewer"]), "prior-planner": Object.freeze(["planner", "conductor", "reviewer"]) });
  const pins = Object.freeze([second, first]);
  const settled = resolveSettledRoles(policy, pins, () => true);
  expect(settled.source).toBe("setting"); expect(settled.planners).toEqual([first, second].sort());
  expect(settled.roles[first]).toEqual(["planner", "implementer"]);
  expect(settled.roles[second]).toEqual(["planner", "reviewer"]);
  expect(settled.roles["prior-planner"]).toEqual(["conductor", "reviewer"]); expect(settled.conductor).toBe("prior-planner");
  expect(policy[first]).toEqual(["planner", "implementer"]); expect(policy["prior-planner"]).toEqual(["planner", "conductor", "reviewer"]); expect(pins).toEqual([second, first]);
});

test("instance planner pins require the host capability port and never infer eligibility from a builtin kind prefix", () => {
  const instance = "claude-planning", policy = { [first]: ["planner"], [instance]: ["reviewer"] };
  expect(() => resolveSettledRoles(policy, [instance], () => true)).toThrow("eligible peer ids");
  expect(() => resolveSettledRoles(policy, [instance], () => true, () => false)).toThrow("eligible peer ids");
  const seen: string[] = [];
  const settled = resolveSettledRoles(policy, [instance, first], () => true, peer => { seen.push(peer); return peer === instance; });
  expect(seen).toEqual([instance]); expect(settled.source).toBe("setting"); expect(settled.planners).toEqual([instance, first].sort());
  expect(settled.roles[instance]).toEqual(["planner", "reviewer"]);
  expect(resolveSettledRoles(policy, instance, () => true, peer => peer === instance).planners).toEqual([instance]);
});

test("off-roster explicit pins remain exclusive and do not silently fall back", () => {
  const policy = { [first]: ["planner", "implementer"], [second]: ["reviewer"] };
  const settled = resolveSettledRoles(policy, [second, "instance-planner"], () => false, peer => peer === "instance-planner");
  expect(settled.source).toBe("setting"); expect(settled.planners).toEqual([second, "instance-planner"].sort()); expect(settled.roles[first]).toEqual(["implementer"]);
});

for (const pins of [[], [first, first], Array.from({ length: 9 }, (_, n) => `planner-${n}`), [first, "not-capable"], ["bad id"], ["user"], ["hub"], ["digest"], ["Uppercase"], ["a".repeat(33)], [null], [42]] as const)
  test(`an invalid planner array is rejected atomically: ${JSON.stringify(pins)}`, () => {
    const policy = { [first]: ["planner", "implementer"] }, before = JSON.stringify(policy);
    expect(() => resolveSettledRoles(policy, pins as unknown as readonly string[], () => true, peer => peer.startsWith("planner-") || ["user", "hub", "digest", "bad id", "Uppercase", "a".repeat(33)].includes(peer))).toThrow("planner list");
    expect(JSON.stringify(policy)).toBe(before);
  });

test("eight distinct validated host instance pins are supported", () => {
  const pins = Object.freeze(Array.from({ length: 8 }, (_, n) => `planning-${n}`));
  const settled = resolveSettledRoles({ [first]: ["planner"] }, pins, () => true, peer => pins.includes(peer));
  expect(settled.source).toBe("setting"); expect(settled.planners).toEqual([...pins].sort()); expect(settled.roles[first]).toEqual([]);
});

test("one pinned builtin retains the scalar behavior and unrelated roles", () => {
  const settled = resolveSettledRoles({ [first]: ["reviewer"], [second]: ["planner", "implementer"] }, first, () => true);
  expect(settled.source).toBe("setting"); expect(settled.planners).toEqual([first]); expect(settled.roles[first]).toEqual(["planner", "reviewer"]); expect(settled.roles[second]).toEqual(["implementer"]);
});

test("no designation keeps role holders if any is rostered, including the existing off-roster holder projection", () => {
  const policy = { [first]: ["planner"], [second]: ["planner", "reviewer"] };
  const settled = resolveSettledRoles(policy, undefined, peer => peer === first);
  expect(settled.source).toBe("roles"); expect(settled.planners).toEqual([first, second].sort()); expect(settled.roles).toEqual(policy);
});

test("automatic fallback selects one builtin only, even when a host instance is eligible", () => {
  const settled = resolveSettledRoles({ "instance-planner": ["reviewer"] }, undefined, () => true, () => true);
  expect(settled.source).toBe("automatic"); expect(settled.planners).toEqual([first]); expect(settled.roles["instance-planner"]).toEqual(["reviewer"]);
  const none = resolveSettledRoles({}, undefined, peer => peer === "instance-planner", () => true);
  expect(none.source).toBe("none"); expect(none.planners).toEqual([]);
});

test("historically invalid scalar input still falls back for direct callers", () => {
  const settled = resolveSettledRoles({}, "not-capable", () => true);
  expect(settled.source).toBe("automatic"); expect(settled.planners).toEqual([first]);
  expect(resolveSettledRoles({}, "", () => false).source).toBe("none");
});
