import { expect, test } from "bun:test";
import { assign, parseRouting } from "../src/hub/routing.ts";
import type { PeerState } from "../src/hub/envelope.ts";

const instances = {
  "claude-review": { kind: "claude", roles: ["reviewer"], start_mode: "headless" },
  "claude-two": { kind: "claude", roles: ["reviewer"], start_mode: "headless" },
  "claude-channel": { kind: "claude" },
};
const roles = { "claude-review": ["reviewer"], "claude-two": ["reviewer"], "claude-channel": ["reviewer"] };
const routing = parseRouting('[local]\nfixed_model="fixture"\n[classes.implement]\npeers=["codex"]\n[classes.review]\npeers=["claude", "codex"]\n');
const work = { id: 1, class: "implement" as const, signals: [] };
const states: Record<string, PeerState> = { codex: "idle", claude: "idle", "claude-review": "idle", "claude-two": "idle", "claude-channel": "idle" };
type Options = NonNullable<Parameters<typeof assign>[3]>;
const options: Options = { instances, roles, candidates: ["codex"], reviewPool: { pool: ["claude"] } };
const choose = (extra: Options = {}, state = states) => assign(work, state, routing, { ...options, ...extra });

test("declared fresh reviewers use selector metadata and stable ids without changing the owner", () => {
  const result = choose();
  expect(result).toMatchObject({ owner: "codex", reviewer: "claude-review", reviewSelection: { reviewer: "claude-review", family: "claude", reason: "rotation" } });
  expect(result.trace.some(line => line.includes("reviewer pool") && line.includes("claude-review"))).toBe(true);
  expect(result.reviewSelection?.walk.map(row => row.id)).toEqual(["claude-review"]);
  expect(result.reviewBlocked).toBeUndefined();
});

test("held queues, exhausted quota and per-review failures skip to the next declared fresh instance", () => {
  for (const extra of [
    { held: { "claude-review": "pending delivery needs review" } },
    { quota: { "claude-review": { headroom: 0 } } },
    { reviewPool: { pool: ["claude"], failed: ["claude-review"] } },
    { failing: { "claude-review": "start failed" } },
    { offRoster: ["claude-review"] },
    { exclude: ["claude-review"] },
  ] satisfies Options[]) {
    expect(choose(extra)).toMatchObject({ owner: "codex", reviewer: "claude-two", reviewSelection: { reason: "unavailable skip" } });
  }
  expect(choose({ quota: { "claude-review": { headroom: -0.1 } } }).reviewer).toBe("claude-two");
});

test("pool exhaustion keeps a person reviewer and records blocked instead of automatic approval", () => {
  const result = choose({}, { ...states, "claude-review": "offline", "claude-two": "offline" });
  expect(result).toMatchObject({ owner: "codex", reviewer: "user", reviewBlocked: true, reviewSelection: { reviewer: null, blocked: "no reviewer can run" } });
  expect(result.trace).toContain("blocked: no reviewer can run");
  expect(result.trace).not.toContain("reviewer: none, done will approve directly");
});

test("same-family fallback uses a distinct declared fresh reviewer and records its reason", () => {
  const result = choose({ candidates: ["claude"] });
  expect(result).toMatchObject({ owner: "claude", reviewer: "claude-review", sameFamilyFallback: true, reviewSelection: { family: "claude", reason: "same-family fallback" } });
});

test("absent pool policy or absent fresh declarations retain byte-identical legacy routing", () => {
  const legacy = choose({ reviewPool: undefined });
  expect(choose({ reviewPool: { pool: ["unavailable-kind"] } })).toMatchObject({ reviewer: "user", reviewBlocked: true });
  expect(choose({ reviewPool: undefined })).toEqual(legacy);
  const channelOptions = { ...options, instances: { "claude-channel": instances["claude-channel"] }, roles: { "claude-channel": ["reviewer"] } };
  expect(assign(work, states, routing, channelOptions)).toEqual(assign(work, states, routing, { ...channelOptions, reviewPool: undefined }));
});

test("explicit reviewer nominations retain the existing independence guard outside automatic pool selection", () => {
  const result = choose({ candidates: ["claude"], namedReviewer: "claude-review" });
  expect(result.reviewer).toBeUndefined();
  expect(result.refusals).toContainEqual(expect.objectContaining({ peer: "claude-review", code: "family" }));
  expect(result.reviewSelection).toBeUndefined();
});

test("PII routing stays outside the cloud reviewer pool", () => {
  const result = assign({ ...work, signals: ["pii"] }, states, routing, options);
  expect(result.reviewer).toBe("user");
  expect(result.reviewSelection).toBeUndefined();
});

test("pool skips a paused reviewer even when legacy budget-paused routing is disabled", () => {
  const permissive = { ...routing, constraints: { ...routing.constraints, budget_paused: "off" as const } };
  const result = assign(work, { ...states, "claude-review": "paused" }, permissive, options);
  expect(result).toMatchObject({ reviewer: "claude-two", reviewSelection: { reason: "unavailable skip" } });
  expect(result.reviewSelection?.walk[0]).toMatchObject({ id: "claude-review", reason: "unavailable skip: paused" });
});

test("an explicitly required pool with no declared reviewer is blocked for the person", () => {
  expect(choose({ reviewPool: { pool: ["unavailable-kind"], required: true } })).toMatchObject({ reviewer: "user", reviewBlocked: true });
});

test("only unavailable declarations outside the default pool block instead of falling through to auto-approval", () => {
  for (const kind of ["kimi", "agy"]) {
    const id = `${kind}-review`, declarations = { [id]: { kind, roles: ["reviewer"], start_mode: "headless" } };
    const result = assign(work, { codex: "idle", [id]: "idle" }, routing, { candidates: ["codex"], roles: { [id]: ["reviewer"] }, instances: declarations, reviewPool: { pool: ["claude", "codex"] } });
    expect(result).toMatchObject({ reviewer: "user", reviewBlocked: true });
    expect(result.trace.join("\n")).toContain("#533");
    const named = assign(work, { codex: "idle", [id]: "idle" }, routing, { candidates: ["codex"], roles: { [id]: ["reviewer"] }, instances: declarations, namedReviewer: id });
    expect(named.reviewer).toBeUndefined();
    expect(named.trace.join("\n")).toContain("#533");
  }
});
