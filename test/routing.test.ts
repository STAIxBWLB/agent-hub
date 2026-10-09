import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assign, loadRouting, predictSplit, SPLIT_MIN, type SplitInput } from "../src/hub/routing.ts";

const task = (className: "plan" | "implement" | "bulk_edit" | "test" | "review" | "summarize" | "triage", signals: string[] = []) => ({ class: className, signals: signals as any });

test("Pi is preferred for implementation tiers, with local ahead of an idle cloud peer", () => {
  const routing = loadRouting(mkdtempSync(join(tmpdir(), "agenthub-routing-")));
  expect(assign(task("implement"), { pi: "idle", local: "idle", codex: "idle", kimi: "idle" } as any, routing)).toMatchObject({ owner: "pi", piBackend: "dgx" });
  const busyLocal = assign(task("implement"), { pi: "offline", local: "busy", codex: "idle", kimi: "offline" } as any, routing);
  expect(busyLocal.owner).toBe("local");
});

test("local_allowed false excludes both local and Pi, while PII remains local-only", () => {
  const routing = loadRouting(mkdtempSync(join(tmpdir(), "agenthub-routing-")));
  expect(assign(task("plan"), { pi: "idle", local: "idle", claude: "idle", codex: "idle" } as any, routing).owner).toBe("claude");
  expect(assign(task("implement", ["pii"]), { pi: "idle", local: "idle", codex: "idle", kimi: "idle" } as any, routing).owner).toBe("local");
  expect(assign(task("implement", ["pii"]), { pi: "idle", codex: "idle", kimi: "idle" } as any, routing).owner).toBeUndefined();
});

test("Pi backend values are validated and class routing exposes MLX/DGX limits", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-routing-"));
  mkdirSync(join(dir, ".agenthub"));
  writeFileSync(join(dir, ".agenthub", "routing.toml"), "[local]\nfixed_model=\"m\"\n[classes.implement]\npeers=[\"pi\"]\npi_backend=\"mlx\"\n[pi]\nmlx_max_context_tokens=8000\ndgx_max_context_tokens=16000\n");
  expect(loadRouting(dir).pi.mlx_max_context_tokens).toBe(8000);
  const bad = mkdtempSync(join(tmpdir(), "agenthub-routing-bad-"));
  mkdirSync(join(bad, ".agenthub"));
  writeFileSync(join(bad, ".agenthub", "routing.toml"), "[local]\nfixed_model=\"m\"\n[classes.implement]\npeers=[\"pi\"]\npi_backend=\"bad\"\n");
  expect(() => loadRouting(bad)).toThrow(/pi_backend/);
});

test("#197 stay_switch defaults to shadow and rejects unknown modes and bounds", () => {
  const routing = loadRouting(mkdtempSync(join(tmpdir(), "agenthub-routing-")));
  expect([routing.stay_switch, routing.max_switch_prefill_tokens]).toEqual(["shadow", 32_000]);
  const write = (text: string) => { const dir = mkdtempSync(join(tmpdir(), "agenthub-routing-")); mkdirSync(join(dir, ".agenthub")); writeFileSync(join(dir, ".agenthub", "routing.toml"), `${text}\n[local]\nfixed_model="m"\n`); return dir; };
  expect(loadRouting(write('stay_switch = "enforce"\nmax_switch_prefill_tokens = 4000')).stay_switch).toBe("enforce");
  expect(() => loadRouting(write('stay_switch = "always"'))).toThrow(/stay_switch/);
  expect(() => loadRouting(write("max_switch_prefill_tokens = 0"))).toThrow(/max_switch_prefill_tokens/);
  expect(routing.pi.efficient_wait_ms).toBe(500); // #199
  expect(loadRouting(write("[pi]\nefficient_wait_ms = 0")).pi.efficient_wait_ms).toBe(0);
  expect(() => loadRouting(write("[pi]\nefficient_wait_ms = -1"))).toThrow(/efficient_wait_ms/);
});

