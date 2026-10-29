import { expect, test } from "bun:test";
import { assign, parseRouting } from "../src/hub/routing.ts";
import { ContextWindows, contextHeadroom, type ContextAdmissionSnapshot, type ContextReading } from "../src/hub/context-window.ts";

const now = 1_800_000_000_000;
const policy = { max_used: 0.8, stale_min: 1 };
const reading = (used: number | null, patch: Partial<ContextReading> = {}): ContextReading => ({ source: "codex_token_usage", sessionId: "private-native-session", measuredAt: now, tokens: null, window: 100, used, ...patch });
const snapshot = (used: number | null): ContextAdmissionSnapshot => ({ reading: reading(used), sessionId: "private-native-session", attached: true });
const routing = parseRouting('[local]\nfixed_model="fixture"\n[classes.implement]\npeers=["codex","kimi"]\n[classes.review]\npeers=["claude"]\n');
const task = { class: "implement" as const, signals: [] as string[] };
const states = { codex: "idle", kimi: "idle", claude: "idle", local: "idle" } as const;
const input = (row: ContextAdmissionSnapshot | undefined = snapshot(0.9)) => ({ now, contextAdmission: { policy, peers: row ? { codex: row } : {} } });

test("context admission skips fresh occupancy at and above threshold, with exact equality", () => {
  expect(assign(task, states, routing, input(snapshot(0.799))).owner).toBe("codex");
  for (const used of [0.8, 0.9, 1]) {
    const a = assign(task, states, routing, input(snapshot(used)));
    expect(a.owner).toBe("kimi");
    expect(a.refusals).toContainEqual({ peer: "codex", role: "owner", code: "context-headroom", reason: `context headroom: used ${used} at or above max 0.8` });
    expect(a.trace.join()).not.toContain("private-native-session");
  }
});

test("missing, stale, future, detached, mismatched and invalid context stay explicitly unknown", () => {
  const invalid: (ContextAdmissionSnapshot | undefined)[] = [undefined, { ...snapshot(0.9), attached: false }, { ...snapshot(0.9), sessionId: "new-session" }, { ...snapshot(0.9), sessionId: undefined },
    ...[now - 60_001, now + 1, NaN, 0].map(measuredAt => ({ ...snapshot(0.9), reading: reading(0.9, { measuredAt }) })),
    ...[null, NaN, Infinity, -0.1, 1.01].map(used => snapshot(used))];
  for (const row of invalid) {
    const a = assign(task, states, routing, { ...input(), contextAdmission: { policy, peers: row ? { codex: row } : {} } });
    expect(a.owner).toBe("codex");
    expect(a.trace).toContain("  owner context codex: context headroom: unknown (no fresh current-session reading)");
    expect(a.refusals?.some(r => r.code === "context-headroom") ?? false).toBe(false);
  }
  expect(contextHeadroom(policy, { ...snapshot(0.9), reading: reading(0.9, { measuredAt: now - 60_000 }) }, now)?.blocked).toBe(true);
});

test("disabled admission leaves assignment and trace byte identical", () => {
  const baseline = assign(task, states, routing, { now });
  expect(assign(task, states, routing, { ...input(), contextAdmission: { policy: { ...policy, max_used: 0 }, peers: { codex: snapshot(1) } } })).toEqual(baseline);
});

test("only host explicit override bypasses context, never a name or reservation", () => {
  expect(assign({ ...task, reserved: "codex" }, states, routing, input()).owner).toBe("kimi");
  expect(assign(task, states, routing, { ...input(), namedOwner: "codex", candidates: ["codex"] }).owner).toBeUndefined();
  expect(assign(task, states, routing, { ...input(), namedOwner: "codex", contextOverride: true }).owner).toBe("codex");
  expect(assign(task, states, routing, { ...input(), contextOverride: true, offRoster: ["codex"] }).owner).toBe("kimi");
  expect(assign({ ...task, signals: ["pii"] }, states, routing, { ...input(), contextOverride: true, candidates: ["codex"] }).owner).toBeUndefined();
  expect(assign(task, { ...states, codex: "paused" }, routing, { ...input(), contextOverride: true }).owner).toBe("kimi");
});

test("reviewer selection and unsupported adapter eligibility are unchanged", () => {
  const review = assign({ class: "review", signals: [] }, states, routing, { ...input(), contextAdmission: { policy, peers: { claude: snapshot(1) } } });
  expect(review.owner).toBe("claude");
  const a = assign(task, states, routing, { ...input(snapshot(0)), contextAdmission: { policy, peers: { codex: snapshot(0), claude: snapshot(1) } } });
  expect(a.reviewer).toBe("claude");
  const unsupported = assign(task, states, routing, { ...input(), candidates: ["local"], contextAdmission: { policy, peers: { local: snapshot(1) } } });
  expect(unsupported.owner).toBe("local");
  expect(unsupported.trace.join()).toContain("context headroom: unknown");
});

test("admission snapshots never trigger checkpoint callbacks or mutate their latch", () => {
  const crossed: number[] = [];
  const windows = new ContextWindows({ gate: 0.7, stale_min: 1, max_assignment_used: 0.8 }, (_peer, r) => crossed.push(r.used!), () => now);
  windows.report("codex", reading(0.9), "private-native-session");
  const row = windows.admission("codex", "private-native-session", true);
  expect(contextHeadroom(policy, row, now)?.blocked).toBe(true);
  row.reading!.used = 0;
  expect(windows.admission("codex", "private-native-session", true).reading?.used).toBe(0.9);
  windows.retry("codex", "private-native-session");
  expect(crossed).toEqual([0.9]);
});
