import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assign, loadRouting } from "../src/hub/routing.ts";

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
