import { expect, test } from "bun:test";
import { assign, parseRouting } from "../src/hub/routing.ts";
import { queueBackpressure, queueBackpressurePolicy, type QueuePressure } from "../src/hub/queue-backpressure.ts";

const routing = parseRouting('[local]\nfixed_model="fixture"\n[classes.implement]\npeers=["codex","kimi"]\n[classes.review]\npeers=["claude"]\n');
const task = { id: 1, class: "implement" as const, signals: [] as string[] };
const states = { codex: "idle", kimi: "idle", claude: "idle" } as const;
const now = 1_800_000_000_000;
const empty = (): Record<string, QueuePressure> => Object.fromEntries(Object.keys(states).map(peer => [peer, { queued: 0, oldestQueuedAt: null }]));
const count = { max_queued: 2, max_oldest_s: 0 };
const age = { max_queued: 0, max_oldest_s: 60 };

test("queue backpressure config is bounded, exact and disabled by default", () => {
  expect(queueBackpressurePolicy(undefined)).toEqual({ max_queued: 0, max_oldest_s: 0 });
  expect(queueBackpressurePolicy({})).toEqual({ max_queued: 0, max_oldest_s: 0 });
  expect(queueBackpressurePolicy({ max_queued: 10_000, max_oldest_s: 604_800 })).toEqual({ max_queued: 10_000, max_oldest_s: 604_800 });
  expect(queueBackpressurePolicy({ max_queued: 1 })).toEqual({ max_queued: 1, max_oldest_s: 0 });
  for (const invalid of [null, [], "off", { enabled: true }, { max_queued: -1 }, { max_queued: 1.5 }, { max_queued: 10_001 }, { max_oldest_s: 604_801 }, { max_oldest_s: NaN }, { max_oldest_s: "60" }]) {
    expect(() => queueBackpressurePolicy(invalid)).toThrow("tasks.queue_backpressure");
  }
  expect(() => queueBackpressurePolicy(Object.create({ max_queued: 1 }))).toThrow("tasks.queue_backpressure");
});

test("pure queue count admission allows below and equal, and holds only above its threshold", () => {
  for (const queued of [0, 1, 2]) expect(queueBackpressure("codex", count, { queued }, now)).toBeUndefined();
  expect(queueBackpressure("codex", count, { queued: 3 }, now)).toEqual({ peer: "codex", code: "queue-count", reason: "queue backpressure: queued 3 exceeds max 2" });
  for (const queued of [-1, 0.5, NaN, Infinity]) expect(queueBackpressure("codex", count, { queued }, now)?.code).toBe("queue-count");
  expect(queueBackpressure("codex", count, undefined, now)?.reason).toBe("queue backpressure: queued count unknown");
});

test("pure oldest-age admission distinguishes threshold equality, verified empty and unknown age", () => {
  expect(queueBackpressure("codex", age, { queued: 1, oldestQueuedAt: now - 59_999 }, now)).toBeUndefined();
  expect(queueBackpressure("codex", age, { queued: 1, oldestQueuedAt: now - 60_000 }, now)).toBeUndefined();
  expect(queueBackpressure("codex", age, { queued: 1, oldestQueuedAt: now - 60_001 }, now)).toEqual({ peer: "codex", code: "queue-age", reason: "queue backpressure: oldest queued age 60001ms exceeds max 60000ms" });
  expect(queueBackpressure("codex", age, { queued: 0, oldestQueuedAt: null }, NaN)).toBeUndefined();
  for (const oldestQueuedAt of [undefined, null, NaN, Infinity, -1, now + 1]) expect(queueBackpressure("codex", age, { queued: 1, oldestQueuedAt }, now)?.code).toBe("queue-age-unknown");
  expect(queueBackpressure("codex", age, { queued: 0 }, now)?.code).toBe("queue-age-unknown");
  expect(queueBackpressure("codex", age, { queued: 0, oldestQueuedAt: now }, now)?.code).toBe("queue-age-unknown");
  expect(queueBackpressure("codex", age, { queued: 1, oldestQueuedAt: now }, NaN)?.code).toBe("queue-age-unknown");
});

test("count and age switches remain independent and disabled routing is byte-identical", () => {
  expect(queueBackpressure("codex", undefined, undefined, NaN)).toBeUndefined();
  expect(queueBackpressure("codex", { max_queued: 0, max_oldest_s: 0 }, { queued: NaN }, NaN)).toBeUndefined();
  expect(queueBackpressure("codex", count, { queued: 1 }, NaN)).toBeUndefined(); // Age is off.
  const queues = { codex: { queued: 100, oldestQueuedAt: undefined }, kimi: { queued: NaN }, claude: { queued: 999, oldestQueuedAt: now - 100_000 } };
  const baseline = assign(task, states, routing, { now });
  expect(JSON.stringify(assign(task, states, routing, { now, queues }))).toBe(JSON.stringify(baseline));
  expect(JSON.stringify(assign(task, states, routing, { now, queues, queueBackpressure: { max_queued: 0, max_oldest_s: 0 } }))).toBe(JSON.stringify(baseline));
});

