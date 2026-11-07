import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, lstatSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { realPath } from "../src/hub/project.ts";
import { runBoundedReceiptCommand } from "../scripts/compat-receipts/runner.ts";
import type { ProofContext, ProofResults } from "../scripts/compat-receipts/types.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fake = resolve(import.meta.dir, "fakes/compat-receipt-jcode.ts");
const producer = resolve(import.meta.dir, "../scripts/compat-receipts/proofs/jcode.ts");
const runner = resolve(import.meta.dir, "../scripts/compat-receipts/runner.ts");
const native = ["isolation", "serve-cleanup", "acp-initialize-new-load-mode-ceilings", "mcp-owned-environment", "telemetry", "active-turn-soft-interrupt"];
async function run(fault = "none", legMs = 5000, inspect?: (root: string) => void, blockDiagnostics = false, setup?: (root: string) => void): Promise<ProofResults> {
  const root = realPath(mkdtempSync(join(tmpdir(), "jcode-proof-"))); roots.push(root);
  const home = join(root, "home"), prefix = join(root, "prefix"), cwd = join(root, "project");
  const env: NodeJS.ProcessEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, LANG: "C", LC_ALL: "C", TZ: "UTC" };
  for (const dir of [home, prefix, cwd]) mkdirSync(dir, { mode: 0o700 });
  for (const key of ["TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "AGENTHUB_HOME", "AMEM_HOME", "CODEX_HOME", "KIMI_CODE_HOME", "CLAUDE_CONFIG_DIR"]) {
    env[key] = join(root, key.toLowerCase()); mkdirSync(env[key]!, { mode: 0o700 });
  }
  const cli = join(prefix, "jcode.ts");
  writeFileSync(cli, `#!${process.execPath}\n${readFileSync(fake, "utf8").replace(/^#![^\n]*\n/, "")}`); chmodSync(cli, 0o700);
  const input: Omit<ProofContext, "run" | "signal"> = { id: "jcode", version: "0.99.1", root, home, prefix, cwd, env,
    artifact: { method: "fixture", integrity: "fixture", packageRoot: prefix, command: [cli, "--fault", fault] },
    entry: { receipt: "fixture", runnerOS: ["linux"], nativePlatform: "fixture", autoAdmit: false, install: { method: "fixture" }, legs: [] },
    limits: { totalMs: 15000, installMs: 5000, legMs, outputBytes: 1024 * 1024, artifactBytes: 1024, expandedBytes: 1024, archiveEntries: 1000 } };
  const file = join(root, "context.json"); writeFileSync(file, JSON.stringify(input));
  if (blockDiagnostics) writeFileSync(join(root, "jcode-proof-observations.jsonl"), "existing private diagnostic\n", { mode: 0o600, flag: "wx" });
  setup?.(root);
  const answer = await runBoundedReceiptCommand([process.execPath, fake, "--proof-worker", file, producer, runner], {
    cwd, env, signal: AbortSignal.timeout(15000), timeoutMs: 15000, maxBytes: 1024 * 1024,
  });
  expect(answer.exitCode).toBe(0); expect(answer.ownedStopConfirmed).toBe(true);
  inspect?.(root);
  return JSON.parse(answer.stdout);
}
test("reconstructed Jcode proof asserts every native leg against the protocol fake", async () => {
  const result = await run();
  for (const id of native) expect(result[id]).toEqual({ status: "pass", cause: "ok" });
  expect(result["source-comparison"]).toBeUndefined(); // A fake protocol cannot perform human source review.
}, 20000);
for (const fault of ["identity", "protocol", "load-capability", "auth-methods", "new-models", "load-echo", "mode-supported"]) {
  test(`ACP ${fault} invariant fails rather than admitting a changed contract`, async () => {
    const result = await run(fault);
    expect(result["acp-initialize-new-load-mode-ceilings"]).toEqual({ status: "fail", cause: "proof-failed" });
    expect(result["active-turn-soft-interrupt"]?.status).not.toBe("pass");
    expect(result["serve-cleanup"]).toEqual({ status: "pass", cause: "ok" });
  }, 20000);
}
for (const fault of ["mcp-peer", "mcp-launch"]) {
  test(`MCP inherited ${fault} must match the owned environment`, async () => {
    const result = await run(fault);
    expect(result["mcp-owned-environment"]).toEqual({ status: "fail", cause: "proof-failed" });
    expect(result["serve-cleanup"]?.status).toBe("pass");
  }, 20000);
}
for (const fault of ["capability", "capability-string", "subscribe-session", "idle-active", "active-idle", "state-session", "cancelled", "missing-assistant", "missing-steer", "request-order", "extra-user", "first-extra-user"]) {
  test(`steering ${fault} invariant is checked`, async () => {
    const result = await run(fault);
    expect(result["active-turn-soft-interrupt"]).toEqual({ status: "fail", cause: "proof-failed" });
    expect(result["serve-cleanup"]?.status).toBe("pass");
  }, 20000);
}
test("serve sidecar identity is asserted before cleanup can pass the leg", async () => {
  const result = await run("serve-identity");
  expect(result["serve-cleanup"]).toEqual({ status: "fail", cause: "proof-failed" });
}, 20000);
test("telemetry artifact violates its own native leg", async () => {
  const result = await run("telemetry");
  expect(result.telemetry).toEqual({ status: "fail", cause: "proof-failed" });
}, 20000);
test("private decoy mutation fails isolation without reading a real native home", async () => {
  const result = await run("decoy-mutated");
  expect(result.isolation).toEqual({ status: "fail", cause: "proof-failed" });
}, 20000);
test("missing steer ack times out and still confirms owned original groups stopped", async () => {
  const result = await run("ack-missing", 2000);
  expect(result["active-turn-soft-interrupt"]).toEqual({ status: "fail", cause: "timeout" });
  expect(result["serve-cleanup"]).toEqual({ status: "pass", cause: "ok" });
}, 20000);

