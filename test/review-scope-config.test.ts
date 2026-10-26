import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectAdapterCatalog } from "../src/adapters/registry.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { configTier } from "../src/hub/config-tier.ts";
import { readInstanceConfig } from "../src/hub/instance-config.ts";
import { validateInstances } from "../src/hub/instances.ts";
import { realPath } from "../src/hub/project.ts";

// agent-hub#852 (task #514) AC1: a reviewer's review scope, its default by definition, the local-only override and the status row.
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });
const catalog = createProjectAdapterCatalog();
const fresh = { roles: ["reviewer"], start_mode: "headless", review_mode: "fresh" };
const scopeOf = (id: string, declared: Record<string, unknown>) => {
  const instances = validateInstances(declared, catalog);
  return { instance: instances[id]?.review_scope, definition: catalog.definitionOf(id, instances)?.reviewer?.scope };
};

test("AC1: the sandboxed fresh reviewers default to code by definition and a Claude reviewer to full", () => {
  expect(scopeOf("codex-review", { "codex-review": { kind: "codex", ...fresh } })).toEqual({ instance: undefined, definition: "code" });
  expect(scopeOf("kimi-review", { "kimi-review": { kind: "kimi", ...fresh } })).toEqual({ instance: undefined, definition: "code" });
  expect(scopeOf("claude-review", { "claude-review": { kind: "claude", roles: ["reviewer"], start_mode: "headless" } })).toEqual({ instance: undefined, definition: undefined }); // full by default
  // The scope lives on the reviewer variant only: the base peers (an implementer's own definition) carry none.
  expect(catalog.definitionOf("codex")?.reviewerVariant?.reviewer?.scope).toBe("code");
  expect(catalog.definitionOf("kimi")?.reviewerVariant?.reviewer?.scope).toBe("code");
  expect(catalog.definitionOf("claude")?.reviewerVariant?.reviewer?.scope).toBeUndefined();
  expect(catalog.definitionOf("codex")?.reviewer?.scope).toBeUndefined();
});

test("AC1: a fresh-reviewer instance may set review_scope; it is validated and frozen, and only a fresh reviewer takes it", () => {
  const parsed = validateInstances({ "codex-review": { kind: "codex", ...fresh, review_scope: "full" }, "kimi-review": { kind: "kimi", ...fresh, review_scope: "code" } }, catalog);
  expect(parsed["codex-review"]?.review_scope).toBe("full"); expect(parsed["kimi-review"]?.review_scope).toBe("code");
  expect(Object.isFrozen(parsed["codex-review"])).toBe(true);
  for (const bad of ["", "both", "CODE", 1, null, true, ["code"], { scope: "code" }]) {
    expect(() => validateInstances({ "codex-review": { kind: "codex", ...fresh, review_scope: bad } }, catalog), JSON.stringify(bad)).toThrow(/review_scope/);
  }
  // A headless implementer, a channel instance and a kind with no fresh reviewer take no scope.
  expect(() => validateInstances({ "claude-impl": { kind: "claude", roles: ["implementer"], start_mode: "headless", worktree: ".worktrees/claude-impl", permission_mode: "ask", review_scope: "full" } }, catalog)).toThrow(/review_scope/);
  expect(() => validateInstances({ "codex-worker": { kind: "codex", roles: ["implementer"], start_mode: "headless", worktree: ".worktrees/w", review_scope: "code" } }, catalog)).toThrow(/review_scope/);
  expect(() => validateInstances({ "pi-review": { kind: "pi", start_mode: "headless", review_scope: "code" } }, catalog)).toThrow();
});

test("AC1: review_scope comes only from the untracked config.local.json; a tracked declaration is ignored with a reason", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-review-scope-config-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agenthub"));
  const declaration = { instances: { "codex-review": { kind: "codex", ...fresh, review_scope: "full" } } };
  writeFileSync(join(dir, ".agenthub", "config.json"), JSON.stringify(declaration));
  const tracked = readInstanceConfig(dir);
  expect(tracked.instances).toBeUndefined();
  expect(tracked.ignored.join("\n")).toContain("machine-local config.local.json");
});

test("AC1: review_scope is tier 3, so the dashboard and a settings session can neither read nor change it", () => {
  const tier = (...path: string[]) => configTier("config.local.json", path);
  expect(tier("instances", "codex-review", "review_scope")).toEqual({ tier: 3, key: "instances.codex-review.review_scope" });
  expect(configTier("config.local.json", ["instances", "codex-review"], { kind: "codex", ...fresh, review_scope: "full" })).toEqual({ tier: 3, key: "instances.codex-review" });
  expect(configTier("config.local.json", ["instances", "codex-review"], { kind: "codex", ...fresh }, { kind: "codex", review_scope: "full" })).toEqual({ tier: 3, key: "instances.codex-review" });
  expect(configTier("config.local.json", ["instances", "codex-review"], { kind: "codex", ...fresh })).toEqual({ tier: 2 });
});

test("AC1: ahub status shows the scope on every review-only row, the person's override included, and on no other row", async () => {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-review-scope-daemon-"))), project = join(root, "project"), stateDir = join(project, "state");
  cleanups.push(() => rmSync(root, { recursive: true, force: true })); mkdirSync(stateDir, { recursive: true });
  const daemon = await startDaemon({ cwd: project, stateDir, controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
    config: { ...DEFAULT_CONFIG, instances: { "codex-review": { kind: "codex", ...fresh, review_scope: "full" } as never, "kimi-review": { kind: "kimi", ...fresh } as never }, batch_ms: 0,
      snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false },
      pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
  cleanups.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console" }); cleanups.push(() => console_.close());
  const peers = (await console_.request({ t: "status" })).status.peers as Record<string, { reviewScope?: string }>;
  expect(peers["kimi-review"]?.reviewScope).toBe("code");   // the definition default
  expect(peers["codex-review"]?.reviewScope).toBe("full");  // the person's local override
  expect(peers.codex?.reviewScope).toBeUndefined();         // an implementer row carries none
  expect(peers.claude?.reviewScope).toBeUndefined();
}, 20_000);