test("owner routing and its trace refuse queue pressure without treating a reservation as an override", () => {
  const queues = { ...empty(), codex: { queued: 3, oldestQueuedAt: now } };
  const ordinary = assign(task, states, routing, { now, queues, queueBackpressure: count });
  expect(ordinary.owner).toBe("kimi");
  expect(ordinary.refusals).toContainEqual({ peer: "codex", role: "owner", code: "queue-count", reason: "queue backpressure: queued 3 exceeds max 2" });
  expect(ordinary.trace).toContain("  owner candidate codex: skipped, queue backpressure: queued 3 exceeds max 2");
  const reserved = assign({ ...task, reserved: "codex" }, states, routing, { now, queues, queueBackpressure: count });
  expect(reserved.owner).toBe("kimi");
  expect(reserved.unreserved).toBe("queue backpressure: queued 3 exceeds max 2");
  expect(assign(task, states, routing, { now, queues, queueBackpressure: count, candidates: ["codex"], namedOwner: "codex" }).owner).toBeUndefined();
});

test("age-policy routing uses its supplied clock and never guesses a missing age or now as fresh", () => {
  for (const codex of [{ queued: 1 }, { queued: 1, oldestQueuedAt: now + 1 }]) {
    const result = assign(task, states, routing, { now, queues: { ...empty(), codex }, queueBackpressure: age });
    expect(result.owner).toBe("kimi");
    expect(result.refusals).toContainEqual(expect.objectContaining({ peer: "codex", role: "owner", code: "queue-age-unknown" }));
  }
  const noClock = assign(task, states, routing, { queues: { ...empty(), codex: { queued: 1, oldestQueuedAt: now } }, queueBackpressure: age });
  expect(noClock.owner).toBe("kimi");
  expect(noClock.refusals).toContainEqual(expect.objectContaining({ peer: "codex", code: "queue-age-unknown" }));
});

test("automatic reviewer queue exhaustion holds review instead of approving without a reviewer", () => {
  const result = assign(task, states, routing, { now, queues: { ...empty(), claude: { queued: 3, oldestQueuedAt: now } }, queueBackpressure: count });
  expect(result).toMatchObject({ owner: "codex", reviewer: "user", reviewBlocked: true });
  expect(result.refusals).toContainEqual(expect.objectContaining({ peer: "claude", role: "reviewer", code: "queue-count" }));
  expect(result.trace).not.toContain("reviewer: none, done will approve directly");
});

test("reviewer pool queue pressure keeps rotation slots but skips overloaded candidates", () => {
  const instances = { "claude-review": { kind: "claude", roles: ["reviewer"], start_mode: "headless" }, "claude-two": { kind: "claude", roles: ["reviewer"], start_mode: "headless" } };
  const roles = { "claude-review": ["reviewer"], "claude-two": ["reviewer"] };
  const poolStates = { codex: "idle", "claude-review": "idle", "claude-two": "idle" } as const;
  const queues = { codex: { queued: 0, oldestQueuedAt: null }, "claude-review": { queued: 3, oldestQueuedAt: now }, "claude-two": { queued: 2, oldestQueuedAt: now } };
  const options = { now, instances, roles, queues, queueBackpressure: count, candidates: ["codex"], reviewPool: { pool: ["claude"], required: true } };
  expect(assign(task, poolStates, routing, options)).toMatchObject({ owner: "codex", reviewer: "claude-two", reviewSelection: { reason: "unavailable skip" } });
  const full = assign(task, poolStates, routing, { ...options, queues: { ...queues, "claude-two": { queued: 3, oldestQueuedAt: now } } });
  expect(full).toMatchObject({ reviewer: "user", reviewBlocked: true, reviewSelection: { reviewer: null, blocked: "no reviewer can run" } });
});

test("explicit queue overrides are role-scoped and do not bypass existing safety gates", () => {
  const queues = { ...empty(), codex: { queued: 3 }, claude: { queued: 3 } };
  const owner = assign(task, states, routing, { now, candidates: ["codex"], namedOwner: "codex", queues, queueBackpressure: count, queueOverride: "owner" });
  expect(owner).toMatchObject({ owner: "codex", reviewer: "user", reviewBlocked: true });
  const reviewer = assign(task, states, routing, { now, candidates: ["codex"], namedReviewer: "claude", queues, queueBackpressure: count, queueOverride: "reviewer" });
  expect(reviewer.owner).toBeUndefined(); expect(reviewer.reviewer).toBe("claude");
  expect(assign({ ...task, signals: ["pii"] }, states, routing, { now, candidates: ["codex"], namedOwner: "codex", queues, queueBackpressure: count, queueOverride: "both" }).owner).toBeUndefined();
  const former = assign({ ...task, history: [{ by: "claude", event: "accepted", at: now }] }, states, routing, { now, candidates: ["codex"], namedReviewer: "claude", queues, queueBackpressure: count, queueOverride: "both" });
  expect(former).toMatchObject({ reviewer: "user", reviewBlocked: true });
  expect(former.refusals).toContainEqual(expect.objectContaining({ peer: "claude", code: "policy", reason: "implemented this task" }));
});

