import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/hub/board.ts";
import { Bus } from "../src/hub/bus.ts";
import { BasePeer } from "../src/hub/peers.ts";
import { Tasks } from "../src/hub/tasks.ts";
import type { Envelope } from "../src/hub/envelope.ts";
import { assign, parseRouting } from "../src/hub/routing.ts";
import { selectReviewerPool } from "../src/hub/reviewer-pool.ts";
import { reviewerPoolConfig } from "../src/hub/reviewer-pool-config.ts";
import type { PeerState } from "../src/hub/envelope.ts";

// #820: review.same_family = "never" keeps a reviewer of the owner's family from ever being assigned.
type Options = NonNullable<Parameters<typeof assign>[3]>;
const routing = parseRouting('[local]\nfixed_model="fixture"\n[classes.implement]\npeers=["codex"]\n[classes.review]\npeers=["claude", "codex"]\n');
const work = { id: 7, class: "implement" as const, signals: [] };
const states: Record<string, PeerState> = { codex: "idle", claude: "idle", "codex-review": "idle" };
const fresh = { "codex-review": { kind: "codex", roles: ["reviewer"], start_mode: "headless" as const, review_mode: "fresh" as const } };
const freshClaude = { "claude-review": { kind: "claude", roles: ["reviewer"], start_mode: "headless" as const, review_mode: "fresh" as const } };
const siblings = { "codex-a": { kind: "codex" }, "codex-b": { kind: "codex" } };
const ownerOk = { ownerIsolation: { "codex-a": true } };
const planner = { claude: ["planner", "reviewer"], "codex-review": ["reviewer"], codex: ["implementer"] };

const pool = (sameFamily?: "fallback" | "never", extra: Options = {}, state = states) =>
  assign(work, state, routing, { instances: fresh, roles: planner, candidates: ["codex"], reviewPool: { pool: ["codex"], ...(sameFamily ? { sameFamily } : {}) }, ...extra });
const legacy = (sameFamily?: "fallback" | "never", extra: Options = {}, state = states) =>
  assign(work, state, routing, { instances: siblings, ...ownerOk, roles: { claude: ["planner", "reviewer"], "codex-a": ["implementer"], "codex-b": ["reviewer"] }, candidates: ["codex-a"],
    ...(sameFamily ? { reviewPool: { pool: ["claude"], sameFamily } } : {}), ...extra }, );
const legacyStates: Record<string, PeerState> = { "codex-a": "idle", "codex-b": "idle", claude: "idle" };

test("AC2 fallback and the unset default keep today's same-family routing and its record", () => {
  for (const mode of [undefined, "fallback" as const]) {
    expect(pool(mode)).toMatchObject({ owner: "codex", reviewer: "codex-review", sameFamilyFallback: true, reviewSelection: { reason: "same-family fallback" } });
  }
  expect(pool(undefined)).toEqual(pool("fallback"));
});

test("AC1 never, pool path: a Codex-owned task with only codex-review goes to the planner, recorded as a planner fallback", () => {
  const result = pool("never");
  expect(result).toMatchObject({ owner: "codex", reviewer: "claude", plannerFallback: true, reviewSelection: { reviewer: null, blocked: "no reviewer can run" } });
  expect(result.sameFamilyFallback).toBeUndefined();
  expect(result.reviewBlocked).toBeUndefined();
  expect(result.trace.join("\n")).toContain("review.same_family = never");
});

test("AC1 never, pool path: no eligible planner means the person reviews", () => {
  const cases: [string, Options, Record<string, PeerState>][] = [
    ["planner is offline", {}, { ...states, claude: "offline" }],
    ["planner does not hold the reviewer role", { roles: { claude: ["planner"], "codex-review": ["reviewer"], codex: ["implementer"] } }, states],
    ["planner is the owner", { candidates: ["claude"], instances: freshClaude, roles: { claude: ["planner", "reviewer", "implementer"], "claude-review": ["reviewer"] }, reviewPool: { pool: ["claude"], sameFamily: "never" as const } }, { ...states, "claude-review": "idle" }],
    ["planner is of the owner's family", { instances: { ...fresh, "codex-plan": { kind: "codex" } }, roles: { ...planner, claude: ["implementer"], "codex-plan": ["planner", "reviewer"] } }, { ...states, "codex-plan": "idle" }],
  ];
  for (const [name, extra, state] of cases) {
    const result = pool("never", extra, state);
    expect(result, name).toMatchObject({ reviewer: "user", reviewBlocked: true });
    expect(result.sameFamilyFallback, name).toBeUndefined();
  }
});

test("never still selects an eligible other-family declared reviewer, with no planner fallback", () => {
  const withClaude = { instances: { ...fresh, ...freshClaude }, roles: { ...planner, "claude-review": ["reviewer"] }, reviewPool: { pool: ["claude", "codex"], sameFamily: "never" as const } };
  const result = assign(work, { ...states, "claude-review": "idle" }, routing, { candidates: ["codex"], ...withClaude });
  expect(result).toMatchObject({ owner: "codex", reviewer: "claude-review", reviewSelection: { family: "claude", reason: "implementer skip" } });
  expect(result.plannerFallback).toBeUndefined();
});

