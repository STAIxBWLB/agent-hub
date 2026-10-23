import { expect, test } from "bun:test";
import { assign, implementers, parseRouting } from "../src/hub/routing.ts";
import type { PeerState } from "../src/hub/envelope.ts";
import type { HistoryEntry } from "../src/hub/board.ts";

// #525-3 I-1/I-2: a multi-role holder never reviews what it implemented, now or after the task changed hands.
const entry = (by: string, event: string): HistoryEntry => ({ at: 1, by, event });
const routing = parseRouting('[local]\nfixed_model="fixture"\n[classes.implement]\npeers=["claude-impl","codex"]\n[classes.review]\npeers=["claude-impl","codex"]\n');
const roles = { "claude-impl": ["implementer", "reviewer"], codex: ["implementer"] };
const instances = { "claude-impl": { kind: "claude", roles: ["implementer", "reviewer"], worktree: ".worktrees/claude-impl" } };
const states: Record<string, PeerState> = { "claude-impl": "idle", codex: "idle" };
const task = (history: HistoryEntry[], extra: object = {}) => ({ id: 3, class: "implement" as const, signals: [] as never[], history, ...extra });

test("implementers() reads accepted and done entries by a peer, and nothing else", () => {
  expect([...implementers([entry("a", "proposed"), entry("a", "assigned"), entry("b", "accepted"), entry("c", "done"), entry("d", "changes_requested"), entry("e", "approved")])].sort()).toEqual(["b", "c"]);
  expect([...implementers([entry("user", "done"), entry("user", "accepted")])]).toEqual([]); // the person is not an implementing peer
  expect([...implementers(undefined)]).toEqual([]);
  expect([...implementers([entry("a", "accepted"), entry("a", "done")])]).toEqual(["a"]);
});

test("a former owner never reviews the task, even after another peer owns it now (I-2)", () => {
  // claude-impl accepted and then declined or was escalated away from: codex owns it now, and is the only other reviewer candidate
  const history = [entry("claude-impl", "accepted"), entry("claude-impl", "escalated")];
  const a = assign(task(history), states, routing, { candidates: ["codex"], roles, instances });
  expect(a.owner).toBe("codex");
  expect(a.reviewer).not.toBe("claude-impl");
  expect(a.refusals).toContainEqual({ peer: "claude-impl", role: "reviewer", code: "policy", reason: "implemented this task" });
  expect(a.trace).toContain("  reviewer candidate claude-impl: skipped, implemented this task");
});

test("with every candidate an implementer the reviewer is the person, never a fallback to an implementer", () => {
  const history = [entry("claude-impl", "accepted"), entry("codex", "accepted"), entry("codex", "done")];
  const a = assign(task(history), states, routing, { candidates: ["codex"], roles, instances });
  expect(a).toMatchObject({ owner: "codex", reviewer: "user", reviewBlocked: true });
  expect(a.trace).toContain("  every eligible reviewer implemented this task: the person reviews");
  expect(a.trace).toContain("reviewer: user");
  expect(a.trace).not.toContain("reviewer: none, done will approve directly");
});

test("an explicit named reviewer who implemented the task is refused, with the policy reason", () => {
  const history = [entry("claude-impl", "done")];
  const a = assign(task(history), states, routing, { candidates: ["codex"], namedReviewer: "claude-impl", roles, instances });
  expect(a.reviewer).not.toBe("claude-impl");
  expect(a.refusals).toContainEqual({ peer: "claude-impl", role: "reviewer", code: "policy", reason: "implemented this task" });
});

test("a peer with no accepted or done entry still reviews, and the owner is never its own reviewer (I-1 unchanged)", () => {
  const fresh = assign(task([entry("user", "proposed"), entry("claude-impl", "assigned")]), states, routing, { candidates: ["codex"], roles, instances });
  expect(fresh).toMatchObject({ owner: "codex", reviewer: "claude-impl" }); // assigned is not accepted: it implemented nothing
  expect(assign(task([entry("codex", "accepted")]), states, routing, { candidates: ["codex"], roles, instances }).reviewer).not.toBe("codex");
});

test("I-2 holds on the declared reviewer pool path as well", () => {
  const pooled = parseRouting('[local]\nfixed_model="fixture"\n[classes.implement]\npeers=["codex"]\n[classes.review]\npeers=["claude","codex"]\n');
  const poolInstances = { "claude-review": { kind: "claude", roles: ["reviewer"], start_mode: "headless" }, "claude-two": { kind: "claude", roles: ["reviewer"], start_mode: "headless" } };
  const poolRoles = { "claude-review": ["reviewer"], "claude-two": ["reviewer"] };
  const poolStates: Record<string, PeerState> = { codex: "idle", claude: "idle", "claude-review": "idle", "claude-two": "idle" };
  const base = { instances: poolInstances, roles: poolRoles, candidates: ["codex"], reviewPool: { pool: ["claude"] } };
  expect(assign({ id: 1, class: "implement", signals: [] }, poolStates, pooled, base).reviewer).toBe("claude-review");
  // claude-review implemented an earlier round of this task: the pool walks past it to the next declared instance
  const second = assign({ id: 1, class: "implement", signals: [], history: [entry("claude-review", "accepted")] }, poolStates, pooled, base);
  expect(second.reviewer).toBe("claude-two");
  // both did: nobody is left and the person reviews, recorded as blocked
  const none = assign({ id: 1, class: "implement", signals: [], history: [entry("claude-review", "accepted"), entry("claude-two", "done")] }, poolStates, pooled, base);
  expect(none).toMatchObject({ reviewer: "user", reviewBlocked: true });
});

test("a review-class task and a PII task are untouched by I-2", () => {
  expect(assign(task([entry("claude-impl", "accepted")], { class: "review" }), states, routing, { candidates: ["codex"], roles, instances }).reviewer).toBeUndefined();
  expect(assign(task([entry("claude-impl", "accepted")], { signals: ["pii"] }), states, routing, { candidates: ["codex"], roles, instances }).reviewer).toBe("user");
});