// issue #36: quota that resets soonest is used first; demoted peers go behind the rest.
test("quota: the eligible peer whose headroom resets soonest goes first; a peer without readings keeps its place", () => {
  const routing = loadRouting(mkdtempSync(join(tmpdir(), "agenthub-route-")));
  const t = { class: "implement" as const, signals: [] };
  const states = { codex: "idle", kimi: "idle" } as const;
  expect(assign(t, states, routing).owner).toBe("codex"); // the configured order
  const now = 1_800_000_000_000;
  const quota = { codex: { headroom: 0.8, resetsAt: now + 240 * 60_000 }, kimi: { headroom: 0.4, resetsAt: now + 30 * 60_000 } };
  const a = assign(t, states, routing, { now, quota });
  expect(a.owner).toBe("kimi");
  expect(a.trace).toContain("  quota first: kimi 40% left, resets in 30 min; codex 80% left, resets in 240 min");
  expect(assign(t, { ...states, local: "idle" }, routing, { now, quota }).owner).toBe("local");
});

test("demotion: a peer demoted for the class goes behind the others, and the trace names it", () => {
  const routing = loadRouting(mkdtempSync(join(tmpdir(), "agenthub-route-")));
  const t = { class: "implement" as const, signals: [] };
  const a = assign(t, { codex: "idle", kimi: "idle" }, routing, { demoted: { codex: 2.5 } });
  expect(a.owner).toBe("kimi");
  expect(a.trace).toContain("  demoted for implement: codex (2.5 recent failures)");
  expect(assign(t, { codex: "idle", kimi: "offline" }, routing, { demoted: { codex: 2.5 } }).owner).toBe("codex"); // still better than nobody
  // local keeps its place ahead of the cloud peers only while it is not demoted
  expect(assign(t, { local: "idle", codex: "idle", kimi: "idle" }, routing).owner).toBe("local");
  expect(assign(t, { local: "idle", codex: "idle", kimi: "idle" }, routing, { demoted: { local: 3 } }).owner).toBe("codex");
});

// issue #35: reviewer choice from how reviews of this implementer's work held up, only when review.adaptive is on.
test("adaptive review: with enough record, the reviewer whose reviews held up goes first; off, the order is the configured one", () => {
  const routing = loadRouting(mkdtempSync(join(tmpdir(), "agenthub-route-")));
  const t = { class: "implement" as const, signals: [] };
  const states = { kimi: "idle", claude: "idle", codex: "idle" } as const;
  const reviews = { kimi: { claude: { score: 0.5, n: 6 }, codex: { score: 1, n: 6 } } };
  const off = assign(t, states, routing, { candidates: ["kimi"], reviews });
  expect(off.reviewer).toBe("claude");
  expect(off.trace).toContain("  review record with kimi in implement: claude 6 reviews, 50% held; codex 6 reviews, 100% held (review.adaptive is off)");
  expect(assign(t, states, routing, { candidates: ["kimi"], reviews, adaptive: { min: 5 } }).reviewer).toBe("codex");
  expect(assign(t, states, routing, { candidates: ["kimi"], reviews, adaptive: { min: 7 } }).reviewer).toBe("claude"); // not enough record yet
  expect(assign(t, states, routing, { candidates: ["codex"], reviews: { codex: { codex: { score: 1, n: 9 } } }, adaptive: { min: 1 } }).reviewer).toBe("claude"); // never the implementer
  // with quota readings for both, the record still decides between them: idle, then record, then quota
  const now = 1_800_000_000_000;
  const quota = { claude: { headroom: 0.6, resetsAt: now + 60 * 60_000 }, codex: { headroom: 0.6, resetsAt: now + 300 * 60_000 } };
  expect(assign(t, states, routing, { candidates: ["kimi"], reviews, quota, now }).reviewer).toBe("claude"); // quota alone: claude's window resets first
  const a = assign(t, states, routing, { candidates: ["kimi"], reviews, quota, now, adaptive: { min: 5 } });
  expect(a.reviewer).toBe("codex");
});

