import { expect, test } from "bun:test";
import { assign, parseRouting, plannerWalk } from "../src/hub/routing.ts";
import type { PeerState } from "../src/hub/envelope.ts";

// #525-3 AC-2: the planner walk is its own pure walk, and `assign()` prints the same lines `route explain` reads.
const holders = ["claude", "codex-plan", "kimi"];
const none = () => undefined;

test("rotation starts at task.id mod n over the sorted holders", () => {
  expect(holders.map((_, id) => plannerWalk({ planners: holders, seed: id, blocked: none, pii: false }).planner)).toEqual(["claude", "codex-plan", "kimi"]);
  expect([3, 4, 5, 6].map(id => plannerWalk({ planners: holders, seed: id, blocked: none, pii: false }).planner)).toEqual(["claude", "codex-plan", "kimi", "claude"]);
  expect(plannerWalk({ planners: ["kimi", "claude", "codex-plan"], seed: 1, blocked: none, pii: false }).planner).toBe("codex-plan"); // input order never matters
  expect(plannerWalk({ planners: ["claude", "claude", "kimi"], seed: 1, blocked: none, pii: false }).planner).toBe("kimi"); // a duplicate holder is one holder
  const first = plannerWalk({ planners: holders, seed: 4, blocked: none, pii: false });
  expect(first).toMatchObject({ planner: "codex-plan", reason: "rotation", line: "planner: codex-plan (rotation)" });
  expect(first.walk).toEqual([{ peer: "codex-plan", note: "available" }]);
});

test("an unavailable holder is skipped without renumbering, and the walk goes forward", () => {
  const blocked = (peer: string) => (peer === "codex-plan" ? "offline" : undefined);
  const w = plannerWalk({ planners: holders, seed: 1, blocked, pii: false }); // the seed holder is skipped: forward to kimi
  expect(w).toMatchObject({ planner: "kimi", reason: "rotation", line: "planner: kimi (rotation, skipped unavailable holders)" });
  expect(w.walk).toEqual([{ peer: "codex-plan", note: "skipped, offline" }, { peer: "kimi", note: "available" }]);
  // not renumbered: with codex-plan offline, task 2 still starts at kimi and task 3 still at claude (modulo 3, never modulo 2)
  expect([2, 3, 4, 5].map(id => plannerWalk({ planners: holders, seed: id, blocked, pii: false }).planner)).toEqual(["kimi", "claude", "kimi", "kimi"]);
  // the walk wraps past the end
  expect(plannerWalk({ planners: holders, seed: 2, blocked: peer => (peer === "kimi" ? "paused" : undefined), pii: false }).planner).toBe("claude");
});

test("when every holder is skipped the seed holder is taken and the line says so", () => {
  const w = plannerWalk({ planners: holders, seed: 4, blocked: () => "offline", pii: false });
  expect(w).toMatchObject({ planner: "codex-plan", reason: "rotation", line: "planner: codex-plan (rotation (none available))" });
  expect(w.walk.map(row => row.peer)).toEqual(["codex-plan", "kimi", "claude"]);
});

test("a named planner is exact; one that is not a holder is refused, never replaced by rotation", () => {
  expect(plannerWalk({ planners: holders, seed: 0, named: "kimi", blocked: none, pii: false })).toMatchObject({ planner: "kimi", reason: "named", line: "planner: kimi (named)" });
  expect(plannerWalk({ planners: holders, seed: 0, named: "kimi", blocked: () => "offline", pii: false })).toMatchObject({ planner: "kimi", reason: "named", line: "planner: kimi (named; offline)" }); // the person's name is kept; the state is shown
  const refused = plannerWalk({ planners: holders, seed: 0, named: "local", blocked: none, pii: false });
  expect(refused.planner).toBeUndefined();
  expect(refused).toMatchObject({ reason: "none", line: "planner: none (named local is not a planner holder)", walk: [{ peer: "local", note: "skipped, not a planner holder" }] });
});

test("a recorded planner is kept while it is still a holder, and rotation resumes when it is not", () => {
  expect(plannerWalk({ planners: holders, seed: 0, kept: "kimi", blocked: () => "offline", pii: false })).toMatchObject({ planner: "kimi", reason: "kept", line: "planner: kimi (kept)" }); // a pause or offline never moves it
  expect(plannerWalk({ planners: holders, seed: 0, kept: "gone", blocked: none, pii: false })).toMatchObject({ planner: "claude", reason: "rotation" });
  expect(plannerWalk({ planners: holders, seed: 0, kept: "kimi", named: "claude", blocked: none, pii: false }).planner).toBe("claude"); // a person's name beats the kept planner
});