test("planner holder selection stays independent of owner and reviewer queue backpressure", () => {
  const result = assign(task, states, routing, { now, planners: ["claude"], queues: { ...empty(), claude: { queued: 3 } }, queueBackpressure: count });
  expect(result).toMatchObject({ owner: "codex", reviewer: "user", reviewBlocked: true, planner: "claude", plannerReason: "rotation" });
});

test("I2 independence precedes reviewer queue pressure and never becomes a queue-held review", () => {
  const result = assign({ ...task, history: [{ by: "claude", event: "accepted", at: now }] }, states, routing, {
    now, queues: { ...empty(), claude: { queued: 3, oldestQueuedAt: now } }, queueBackpressure: count,
  });
  expect(result).toMatchObject({ owner: "codex", reviewer: "user", reviewBlocked: true });
  expect(result.refusals).toContainEqual({ peer: "claude", role: "reviewer", code: "policy", reason: "implemented this task" });
  expect(result.refusals?.some(row => row.role === "reviewer" && row.code.startsWith("queue-"))).toBe(false);
  expect(result.trace).toContain("  every eligible reviewer implemented this task: the person reviews");
  expect(result.trace.some(line => line.includes("reviewer queue backpressure"))).toBe(false);
  const offline = assign({ ...task, history: [{ by: "claude", event: "accepted", at: now }] }, { ...states, claude: "offline" }, routing, {
    now, queues: { ...empty(), claude: { queued: 3, oldestQueuedAt: now } }, queueBackpressure: count,
  });
  expect(offline.refusals).toContainEqual({ peer: "claude", role: "reviewer", code: "offline", reason: "offline" });
  expect(offline.reviewer).toBeUndefined();
});

test("a person-reserved queue-blocked owner is held until its queue admits without another idle peer stealing it", () => {
  const reserved = { ...task, reserved: "codex" };
  const options = { now, queueBackpressure: count, queueReservedHold: "codex" };
  const held = assign(reserved, states, routing, { ...options, queues: { ...empty(), codex: { queued: 3, oldestQueuedAt: now } } });
  expect(held.owner).toBeUndefined();
  expect(held.unreserved).toBe("queue backpressure: queued 3 exceeds max 2");
  expect(held.trace).toContain("reserved owner codex: held, queue backpressure: queued 3 exceeds max 2; reservation retained");
  expect(held.trace.some(line => line.startsWith("  owner candidate kimi:"))).toBe(false);
  for (const queued of [2, 1, 0]) {
    const admitted = assign(reserved, states, routing, { ...options, queues: { ...empty(), codex: { queued, oldestQueuedAt: queued ? now : null } } });
    expect(admitted.owner).toBe("codex"); expect(admitted.unreserved).toBeUndefined();
  }
  const overridden = assign(reserved, states, routing, { ...options, queues: { ...empty(), codex: { queued: 3, oldestQueuedAt: now } }, queueOverride: "owner" });
  expect(overridden.owner).toBe("codex");
  // Automatic reservations retain the prior fallback semantics; the host alone supplies the person's pin.
  expect(assign(reserved, states, routing, { now, queueBackpressure: count, queues: { ...empty(), codex: { queued: 3, oldestQueuedAt: now } } }).owner).toBe("kimi");
  const disabled = assign(reserved, states, routing, { now });
  expect(JSON.stringify(assign(reserved, states, routing, { now, queueReservedHold: "codex", queues: { codex: { queued: 999 } } }))).toBe(JSON.stringify(disabled));
});

test("a person's reservation queue hold leaves non-queue refusals and explicit nominations unchanged", () => {
  const reserved = { ...task, reserved: "codex" }, queues = { ...empty(), codex: { queued: 3, oldestQueuedAt: now } };
  const options = { now, queues, queueBackpressure: count, queueReservedHold: "codex" };
  const excluded = assign(reserved, states, routing, { ...options, exclude: ["codex"] });
  expect(excluded).toMatchObject({ owner: "kimi", unreserved: "excluded (declined or replaced)" });
  expect(assign(reserved, states, routing, { ...options, candidates: ["kimi"], namedOwner: "kimi" }).owner).toBe("kimi");
  const ageHeld = assign(reserved, states, routing, { ...options, queueBackpressure: age, queues: { ...empty(), codex: { queued: 1 } } });
  expect(ageHeld.owner).toBeUndefined();
  expect(ageHeld.refusals).toContainEqual(expect.objectContaining({ peer: "codex", role: "owner", code: "queue-age-unknown" }));
});