test("never, legacy path: same-family siblings are not candidates; the planner reviews, else the person", () => {
  const withPlanner = legacy("never", {}, legacyStates);
  expect(withPlanner).toMatchObject({ owner: "codex-a", reviewer: "claude" });
  expect(withPlanner.sameFamilyFallback).toBeUndefined();
  const noPlanner = legacy("never", { roles: { "codex-a": ["implementer"], "codex-b": ["reviewer"] } }, { ...legacyStates, claude: "offline" });
  expect(noPlanner).toMatchObject({ owner: "codex-a", reviewer: "user", reviewBlocked: true });
  expect(noPlanner.sameFamilyFallback).toBeUndefined();
  expect(noPlanner.trace.join("\n")).toContain("the person reviews");
  // fallback keeps picking the sibling, as before
  expect(legacy("fallback", { reviewPool: undefined }, { ...legacyStates, claude: "offline" })).toMatchObject({ reviewer: "codex-b", sameFamilyFallback: true });
});

test("never, legacy path: offline sibling and offline planner reproduce the review finding and route to the person", () => {
  const result = legacy("never", {}, { ...legacyStates, "codex-b": "offline", claude: "offline" });
  expect(result).toMatchObject({ owner: "codex-a", reviewer: "user", reviewBlocked: true });
  expect(result.trace).not.toContain("reviewer: none, done will approve directly");
});

test("never, legacy path: an exhausted choice goes to the person, never to direct approval", () => {
  const cases: [string, Options, Record<string, PeerState>][] = [
    ["sibling and planner offline", {}, { ...legacyStates, "codex-b": "offline", claude: "offline" }],
    ["no reviewer-role peer and the class reviewer is offline", { roles: { "codex-a": ["implementer"] } }, { ...legacyStates, claude: "offline" }],
    ["a same-family sibling is the only reviewer and the other family is offline", { roles: { "codex-a": ["implementer"], "codex-b": ["reviewer"] } }, { ...legacyStates, claude: "offline" }],
  ];
  for (const [name, extra, state] of cases) {
    const result = legacy("never", extra, state);
    expect(result, name).toMatchObject({ owner: "codex-a", reviewer: "user", reviewBlocked: true });
    expect(result.sameFamilyFallback, name).toBeUndefined();
    expect(result.trace, name).not.toContain("reviewer: none, done will approve directly");
    expect(result.trace.join("\n"), name).toContain("the person reviews");
  }
  // the default keeps approving directly when nobody at all is left, as before
  expect(legacy(undefined, { roles: { "codex-a": ["implementer"] } }, { ...legacyStates, "codex-b": "offline", claude: "offline" }).trace).toContain("reviewer: none, done will approve directly");
});

test("never without declared instances still never approves unreviewed work when nobody can review", () => {
  const exhausted = assign(work, { codex: "idle" }, routing, { candidates: ["codex"], reviewPool: { pool: ["codex"], sameFamily: "never" } });
  expect(exhausted).toMatchObject({ owner: "codex", reviewer: "user", reviewBlocked: true });
  expect(exhausted.trace).not.toContain("reviewer: none, done will approve directly");
  // an available class reviewer still reviews, and the default still approves directly
  expect(assign(work, { codex: "idle", claude: "idle" }, routing, { candidates: ["codex"], reviewPool: { pool: ["codex"], sameFamily: "never" } }).reviewer).toBe("claude");
  expect(assign(work, { codex: "idle" }, routing, { candidates: ["codex"], reviewPool: { pool: ["codex"] } }).trace).toContain("reviewer: none, done will approve directly");
});

test("AC3 never refuses a manually named same-family reviewer with the stated text, in both paths", () => {
  const refused = (result: ReturnType<typeof assign>, peer: string, owner = "codex") => {
    expect(result.reviewer).toBeUndefined();
    expect(result.refusals).toContainEqual(expect.objectContaining({ peer, role: "reviewer", code: "family", reason: `same family as ${owner}; review.same_family is never` }));
  };
  refused(pool("never", { namedReviewer: "codex-review" }), "codex-review");
  refused(assign(work, legacyStates, routing, { instances: siblings, ...ownerOk, roles: { "codex-a": ["implementer"], "codex-b": ["reviewer"] }, candidates: ["codex-a"], namedReviewer: "codex-b", reviewPool: { pool: ["claude"], sameFamily: "never" } }), "codex-b", "codex-a");
  // fallback: the same nomination is allowed only when no other family is eligible (today's rule)
  expect(pool("fallback", { namedReviewer: "codex-review" }).reviewer).toBeUndefined();
  expect(pool("fallback", { namedReviewer: "codex-review" }, { ...states, claude: "offline" }).reviewer).toBe("codex-review");
  expect(pool("never", { namedReviewer: "codex-review" }, { ...states, claude: "offline" }).reviewer).toBeUndefined();
  // an other-family nomination is untouched
  expect(pool("never", { namedReviewer: "claude" }).reviewer).toBe("claude");
});