// issue #92: reviewer candidates are the review class's peers, then peers holding the reviewer role, deduped, never the owner.
test("reviewer roles: config roles add reviewer candidates after the review class, deduped, never the owner", () => {
  const routing = loadRouting(mkdtempSync(join(tmpdir(), "agenthub-route-")));
  const t = { class: "implement" as const, signals: [] };
  // the review class's peers (claude, codex) are not attached; kimi holds the reviewer role in config
  const a = assign(t, { local: "idle", kimi: "idle" }, routing, { candidates: ["local"], roles: { kimi: ["implementer", "reviewer"] } });
  expect(a).toMatchObject({ owner: "local", reviewer: "kimi" });
  expect(a.trace).toContain("  reviewer candidates: [classes.review] peers claude, codex; reviewer role kimi");
  // the owner never reviews its own work, role or not
  const own = assign(t, { kimi: "idle" }, routing, { candidates: ["kimi"], roles: { kimi: ["reviewer"] } });
  expect(own.reviewer).toBeUndefined();
  expect(own.trace.join("\n")).toContain("reviewer candidate kimi: skipped, is the owner");
  // a role peer already in the review class is listed once
  const dup = assign(t, { claude: "idle", codex: "idle" }, routing, { roles: { claude: ["reviewer", "planner"] } });
  expect(dup.trace.filter((l) => l.includes("reviewer candidate claude")).length).toBe(1);
  expect(dup.reviewer).toBe("claude"); // the class order decides before the role order
});

// issues #89/#90: failing peers are skipped with the reason; held peers stay eligible and the hold is explained.
test("failing peers are skipped; held peers stay eligible and the trace names the hold", () => {
  const routing = loadRouting(mkdtempSync(join(tmpdir(), "agenthub-route-")));
  const t = { class: "implement" as const, signals: [] };
  const a = assign(t, { local: "idle", codex: "idle" }, routing, { failing: { local: "3 undeliverable deliveries" } });
  expect(a.owner).toBe("codex");
  expect(a.trace.join("\n")).toContain("owner candidate local: skipped, failing: 3 undeliverable deliveries");
  const held = assign(t, { local: "idle", codex: "idle" }, routing, { held: { local: "needs_review delivery d1" } });
  expect(held.owner).toBe("local"); // held is not rejected
  expect(held.trace).toContain("  hold: local's queue is held: needs_review delivery d1 (it receives the task once the hold is resolved)");
  const both = assign(t, { local: "idle", codex: "idle", claude: "idle" }, routing, { failing: { local: "x" }, held: { codex: "needs_review delivery d2" } });
  expect(both).toMatchObject({ owner: "codex", reviewer: "claude" });
});

// issue #109: a shadow prediction of whether splitting two equal units between a faster and a slower peer pays. It
// reproduces the algebra on equal-unit data and refuses certainty when an assumption does not hold.
const obs = (o: number, u: number, n = SPLIT_MIN) => Array.from({ length: n }, () => ({ outcome: "approved" as const, orient: o * 1000, work: u * 1000 }));
const splitInput = (over: Partial<SplitInput> = {}): SplitInput => ({
  peers: ["codex", "kimi"],
  observations: { codex: obs(15, 60), kimi: obs(10, 25) },
  units: [1, 1],
  profiles: { codex: "hub 0.12.5; codex 0.159.3; advisory", kimi: "hub 0.12.5; kimi 2.1.1; advisory" },
  backlog: { codex: 0, kimi: 0 },
  available: { codex: true, kimi: true },
  ...over,
});

test("a peer named after an Object member (constructor) is attached, healthy or held only by its own entries (#207)", () => {
  const routing = loadRouting(mkdtempSync(join(tmpdir(), "agenthub-routing-")));
  const reserved = { ...task("implement"), reserved: "constructor" };
  const health = { failing: {}, held: {}, quota: {}, demoted: {}, reviews: {}, roles: {} };
  // attached and healthy: the reservation is honored, not "failing: function Object()"
  const honored = assign(reserved, { constructor: "idle", local: "idle" } as any, routing, health);
  expect(honored.owner).toBe("constructor");
  expect(honored.trace).toContain("reserved owner constructor: honored");
  expect(honored.trace.join("\n")).not.toContain("hold:");
  // not attached: passed over, never chosen, also without the health maps
  for (const opts of [health, {}]) {
    const away = assign(reserved, { local: "idle" } as any, routing, opts);
    expect(away).toMatchObject({ owner: "local", unreserved: "not attached" });
    expect(assign(task("implement"), { local: "idle" } as any, routing, { ...opts, candidates: ["constructor"] }).owner).toBeUndefined();
  }
});

