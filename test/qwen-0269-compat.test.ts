import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPAT, assessVersion } from "../src/adapters/compat.ts";

test("Qwen ACP 0.26.9 is exact receipt-verified without widening dual-output or adjacent versions", () => {
  expect(assessVersion("qwen", "0.26.9", [])).toEqual({ ok: true, state: "verified", version: "0.26.9" });
  for (const version of ["0.26.10", "0.27.1", "0.28.0"]) expect(assessVersion("qwen", version, []).ok, version).toBe(false);
  expect(COMPAT.qwen.receipt).toBe("docs/verification/2026-11-09-qwen-0270-acp.md");
  expect(COMPAT["qwen-dual"].verified).toEqual(["0.26.1"]);
  expect(Object.hasOwn(COMPAT.qwen, "line")).toBe(false);
  expect(Object.hasOwn(COMPAT["qwen-dual"], "line")).toBe(false);
  expect(assessVersion("qwen-dual", "0.26.9", []).ok).toBe(false);
  expect(assessVersion("qwen-dual", "0.26.1", [])).toEqual({ ok: true, state: "verified", version: "0.26.1" });
});

test("production Qwen native identity admits 0.26.9 and refuses unverified adjacent identities in an isolated home", async () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-qwen-0269-"));
  const home = join(root, "home"); mkdirSync(home);
  const identityModule = new URL("../src/adapters/definitions/qwen-native.ts", import.meta.url).href;
  const script = `const {qwenNativeIdentity}=await import(${JSON.stringify(identityModule)});
const identity=(version,name='qwen-code')=>{try{return qwenNativeIdentity('qwen',true,{agentInfo:{name,version}})}catch{return false}};
console.log(JSON.stringify({current:identity('0.26.9'),currentMinor:identity('0.27.0'),nextPatch:identity('0.26.10'),nextMinor:identity('0.28.0'),wrongName:identity('0.26.9','other')}));`;
  const child = Bun.spawn([process.execPath, "--eval", script], { cwd: root, env: { HOME: home, AGENTHUB_HOME: join(home, "hub"), AMEM_HOME: join(home, "amem"), XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), TMPDIR: root }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, stderr).toBe(0); expect(JSON.parse(stdout)).toEqual({ current: true, currentMinor: true, nextPatch: false, nextMinor: false, wrongName: false });
  } finally { clearTimeout(timer); await child.exited; rmSync(root, { recursive: true, force: true }); }
});

test("Qwen 0.26.9 receipt records native procedure, isolation and explicit qualification limits", () => {
  const receipt = readFileSync(join(import.meta.dir, "../docs/verification/2026-11-08-qwen-0269-acp.md"), "utf8");
  expect(receipt).toContain("0.26.9"); expect(receipt).toMatch(/[a-f0-9]{64}/);
  for (const operation of ["session/new", "session/set_mode", "proceed_once", "cancel"]) expect(receipt, operation).toContain(operation);
  expect(receipt).toMatch(/unoffered/i); expect(receipt).toMatch(/HOME/); expect(receipt).toMatch(/XDG/);
  expect(receipt).toMatch(/network/i); expect(receipt).toMatch(/unchanged/i); expect(receipt).toMatch(/post.lifecycle/i);
  expect(receipt).toMatch(/not verified|unverified/i); expect(receipt).toMatch(/real model|inference/i); expect(receipt).toMatch(/TUI/);
});
