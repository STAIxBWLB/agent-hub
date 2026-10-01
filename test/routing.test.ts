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