test("split prediction: equal units reproduce o_s + u_s < o_f + 2u_f both ways", () => {
  // kimi fast (10 + 2 * 25 = 60 s), codex slow (15 + 60 = 75 s): kimi alone finishes sooner.
  const single = predictSplit(splitInput());
  expect(single).toMatchObject({ verdict: "single", single: "kimi", splitS: 75, singleS: 60 });
  expect(single.trace).toContain("  split: 75 s (codex 75 s, kimi 35 s for one unit each); kimi alone: 60 s for two");
  // codex (5 + 50 = 55 s for one, 105 s for two) and kimi (40 + 30 = 70 s for one, 100 s for two): the split's 70 s wins.
  const split = predictSplit(splitInput({ observations: { codex: obs(5, 50), kimi: obs(40, 30) } }));
  expect(split).toMatchObject({ verdict: "split", single: "kimi", splitS: 70, singleS: 100 });
  expect(split.trace.slice(0, 3)).toEqual(["shadow split prediction (it never changes assignment):", "  codex: hub 0.12.5; codex 0.159.3; advisory", "  kimi: hub 0.12.5; kimi 2.1.1; advisory"]);
});

test("split prediction: unequal or unknown units, a queued or unavailable owner, thin, biased or scattered records are unknown", () => {
  const why = (over: Partial<SplitInput>) => predictSplit(splitInput(over)).trace.at(-1);
  expect(why({ units: [2, 1] })).toBe("  unknown: work units 2 and 1: the rule needs two equal, known units");
  expect(why({ units: [undefined, 1] })).toBe("  unknown: work units ? and 1: the rule needs two equal, known units");
  expect(why({ profiles: { codex: undefined, kimi: "p" } })).toBe("  unknown: codex's version is unknown: no record can be matched to it");
  expect(why({ backlog: { codex: 0, kimi: 2 } })).toBe("  unknown: kimi has 2 other open task(s): it would not start from orientation plus two units");
  expect(why({ available: { codex: false, kimi: true } })).toBe("  unknown: codex is not available");
  expect(why({ observations: { codex: obs(15, 60, 4), kimi: obs(10, 25) } })).toBe(`  unknown: codex has 4 measured task(s) with this profile; ${SPLIT_MIN} are needed`);
  const failures = Array.from({ length: 4 }, () => ({ outcome: "failed" as const }));
  expect(why({ observations: { codex: [...obs(15, 60), ...failures], kimi: obs(10, 25) } })).toBe("  unknown: 4 of 9 of codex's recorded tasks failed: its successes alone would understate its time");
  const scattered = [5, 10, 60, 200, 400].map((u) => ({ outcome: "approved" as const, orient: 1000, work: u * 1000 }));
  expect(why({ observations: { codex: scattered, kimi: obs(10, 25) } })).toMatch(/^ {2}unknown: codex's work times spread too widely/);
  const unknownStages = Array.from({ length: SPLIT_MIN }, () => ({ outcome: "approved" as const }));
  expect(why({ observations: { codex: unknownStages, kimi: obs(10, 25) } })).toBe(`  unknown: codex has 0 measured task(s) with this profile; ${SPLIT_MIN} are needed`);
  // split 60 s against kimi alone 65 s: under a tenth apart, inconclusive.
  expect(predictSplit(splitInput({ observations: { codex: obs(30, 30), kimi: obs(5, 30) } }))).toMatchObject({ verdict: "unknown", splitS: 60, singleS: 65 });
});
