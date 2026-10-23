import { expect, test } from "bun:test";
import { authorizeConfigLeaf } from "../src/hub/config-apply.ts";

const base = { source: "config" as const, sourceFile: "config.local.json", tracked: false as const };
const leaf = (key: string, authority: "ordinary" | "settings" | "terminal", extra: Record<string, unknown> = {}) =>
  authorizeConfigLeaf({ ...base, key, before: undefined, after: "x", authority, ...extra } as Parameters<typeof authorizeConfigLeaf>[0]);

test("#689 a named structural edit is allowed for a settings session or a terminal, never an ordinary session", () => {
  for (const key of ["instances.codex-review.kind", "instances.codex-review.roles", "review.pool", "snapshots.keep", "approvals.timeout_s", "context.gate"]) {
    for (const authority of ["settings", "terminal"] as const) expect(leaf(key, authority, { structural: true, confirmed: true }), `${key} ${authority}`).toMatchObject({ allowed: true, guarded: true });
    expect(leaf(key, "ordinary", { structural: true, confirmed: true }).allowed, `${key} ordinary`).toBe(false);
  }
});

test("#689 without the daemon's structural flag and the key's own confirmation the same change is refused as before", () => {
  expect(leaf("review.pool", "settings", { confirmed: true }).allowed).toBe(false);
  expect(leaf("review.pool", "settings", { structural: true }).allowed).toBe(false);
  expect(leaf("instances.codex-review.kind", "settings", { confirmed: true }).allowed).toBe(false);
});

test("#689 the terminal's own confirmed reload is unchanged by the structural flag", () => {
  for (const structural of [true, false]) expect(leaf("kimi_cmd", "terminal", { confirmed: true, structural }).allowed).toBe(true);
  expect(leaf("kimi_cmd", "terminal", { structural: true }).allowed).toBe(false);
});

test("#689 tier 3 keys are never admitted to a settings session by the structural rule, whatever the flags", () => {
  for (const key of ["instances.jcode-two.jcode_home", "instances.jcode-two.model", "kimi_cmd", "omniroute.api_key_file", "terminal.open", "adapters.grok", "checks.timeout_s", "local.network_allow"]) {
    expect(leaf(key, "settings", { structural: true, confirmed: true }).allowed, key).toBe(false);
  }
});

test("#689 a structural edit never reaches a tracked file or another source file", () => {
  expect(leaf("review.pool", "settings", { structural: true, confirmed: true, tracked: true }).allowed).toBe(false);
  expect(leaf("review.pool", "settings", { structural: true, confirmed: true, tracked: undefined }).allowed).toBe(false);
  expect(leaf("review.pool", "settings", { structural: true, confirmed: true, sourceFile: "config.json" }).allowed).toBe(false);
  expect(leaf("review.pool", "settings", { structural: true, confirmed: true, source: "routing" }).allowed).toBe(false);
});
