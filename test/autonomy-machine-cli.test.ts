import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-machine-cli-")); roots.push(root);
  const user = join(root, "user"), home = join(root, "hub"), profile = join(user, "selected-claude"); mkdirSync(user);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || key.startsWith("CODEX_") || key === "CLAUDECODE" || key === "CLAUDE_CODE_SESSION_ID" || key.startsWith("ORCA_") || key === "CI") delete env[key];
  Object.assign(env, { HOME: user, AGENTHUB_HOME: home, CLAUDE_CONFIG_DIR: profile, AMEM_HOME: join(root, "memory"), GIT_CONFIG_GLOBAL: "/dev/null" });
  const repo = (name: string) => { const cwd = join(root, name); mkdirSync(cwd); expect(hubGitSync(["init", "-q"], { cwd, env, encoding: "utf8", timeout: 1000 }).status).toBe(0); return cwd; };
  const run = (cwd: string, args: string[], overrides: NodeJS.ProcessEnv = {}) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...args], { cwd, env: { ...env, ...overrides }, stdout: "pipe", stderr: "pipe", timeout: 15000 });
  return { root, home, profile, repo, run, file: (cwd: string) => join(cwd, ".agenthub/config.local.json") };
}
test("person CLI enables a stopped project, reports missing homes offline, and init inherits without issuing consent", () => {
  const p = fixture(), first = p.repo("first");
  const initialized = p.run(first, ["init"]); expect(initialized.exitCode, initialized.stderr.toString()).toBe(0);
  expect(existsSync(p.file(first))).toBe(false);
  const enabled = p.run(first, ["autonomy", "on", "--yes"]); expect(enabled.exitCode, enabled.stderr.toString()).toBe(0);
  expect(JSON.parse(readFileSync(p.file(first), "utf8")).permission_modes.codex).toBe("never-ask");
  const status = p.run(first, ["autonomy", "status", "--json"]); expect(status.exitCode, status.stderr.toString()).toBe(0);
  const view = JSON.parse(status.stdout.toString());
  expect(view).toMatchObject({ runtime: "stopped", consentState: "unknown", machineDefault: { enabled: true } });
  expect(view.claudeHomes[0]).toMatchObject({ home: { path: p.profile }, plugin: { state: "missing" }, hook: { state: "missing" } });
  expect(existsSync(p.profile)).toBe(false);
  const second = p.repo("second"), inherited = p.run(second, ["init"]);
  expect(inherited.exitCode, inherited.stderr.toString()).toBe(0); expect(inherited.stdout.toString()).toContain("Inherited the trusted machine autonomy default");
  expect(JSON.parse(readFileSync(p.file(second), "utf8")).permission_modes.codex).toBe("never-ask");
  expect(existsSync(join(p.home, "autonomy"))).toBe(false);
  const local = JSON.parse(readFileSync(p.file(first), "utf8")); local.permission_modes.codex = "ask-when-needed"; writeFileSync(p.file(first), JSON.stringify(local));
  const off = p.run(first, ["autonomy", "off"]); expect(off.exitCode, off.stderr.toString()).toBe(0);
  expect(JSON.parse(readFileSync(p.file(first), "utf8")).permission_modes?.codex).toBeUndefined();
  expect(JSON.parse(readFileSync(join(p.home, "defaults.json"), "utf8")).autonomy).toBe(false);
}, 20000);
test("agent and delegated live-test CLI cannot write the machine opt-in", () => {
  const p = fixture(), cwd = p.repo("refused"); expect(p.run(cwd, ["init"]).exitCode).toBe(0);
  for (const args of [["autonomy", "on", "--all-projects", "--yes"], ["--live-test", "autonomy", "on", "--yes"]]) {
    const refused = p.run(cwd, args, { AGENTHUB_PEER_ID: "codex" });
    expect(refused.exitCode).not.toBe(0); expect(existsSync(join(p.home, "defaults.json"))).toBe(false); expect(existsSync(p.file(cwd))).toBe(false);
  }
}, 20000);
