import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realPath } from "../src/hub/project.ts";
import { Registry } from "../src/hub/registry.ts";
import { hubGitSync } from "../src/hub/git.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const CLI = join(import.meta.dir, "../src/cli/main.ts");
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
function fixture(prefix = "ahub-smoke-") {
  const cwd = realPath(mkdtempSync(join(tmpdir(), prefix))); roots.push(cwd);
  expect(hubGitSync(["-c", "init.templateDir=", "init", "-q", cwd], { encoding: "utf8" }).status).toBe(0);
  const home = join(cwd, "home"), state = join(cwd, ".agenthub/state"), bin = join(cwd, "bin");
  mkdirSync(state, { recursive: true }); mkdirSync(home); mkdirSync(bin);
  writeFileSync(join(cwd, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false } }));
  const registry = new Registry(join(home, "registry.db")); const project = registry.register(cwd, state); registry.close();
  const qwen = join(bin, "qwen");
  writeFileSync(qwen, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(import.meta.dir, "fakes/smoke-qwen.ts"))} "$@"\n`); chmodSync(qwen, 0o700);
  return { cwd, home, state, bin, project };
}
async function cli(f: ReturnType<typeof fixture>, args: string[], selector = f.cwd) {
  const env = { ...process.env };
  for (const key of ["AGENTHUB_PEER_ID", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "AGENTHUB_INSTANCE_ID", "AGENTHUB_LAUNCH_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "AMEM_HOME"]) delete env[key];
  Object.assign(env, { AGENTHUB_HOME: f.home, PATH: `${f.bin}:${process.env.PATH}`, OPENAI_API_KEY: "cli-credential-canary", OPENAI_BASE_URL: "http://127.0.0.1:1/v1", OPENAI_MODEL: "fake-model" });
  const child = Bun.spawn([process.execPath, CLI, "--project", selector, ...args], { cwd: f.cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}
test("CLI smoke validates live-test and disposable identity before a native launch", async () => {
  const f = fixture();
  const args = ["smoke", "run", "qwen-dual-output", "--project-id", f.project.id, "--receipt", "receipt.json", "--json"];
  expect((await cli(f, args)).stderr).toContain("smoke target refused");
  const wrong = [...args]; wrong[4] = "p_wrong";
  expect((await cli(f, ["--live-test", ...wrong])).stderr).toContain("smoke target refused");
  expect(readdirSync(f.cwd).some(name => name.startsWith(".smoke-run-"))).toBe(false);
  const ordinary = fixture("ordinary-project-");
  expect((await cli(ordinary, ["--live-test", "smoke", "run", "qwen-dual-output", "--project-id", ordinary.project.id, "--receipt", "receipt.json"])).stderr).toContain("smoke target refused");
});
test("CLI Q2 fake leg prints its sanitized receipt and keeps a body-free audit", async () => {
  const f = fixture();
  const result = await cli(f, ["--live-test", "smoke", "run", "qwen-dual-output", "--project-id", f.project.id, "--receipt", "receipt.json", "--timeout-ms", "5000", "--json"]);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "passed", counts: { submits: 2, stops: 2 }, checks: { cleaned: true } });
  expect(JSON.parse(result.stdout)).toEqual(JSON.parse(readFileSync(join(f.cwd, "receipt.json"), "utf8")));
  const audit = readdirSync(join(f.state, "cli-audit")).filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(join(f.state, "cli-audit", name), "utf8")));
  expect(audit.some(row => row.command === "smoke run" && row.outcome === "run")).toBe(true);
  for (const text of [result.stdout, result.stderr, JSON.stringify(audit)]) for (const value of ["cli-credential-canary", "session-private-id", "prompt-private-body", "AHUB_SMOKE_FIRST"]) expect(text).not.toContain(value);
});


test("CLI preserves symlink selector spelling for disposable refusal", async () => {
  const f = fixture(), alias = join(f.cwd, "alias");
  symlinkSync(f.cwd, alias);
  const result = await cli(f, ["--live-test", "smoke", "run", "qwen-dual-output", "--project-id", f.project.id, "--receipt", "receipt.json", "--json"], alias);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("smoke target refused");
  expect(readdirSync(f.cwd)).not.toContain("receipt.json");
});
