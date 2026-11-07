import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
async function run(fault = "none", legMs = 5000): Promise<ProofResults> {
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
  const answer = await runBoundedReceiptCommand([process.execPath, fake, "--proof-worker", file, producer, runner], {
    cwd, env, signal: AbortSignal.timeout(15000), timeoutMs: 15000, maxBytes: 1024 * 1024,
  });
  expect(answer.exitCode).toBe(0); expect(answer.ownedStopConfirmed).toBe(true);
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