test("telemetry in the private HOME fails even when JCODE_HOME and decoy configs stay clean", async () => {
  const result = await run("home-telemetry");
  expect(result.telemetry).toEqual({ status: "fail", cause: "proof-failed" });
  expect(result.isolation).toEqual({ status: "pass", cause: "ok" });
}, 20000);

test("private diagnostics contain closed checkpoints only and retain exact proof outcomes", async () => {
  const result = await run("none", 5000, root => {
    const file = join(root, "jcode-proof-observations.jsonl"), text = readFileSync(file, "utf8");
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16 * 1024);
    const rows = text.trim().split("\n").map(line => JSON.parse(line));
    expect(rows.length).toBeGreaterThan(0); expect(rows.length).toBeLessThanOrEqual(64);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["cause", "count", "passed", "rootClass", "step"]);
      expect(typeof row.passed).toBe("boolean"); expect(Number.isSafeInteger(row.count)).toBe(true);
      expect(["none", "home", "jcode-home"]).toContain(row.rootClass);
      expect(["ok", "pending", "assertion", "telemetry-id", "milestone", "opt-out-marker", "other-telemetry-name", "symlink", "entry-budget", "io", "original", "steer", "head", "session-context", "system-reminder", "other", "directory", "regular", "identity-lock", "install-marker", "version-marker", "usage-outbox", "concurrency-dir", "active-sessions", "category-optout", "share-transcript-consent"]).toContain(row.cause);
      expect(["steer-pong", "steer-subscribe", "steer-idle", "steer-stream-arrived", "steer-active", "steer-ack", "steer-end-turn", "steer-request-count", "steer-first-conversation", "steer-second-conversation", "telemetry-walk", "first-shape", "second-shape", "telemetry-kind", "steer-context-binding"]).toContain(row.step);
    }
    expect(rows).toContainEqual({ step: "first-shape", cause: "session-context", rootClass: "none", passed: true, count: 0 });
    expect(rows.some(row => row.step === "telemetry-walk" && row.cause === "identity-lock" && row.passed === true)).toBe(true);
    expect(rows).toContainEqual({ step: "first-shape", cause: "original", rootClass: "none", passed: true, count: 1 });
    expect(rows).toContainEqual({ step: "second-shape", cause: "head", rootClass: "none", passed: true, count: 2 });
    expect(rows).toContainEqual({ step: "steer-first-conversation", cause: "ok", rootClass: "none", passed: true, count: 1 });
    expect(rows).toContainEqual({ step: "steer-second-conversation", cause: "ok", rootClass: "none", passed: true, count: 3 });
    expect(text).not.toContain(root); expect(text).not.toContain("receipt original prompt");
  });
  for (const id of native) expect(result[id]).toEqual({ status: "pass", cause: "ok" });
}, 20000);
test("diagnostic exclusive-open failure never changes native assertions or overwrites a file", async () => {
  const result = await run("none", 5000, root => {
    expect(readFileSync(join(root, "jcode-proof-observations.jsonl"), "utf8")).toBe("existing private diagnostic\n");
  }, true);
  for (const id of native) expect(result[id]).toEqual({ status: "pass", cause: "ok" });
}, 20000);
test("telemetry diagnostic identifies the private root and closed artifact class", async () => {
  const result = await run("home-telemetry", 5000, root => {
    const rows = readFileSync(join(root, "jcode-proof-observations.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows.some(row => row.step === "telemetry-walk" && row.cause === "telemetry-id" && row.rootClass === "home" && row.passed === false)).toBe(true);
  });
  expect(result.telemetry).toEqual({ status: "fail", cause: "proof-failed" });
}, 20000);

test("a matched telemetry directory reports bounded child count without relaxing the leg", async () => {
  const result = await run("none", 5000, root => {
    const rows = readFileSync(join(root, "jcode-proof-observations.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows).toContainEqual({ step: "telemetry-kind", cause: "directory", rootClass: "home", passed: true, count: 0 });
    expect(rows.some(row => row.step === "telemetry-walk" && row.cause === "usage-outbox" && row.rootClass === "home" && row.passed === false)).toBe(true);
  }, false, root => mkdirSync(join(root, "home", "telemetry_usage_outbox")));
  expect(result.telemetry).toEqual({ status: "fail", cause: "proof-failed" });
}, 20000);

for (const fault of ["forged-context", "duplicate-context", "duplicate-stored-context", "context-fields", "context-extra-field", "context-changed", "context-position", "context-app-sentinel", "snapshot-symlink", "snapshot-hardlink"]) {
  test(`source-bound context rejects ${fault} without dropping an application message`, async () => {
    const result = await run(fault);
    expect(result["active-turn-soft-interrupt"]).toEqual({ status: "fail", cause: "proof-failed" });
    expect(result["serve-cleanup"]).toEqual({ status: "pass", cause: "ok" });
  }, 20000);
}
for (const fault of ["lock-nonempty", "lock-symlink", "lock-hardlink"]) {
  test(`coordination exception rejects ${fault}`, async () => {
    const result = await run(fault);
    expect(result.telemetry).toEqual({ status: "fail", cause: "proof-failed" });
  }, 20000);
}

test("an empty lock at another private location is not the source-bound coordination file", async () => {
  const result = await run("none", 5000, undefined, false, root => {
    writeFileSync(join(root, "home", "telemetry_id.lock"), "", { mode: 0o600 });
  });
  expect(result.telemetry).toEqual({ status: "fail", cause: "proof-failed" });
}, 20000);
