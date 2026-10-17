import { expect, test } from "bun:test";

type Settled = {
  roles: Record<string, string[]>;
  source: "setting" | "roles" | "automatic" | "none";
  planners: string[];
  conductor?: string;
};
type Resolve = (policy: Readonly<Record<string, readonly string[]>>, planner: string | undefined, rostered: (peer: string) => boolean) => Settled;
const resolver = async (): Promise<Resolve> => {
  const path = "../src/hub/settled-roles.ts";
  const module = await import(path).catch(() => undefined);
  expect(typeof module?.resolveSettledRoles).toBe("function");
  return module.resolveSettledRoles as Resolve;
};
const roster = (...peers: string[]) => (peer: string) => peers.includes(peer);
const holders = (settled: Settled) => ({ planners: settled.planners, conductor: settled.conductor });

test("#439 R8 removing the last rostered planner changes the settled holder to the automatic fallback", async () => {
  const resolve = await resolver(), rostered = roster("codex", "kimi");
  const before = resolve({ kimi: ["planner"] }, undefined, rostered);
  const after = resolve({ kimi: [] }, undefined, rostered);
  expect(holders(before)).toEqual({ planners: ["kimi"], conductor: undefined });
  expect(before.source).toBe("roles");
  expect(holders(after)).toEqual({ planners: ["codex"], conductor: undefined });
  expect(after.source).toBe("automatic");
  expect(after.roles).toEqual({ kimi: [], codex: ["planner"] });
});

test("#439 an explicit planner keeps its holder through policy-role cleanup without mutating the input", async () => {
  const resolve = await resolver(), rostered = roster("codex", "kimi");
  const policy = Object.freeze({ kimi: Object.freeze(["planner", "implementer"]), codex: Object.freeze(["reviewer"]) });
  const before = resolve(policy, "codex", rostered);
  const after = resolve({ kimi: ["implementer"], codex: ["reviewer"] }, "codex", rostered);
  expect(holders(after)).toEqual(holders(before));
  expect(after.source).toBe("setting");
  expect(after.roles).toEqual({ kimi: ["implementer"], codex: ["planner", "reviewer"] });
  before.roles.kimi!.push("tester");
  expect(policy.kimi).toEqual(["planner", "implementer"]);
});

test("#439 removing a non-holder role preserves settled planner and conductor authority", async () => {
  const resolve = await resolver(), rostered = roster("codex", "kimi");
  const before = resolve({ kimi: ["planner"], codex: ["reviewer", "conductor"] }, undefined, rostered);
  const after = resolve({ kimi: ["planner"], codex: ["conductor"] }, undefined, rostered);
  expect(holders(after)).toEqual(holders(before));
  expect(after.planners).toEqual(["kimi"]);
  expect(after.conductor).toBe("codex");
});

test("#439 conductor role removal changes the settled holder even if the planner stays fixed", async () => {
  const resolve = await resolver(), rostered = roster("codex", "kimi");
  const before = resolve({ kimi: ["planner"], codex: ["conductor"] }, undefined, rostered);
  const after = resolve({ kimi: ["planner"], codex: [] }, undefined, rostered);
  expect(after.planners).toEqual(before.planners);
  expect(before.conductor).toBe("codex");
  expect(after.conductor).toBeUndefined();
  expect(holders(after)).not.toEqual(holders(before));
});

test("#439 a rostered policy planner preserves legacy off-roster planner and conductor roles", async () => {
  const resolve = await resolver();
  const result = resolve({ kimi: ["planner"], claude: ["planner", "conductor"] }, undefined, roster("kimi", "codex"));
  expect(result.roles).toEqual({ kimi: ["planner"], claude: ["planner", "conductor"] });
  expect(result.planners).toEqual(["claude", "kimi"]);
  expect(result.conductor).toBe("claude");
  expect(result.source).toBe("roles");
});

test("#439 without any rostered fallback the legacy off-roster role map is retained", async () => {
  const resolve = await resolver();
  const result = resolve({ kimi: ["planner", "conductor"] }, undefined, roster());
  expect(result.roles).toEqual({ kimi: ["planner", "conductor"] });
  expect(result.planners).toEqual(["kimi"]);
  expect(result.conductor).toBe("kimi");
  expect(result.source).toBe("none");
});

test("#439 automatic fallback replaces off-roster planners while ignoring an invalid pin", async () => {
  const resolve = await resolver();
  const result = resolve({ kimi: ["planner", "implementer"] }, "unknown", roster("codex", "qwen"));
  expect(result.roles).toEqual({ kimi: ["implementer"], codex: ["planner"] });
  expect(result.planners).toEqual(["codex"]);
  expect(result.source).toBe("automatic");
});

test("#439 settled-role derivation preserves conductor ambiguity refusal", async () => {
  const resolve = await resolver();
  expect(() => resolve({ codex: ["conductor"], kimi: ["conductor"] }, undefined, roster("codex", "kimi"))).toThrow("at most one conductor");
});
