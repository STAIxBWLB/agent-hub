import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, lstatSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { MCP_OBSERVER } from "../scripts/compat-receipts/proofs/jcode.ts";
import { stopOwnedProcess, trackGroup } from "../src/hub/child-process.ts";
import type { Readable, Writable } from "node:stream";
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

test("a third completion attempt fails even when only two request bodies are retained", async () => {
  const result = await run("extra-completion", 5000, root => {
    const rows = readFileSync(join(root, "jcode-proof-observations.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows).toContainEqual({ step: "steer-request-count", cause: "assertion", rootClass: "none", passed: false, count: 3 });
  });
  expect(result["active-turn-soft-interrupt"]).toEqual({ status: "fail", cause: "proof-failed" });
  expect(result["serve-cleanup"]).toEqual({ status: "pass", cause: "ok" });
}, 20000);

/** Runs the actual observer program with only its filesystem import bound to a pipe-gated real I/O port. */
async function observerPublication(program: string, fault: "none" | "write" | "existing" = "none") {
  const root = realPath(mkdtempSync(join(tmpdir(), "jcode-observer-publication-"))); roots.push(root);
  const target = join(root, "observed.json"), temp = target + ".tmp", port = join(root, "fs-port.mjs"), script = join(root, "observer.mjs");
  const existing = "preexisting private temporary file";
  if (fault === "existing") writeFileSync(temp, existing, { mode: 0o600, flag: "wx" });
  writeFileSync(port, `import * as fs from 'node:fs';
export const {openSync,closeSync,renameSync,unlinkSync}=fs;
export function writeFileSync(file,data,options){
  const own=typeof file!=='number',fd=own?fs.openSync(file,options?.flag??'w',options?.mode):file;
  const wait=()=>{const token=Buffer.alloc(1);if(fs.readSync(4,token,0,1,null)!==1)throw Error('gate closed')};
  try{wait();fs.writeSync(3,'opened\\n');wait();
    if(${JSON.stringify(fault)}==='write')throw Error('injected write failure');fs.writeFileSync(fd,data);
  }finally{if(own)fs.closeSync(fd)}
}`, { mode: 0o600, flag: "wx" });
  // Import substitution supplies the real fs operations and one controlled write barrier;
  // the observer's publication, ownership, cleanup and MCP code remain byte-identical.
  expect(program.split("from'node:fs'")).toHaveLength(2);
  writeFileSync(script, program.replace("from'node:fs'", `from${JSON.stringify(port)}`), { mode: 0o600, flag: "wx" });
  const child = spawn(process.execPath, [script, target], { cwd: root, detached: true, signal: AbortSignal.timeout(15000),
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, AGENTHUB_PEER_ID: "fixture-peer", AGENTHUB_LAUNCH_ID: "fixture-launch" },
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] });
  const ended = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject); child.once("exit", resolve);
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
  });
  trackGroup(child); child.stderr!.resume();
  const markers = createInterface({ input: child.stdio[3] as Readable }), replies = createInterface({ input: child.stdout! });
  try {
    if (fault === "existing") {
      expect(await ended).toBe(1);
      expect(readFileSync(temp, "utf8")).toBe(existing);
      expect(() => lstatSync(target)).toThrow();
      return;
    }
    const opened = new Promise<string>(resolve => markers.once("line", resolve));
    (child.stdio[4] as Writable).write("1");
    expect(await Promise.race([opened, ended.then(() => { throw new Error("observer exited before the write barrier"); })])).toBe("opened");
    const published = (() => { try { return lstatSync(target); } catch { return undefined; } })();
    if (program === OLD_MCP_OBSERVER) {
      expect(published?.size).toBe(0);
      expect(() => JSON.parse(readFileSync(target, "utf8"))).toThrow();
    } else {
      expect(published).toBeUndefined();
      expect(lstatSync(temp).mode & 0o777).toBe(0o600);
    }
    (child.stdio[4] as Writable).end("1");
    if (fault === "write") {
      expect(await ended).toBe(1);
      expect(() => lstatSync(temp)).toThrow(); expect(() => lstatSync(target)).toThrow();
      return;
    }
    const response = new Promise<string>(resolve => replies.once("line", resolve));
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }) + "\n");
    const line = await Promise.race([response, ended.then(() => { throw new Error("observer exited before its MCP reply"); })]);
    expect(JSON.parse(line)).toEqual({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "receipt-observer", version: "1" } } });
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ peer: "fixture-peer", launch: "fixture-launch" });
    expect(lstatSync(target).mode & 0o777).toBe(0o600);
    child.stdin!.end(); expect(await ended).toBe(0);
  } finally {
    markers.close(); replies.close();
    await stopOwnedProcess(child, { group: true });
  }
}

test("the old observer exposes an incomplete final JSON file at a consumed write barrier", async () => {
  await observerPublication(OLD_MCP_OBSERVER);
}, 20000);
test("the observer publishes complete environment JSON atomically before its MCP reply", async () => {
  await observerPublication(MCP_OBSERVER);
}, 20000);
test("observer write failure removes only its own temporary file and publishes nothing", async () => {
  await observerPublication(MCP_OBSERVER, "write");
}, 20000);
test("observer exclusive temporary-open refusal preserves a preexisting file", async () => {
  await observerPublication(MCP_OBSERVER, "existing");
}, 20000);

// Exact observer program from 0ef961fa40269c4204a0dfcd7b0b16472a6d268f, before atomic publication.
const OLD_MCP_OBSERVER = "import{writeFileSync}from'node:fs';import{createInterface}from'node:readline';\nwriteFileSync(process.argv[2],JSON.stringify({peer:process.env.AGENTHUB_PEER_ID,launch:process.env.AGENTHUB_LAUNCH_ID}),{mode:0o600});\ncreateInterface({input:process.stdin}).on('line',line=>{let m;try{m=JSON.parse(line)}catch{return}if(m.id===undefined)return;\nconst result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'receipt-observer',version:'1'}}:m.method==='tools/list'?{tools:[]}:{};\nprocess.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});process.stdin.on('end',()=>process.exit(0));";
