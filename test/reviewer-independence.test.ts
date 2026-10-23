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

// Round 1 review: I-2 changes the outcome only when it removes an otherwise eligible reviewer.
test("a former implementer that could not review anyway leaves the outcome exactly as it was before I-2", () => {
  const history = [entry("claude-impl", "accepted"), entry("claude-impl", "escalated")];
  const only = parseRouting('[local]\nfixed_model="fixture"\n[classes.implement]\npeers=["codex"]\n[classes.review]\npeers=["claude-impl"]\n');
  const base = { candidates: ["codex"], roles, instances };
  const cases: [string, Record<string, PeerState>, Partial<NonNullable<Parameters<typeof assign>[3]>>][] = [
    ["offline", { codex: "idle", "claude-impl": "offline" }, {}],
    ["not attached", { codex: "idle" }, {}],
    ["paused", { codex: "idle", "claude-impl": "paused" }, {}],
    ["off roster", { codex: "idle", "claude-impl": "idle" }, { offRoster: ["claude-impl"] }],
    ["failing", { codex: "idle", "claude-impl": "idle" }, { failing: { "claude-impl": "start failed" } }],
  ];
  for (const [name, state, extra] of cases) {
    const withHistory = assign(task(history), state, only, { ...base, ...extra });
    const withoutHistory = assign(task([]), state, only, { ...base, ...extra });
    // the pre-I-2 outcome: no reviewer, so done approves directly, and nobody is asked to review by hand
    expect(withHistory.reviewer, name).toBeUndefined();
    expect(withHistory.reviewBlocked, name).toBeUndefined();
    expect(withHistory.reviewer, name).toBe(withoutHistory.reviewer);
    expect(withHistory.trace, name).toContain("reviewer: none, done will approve directly");
    expect(withHistory.trace.join("\n"), name).not.toContain("the person reviews");
    // the refusal names the real blocker, never I-2
    expect(withHistory.refusals?.find(row => row.peer === "claude-impl" && row.role === "reviewer")?.reason, name).not.toBe("implemented this task");
  }
});

test("I-2 is recorded only for an otherwise eligible former implementer, and then the person reviews", () => {
  const history = [entry("claude-impl", "accepted")];
  const only = parseRouting('[local]\nfixed_model="fixture"\n[classes.implement]\npeers=["codex"]\n[classes.review]\npeers=["claude-impl"]\n');
  const a = assign(task(history), { codex: "idle", "claude-impl": "idle" }, only, { candidates: ["codex"], roles, instances });
  expect(a).toMatchObject({ reviewer: "user", reviewBlocked: true });
  expect(a.refusals).toContainEqual({ peer: "claude-impl", role: "reviewer", code: "policy", reason: "implemented this task" });
  // an unavailable former implementer next to an available non-implementer: the available one reviews, no I-2 refusal at all
  const mixed = assign(task(history), { codex: "idle", "claude-impl": "offline", kimi: "idle" }, parseRouting('[local]\nfixed_model="fixture"\n[classes.implement]\npeers=["codex"]\n[classes.review]\npeers=["claude-impl","kimi"]\n'), { candidates: ["codex"], roles: { ...roles, kimi: ["reviewer"] }, instances });
  expect(mixed.reviewer).toBe("kimi");
  expect(mixed.refusals?.some(row => row.reason === "implemented this task")).toBe(false);
});