test("a PII task and an empty holder list have no planner", () => {
  expect(plannerWalk({ planners: holders, seed: 0, named: "kimi", blocked: none, pii: true })).toMatchObject({ reason: "none", line: "planner: none (pii: planning stays with the person)", walk: [] });
  expect(plannerWalk({ planners: [], seed: 0, blocked: none, pii: false })).toMatchObject({ reason: "none", line: "planner: none (no planner holder)" });
  expect(plannerWalk({ planners: holders, seed: Number.NaN, blocked: none, pii: false }).planner).toBe("claude"); // an unusable seed is seed 0, never NaN
  expect(plannerWalk({ planners: holders, seed: -1, blocked: none, pii: false }).planner).toBe("kimi"); // a negative seed still lands inside the list
});

const routing = parseRouting('[local]\nfixed_model="fixture"\n[classes.implement]\npeers=["codex"]\n[classes.plan]\npeers=["claude"]\n[classes.review]\npeers=["claude","codex"]\n');
const states: Record<string, PeerState> = { claude: "idle", codex: "idle", "codex-plan": "idle", kimi: "idle" };
const task = (id: number, extra: object = {}) => ({ id, class: "implement" as const, signals: [] as never[], ...extra });

test("assign() picks planner, owner and reviewer by separate walks, and the planner rotates by task id", () => {
  const picks = [3, 4, 5].map(id => assign(task(id), states, routing, { planners: holders }));
  expect(picks.map(a => [a.planner, a.plannerReason])).toEqual([["claude", "rotation"], ["codex-plan", "rotation"], ["kimi", "rotation"]]);
  for (const a of picks) expect(a).toMatchObject({ owner: "codex", reviewer: "claude" }); // owner and reviewer do not follow the planner
  // planner and owner may be the same peer, as planner and reviewer may
  expect(assign(task(1), states, routing, { planners: ["codex"] })).toMatchObject({ planner: "codex", owner: "codex" });
  expect(assign(task(2), states, routing, { planners: ["claude"] })).toMatchObject({ planner: "claude", reviewer: "claude" });
});

test("assign() without planners walks no planner, so every existing caller is unchanged", () => {
  const a = assign(task(4), states, routing, {});
  expect(a.planner).toBeUndefined(); expect(a.plannerReason).toBeUndefined();
  expect(a.trace.some(line => line.includes("planner candidate") || line.startsWith("planner:"))).toBe(false);
});

test("the trace carries the walk lines in order, owner then planner then reviewer, and explain reads that very trace", () => {
  const a = assign(task(4), { ...states, "codex-plan": "offline" }, routing, { planners: holders });
  const at = (text: string) => a.trace.findIndex(line => line.includes(text));
  expect(a.trace).toContain("  planner candidate codex-plan: skipped, offline");
  expect(a.trace).toContain("  planner candidate kimi: available");
  expect(a.trace).toContain("planner: kimi (rotation, skipped unavailable holders)");
  expect(at("owner: codex")).toBeLessThan(at("planner candidate codex-plan"));
  expect(at("planner: kimi")).toBeLessThan(at("reviewer: claude"));
  expect(a).toMatchObject({ planner: "kimi", plannerReason: "rotation" });
});

test("the planner walk reads off-roster, pause and failing state like the other walks, and a named planner reaches assign()", () => {
  const skip = (extra: object) => assign(task(4), states, routing, { planners: holders, ...extra }).planner;
  expect(skip({ offRoster: ["codex-plan"] })).toBe("kimi");
  expect(skip({ failing: { "codex-plan": "start failed" } })).toBe("kimi");
  expect(assign(task(4), { ...states, "codex-plan": "paused" }, routing, { planners: holders }).planner).toBe("kimi");
  expect(assign(task(4), { ...states, "codex-plan": "paused" }, { ...routing, constraints: { ...routing.constraints, budget_paused: "queue" as never } }, { planners: holders }).planner).toBe("codex-plan");
  expect(assign(task(4), states, routing, { planners: holders, namedPlanner: "claude" })).toMatchObject({ planner: "claude", plannerReason: "named" });
  expect(assign(task(4), states, routing, { planners: holders, namedPlanner: "pi" })).toMatchObject({ plannerReason: "none" });
  expect(assign(task(4), states, routing, { planners: holders, keptPlanner: "kimi" })).toMatchObject({ planner: "kimi", plannerReason: "kept" });
});

test("a PII task has no planner in the trace, and a closed or backlog task is not walked", () => {
  const pii = assign(task(4, { signals: ["pii"] }), states, routing, { planners: holders });
  expect(pii.planner).toBeUndefined(); expect(pii.trace).toContain("planner: none (pii: planning stays with the person)");
  expect(assign(task(4, { state: "backlog" }), states, routing, { planners: holders }).planner).toBeUndefined();
  expect(assign(task(4, { state: "approved" }), states, routing, { planners: holders }).planner).toBeUndefined();
});

test("assign() is pure: the same inputs give the same planner, and the input is never changed", () => {
  const input = { planners: [...holders] as string[], namedPlanner: undefined };
  const before = JSON.stringify(input);
  const a = assign(task(7), states, routing, input), b = assign(task(7), states, routing, input);
  expect(a).toEqual(b);
  expect(JSON.stringify(input)).toBe(before);
});