test("the selector skips its last-resort same-family loop only under never", () => {
  const candidates = [{ id: "codex-review", kind: "codex", family: "codex" }];
  expect(selectReviewerPool({ pool: ["codex"], candidates, implementerFamily: "codex", seed: 1 })).toMatchObject({ reviewer: "codex-review", reason: "same-family fallback" });
  expect(selectReviewerPool({ pool: ["codex"], candidates, implementerFamily: "codex", seed: 1, sameFamily: "never" })).toMatchObject({ reviewer: null, blocked: "no reviewer can run" });
});

test("AC4 config: same_family validates as fallback or never and stays out of the result unless never", async () => {
  const defaults = ["alpha"];
  expect(reviewerPoolConfig({}, defaults, defaults)).toEqual({ pool: defaults, rerotate: false });
  expect(reviewerPoolConfig({ same_family: "fallback" }, defaults, defaults)).toEqual({ pool: defaults, rerotate: false });
  expect(reviewerPoolConfig({ same_family: "never" }, defaults, defaults)).toEqual({ pool: defaults, rerotate: false, sameFamily: "never" });
  for (const bad of ["always", true, 1, null]) expect(() => reviewerPoolConfig({ same_family: bad }, defaults, defaults)).toThrow("review.same_family");
  const { validateRawConfig } = await import("../src/hub/config-apply.ts");
  expect(() => validateRawConfig({ review: { same_family: "never" } })).not.toThrow();
  expect(() => validateRawConfig({ review: { same_family: "sometimes" } })).toThrow("review.same_family");
});

// The board boundary: Tasks passes the config through, so done() reaches the planner and a manual nomination is refused.

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
class Quiet extends BasePeer {
  readonly seen: Envelope[] = [];
  async start() { this.setState("idle"); }
  async stop() { this.setState("offline"); }
  async deliver(envs: Envelope[]) { this.seen.push(...envs); }
}
async function rig(sameFamily: "fallback" | "never", claudeUp = true) {
  const cwd = mkdtempSync(join(tmpdir(), "ahub-same-family-")), board = new Board(join(cwd, "hub.db")), bus = new Bus({ batchMs: 0 });
  const tasks = new Tasks({
    cwd, board, bus, project: "fixture", instances: () => fresh, roles: planner, notify: () => {},
    review: { adaptive: false, min_reviews: 5, same_family: sameFamily },
    routing: () => parseRouting('[local]\nfixed_model="fixture"\n[classes.summarize]\npeers=["codex"]\n[classes.review]\npeers=["claude", "codex"]\n'), reviewOnly: () => true,
  });
  for (const id of ["codex", "claude", "codex-review"]) { const peer = new Quiet(id); bus.add(peer); await peer.start(); if (id === "claude" && !claudeUp) await peer.stop(); }
  const task = board.propose("user", { title: "Review implementation", class: "summarize" });
  board.update(task.id, "codex", "accepted", { owner: "codex", state: "in_progress", refs: { commit: "a".repeat(40) } });
  cleanups.push(() => { bus.closeJournal(); board.close(); rmSync(cwd, { recursive: true, force: true }); });
  return { tasks, task };
}

test("AC1 Tasks.done under never routes a Codex task to the planner; under fallback it keeps codex-review", async () => {
  const never = await rig("never");
  expect(await never.tasks.done("codex", never.task.id, "ready")).toMatchObject({ state: "in_review", reviewer: "claude" });
  const fallback = await rig("fallback");
  const done = await fallback.tasks.done("codex", fallback.task.id, "ready");
  expect(done).toMatchObject({ state: "in_review", reviewer: "codex-review" });
  expect(done.history.at(-1)).toMatchObject({ reviewerReason: "same-family fallback" });
});

test("AC1 Tasks.done under never sends the review to the person when the planner is down", async () => {
  const { tasks, task } = await rig("never", false);
  const done = await tasks.done("codex", task.id, "ready");
  expect(done).toMatchObject({ state: "in_review", reviewer: "user" });
  expect(done.history.at(-1)?.reviewBlocked).toBe(true);
});

test("AC3 Tasks.assignTo refuses a same-family reviewer under never with the stated text", async () => {
  const { tasks, task } = await rig("never");
  await expect(tasks.assignTo(task.id, "codex-review", "user", true, "reviewer")).rejects.toThrow("same family as codex; review.same_family is never");
  expect(await tasks.assignTo(task.id, "claude", "user", true, "reviewer")).toMatchObject({ reviewer: "claude" });
});

test("AC4 route explain names the rule under never and says nothing under fallback", async () => {
  const never = await rig("never"), fallback = await rig("fallback");
  const lines = never.tasks.explain(never.task.id).join("\n");
  expect(lines).toContain("review.same_family = never");
  expect(lines).toContain("reviewer: claude");
  expect(fallback.tasks.explain(fallback.task.id).join("\n")).not.toContain("review.same_family");
});
