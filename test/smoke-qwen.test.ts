import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPath } from "../src/hub/project.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { runSmoke } from "../src/cli/smoke-run.ts";
import { validateSmokeTarget } from "../src/cli/smoke-target.ts";
import { cliCommandLabel, liveTestRefusal } from "../src/cli/identity.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const cwd = realPath(mkdtempSync(join(tmpdir(), "ahub-smoke-"))); roots.push(cwd);
  const home = join(cwd, "hub"), stateDir = join(cwd, "state"); mkdirSync(home); mkdirSync(stateDir);
  expect(hubGitSync(["init", "-q", cwd], { encoding: "utf8" }).status).toBe(0);
  const target = validateSmokeTarget({ cwd, hubHome: home, project: { id: "p_fake", root: cwd, stateDir }, expectedProjectId: "p_fake", liveTest: true });
  const ports = { command: [process.execPath, join(import.meta.dir, "fakes/smoke-qwen.ts")], env: { PATH: process.env.PATH, OPENAI_API_KEY: "credential-private-canary", OPENAI_BASE_URL: "http://127.0.0.1:1/v1", OPENAI_MODEL: "test-model" } };
  return { cwd, target, ports };
}
test("Q2 verifies two queued submits and publishes only a sanitized receipt after cleanup", async () => {
  const f = fixture();
  const receipt = await runSmoke(f.target, { leg: "qwen-dual-output", receipt: "receipt.json", timeoutMs: 5000 }, f.ports);
  expect(receipt).toMatchObject({ outcome: "passed", reason: "complete", checks: { disposable: true, protocol: true, queued: true, cleaned: true }, counts: { submits: 2, users: 2, assistants: 2, stops: 2 } });
  const raw = readFileSync(join(f.cwd, "receipt.json"), "utf8");
  expect(JSON.parse(raw)).toEqual(receipt);
  for (const value of ["credential-private-canary", "session-private-id", "prompt-private-body", "AHUB_SMOKE_FIRST", "OPENAI_API_KEY", f.cwd, "test-model"]) expect(raw).not.toContain(value);
  expect(readdirSync(f.cwd).some(name => name.startsWith(".smoke-run-"))).toBe(false);
});
test("a Q2 timeout yields a non-passing receipt and cleans private native files", async () => {
  const f = fixture(); f.ports.command.push("--scenario", "timeout");
  const receipt = await runSmoke(f.target, { leg: "qwen-dual-output", receipt: "receipt.json", timeoutMs: 400 }, f.ports);
  expect(receipt.outcome).not.toBe("passed"); expect(receipt.checks.cleaned).toBe(true);
  expect(readdirSync(f.cwd).some(name => name.startsWith(".smoke-run-"))).toBe(false);
});
test("Q2 never answers a model tool approval and refuses unsafe receipt or missing account configuration before spawn", async () => {
  const f = fixture();
  await expect(runSmoke(f.target, { leg: "qwen-dual-output", receipt: "../outside.json", timeoutMs: 5000 }, f.ports)).rejects.toThrow("smoke receipt refused");
  await expect(runSmoke(f.target, { leg: "qwen-dual-output", receipt: "receipt.json", timeoutMs: 5000 }, { ...f.ports, env: {} })).rejects.toThrow("smoke prerequisites unavailable");
  expect(existsSync(join(f.cwd, "receipt.json"))).toBe(false);
  f.ports.command.push("--scenario", "approval");
  const receipt = await runSmoke(f.target, { leg: "qwen-dual-output", receipt: "receipt.json", timeoutMs: 5000 }, f.ports);
  expect(receipt.outcome).toBe("failed"); expect(receipt.checks.cleaned).toBe(true);
});
test("smoke audit labels never include arguments and live-test may delegate only the disposable runner", () => {
  expect(cliCommandLabel("smoke", ["run", "private-prompt"])).toBe("smoke run");
  expect(liveTestRefusal("smoke", ["run", "qwen-dual-output"])).toBe(false);
});
