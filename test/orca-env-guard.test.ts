import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORCA_LAUNCHER_ENV, isOrcaEnvName, withoutOrcaEnv } from "../src/hub/orca-env.ts";

// #613 (agent-hub#1048): a run started from an Orca pane inherits ORCA_*, which the ahub launcher and the hub's terminal opener read to open
// real tabs and agents in the person's running Orca. Nothing here can reach a real Orca: ORCA_CLI_COMMAND is always a stub script that records
// its calls, and every ORCA_ value is fake.
const ROOT = realpathSync(join(import.meta.dir, ".."));
const MAIN = join(ROOT, "src/cli/main.ts"), PRELOAD = join(ROOT, "test/hub-home.ts");
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

const FAKE = { ORCA_WORKTREE_ID: "wt-fake613", ORCA_TERMINAL_HANDLE: "term-fake613", ORCA_DEV_REPO_ROOT: "/nonexistent/orca-dev", ORCA_TAB_ID: "tab-fake613", ORCA_PANE_KEY: "pane-fake613" };

test("the launcher's Orca names are one list: every ORCA_ name any source file reads is in it", () => {
  const read = new Set<string>();
  const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.(ts|js|mjs)$/.test(entry.name) && !path.endsWith("src/hub/orca-env.ts")) for (const match of readFileSync(path, "utf8").matchAll(/\b(?:process\.env|env)\.(ORCA_[A-Z_]+)\b/g)) read.add(match[1]!);
  } };
  walk(join(ROOT, "src"));
  // a name the launcher reads from the environment must be scrubbed by the one list, never by a copy of it
  for (const name of read) expect(ORCA_LAUNCHER_ENV, `${name} is read by the launcher but is not in ORCA_LAUNCHER_ENV`).toContain(name);
  expect([...ORCA_LAUNCHER_ENV].sort()).toEqual(["ORCA_CLI_COMMAND", "ORCA_DEV_REPO_ROOT", "ORCA_TERMINAL_HANDLE", "ORCA_WORKTREE_ID"]);
  for (const name of ORCA_LAUNCHER_ENV) expect(isOrcaEnvName(name)).toBe(true);
});

test("withoutOrcaEnv removes the whole ORCA_ prefix and nothing else, and does not change its input", () => {
  const input = { PATH: "/bin", ORCA_CLI_COMMAND: "orca", ORCA_TAB_ID: "t", ORCAFOO: "kept", XORCA_Y: "kept", AGENTHUB_HOME: "/h" };
  expect(withoutOrcaEnv(input)).toEqual({ PATH: "/bin", ORCAFOO: "kept", XORCA_Y: "kept", AGENTHUB_HOME: "/h" });
  expect(input.ORCA_CLI_COMMAND).toBe("orca");
});

test("the test preload removes every ORCA_ variable the parent carried, from the process and from the children it spawns", () => {
  const code = `console.log(JSON.stringify(Object.keys(process.env).filter(name => name.startsWith("ORCA_"))))`;
  const run = (preload: boolean) => {
    const child = Bun.spawnSync([process.execPath, ...(preload ? ["--preload", PRELOAD] : []), "-e", code], { env: { ...process.env, ...FAKE, ORCA_CLI_COMMAND: "/nonexistent/orca-stub" }, stdout: "pipe", stderr: "pipe" });
    return JSON.parse(child.stdout.toString()) as string[];
  };
  expect(run(false).sort()).toEqual(["ORCA_CLI_COMMAND", ...Object.keys(FAKE)].sort());           // the hazard is real without the preload
  expect(run(true)).toEqual([]);                                                                  // and gone with it
});

/** A real `ahub up` of a temp project, whose hub starts its default agents through the hub's terminal opener. `scrubbed` runs it under the test preload. */
async function orcaCallsOfUp(scrubbed: boolean): Promise<string[]> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ahub-orca-guard-"))), root = join(base, "p"), home = join(base, "home"), calls = join(base, "orca-calls.log"), stub = join(base, "orca-stub");
  mkdirSync(root); mkdirSync(home);
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 1\n`); chmodSync(stub, 0o755);
  Bun.spawnSync(["git", "-C", root, "init", "-q"]);
  const person: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !/^(AGENTHUB_|CLAUDE|CODEX|ORCA_|KIMI|QWEN|JCODE|PI_|OMNIROUTE)/.test(key)) person[key] = value;
  const env = { ...person, AGENTHUB_HOME: home, ...FAKE, ORCA_CLI_COMMAND: stub };
  const run = (...args: string[]) => {
    const script = `const p = Bun.spawnSync([process.execPath, ${JSON.stringify(MAIN)}, ...${JSON.stringify(args)}], { cwd: ${JSON.stringify(root)}, env: process.env, stdout: "pipe", stderr: "pipe", timeout: 60000 }); process.exit(p.exitCode ?? 1);`;
    return Bun.spawnSync([process.execPath, ...(scrubbed ? ["--preload", PRELOAD] : []), "-e", script], { env: { ...env, ...(scrubbed ? { AGENTHUB_HOME: home } : {}) }, stdout: "pipe", stderr: "pipe" });
  };
  cleanup.push(() => { run("kill"); rmSync(base, { recursive: true, force: true }); });
  expect(run("init").exitCode).toBe(0);
  const up = run("up", "--no-console");
  expect(up.exitCode, up.stderr.toString()).toBe(0);
  return existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : [];
}

test("AC1/AC2: a real ahub up under the preload never calls the Orca CLI with the parent's ORCA_ values; the same run without it does, so this guard can fail", async () => {
  const exposed = await orcaCallsOfUp(false);
  expect(exposed.length, "the unscrubbed run must reach the stub, or this guard proves nothing").toBeGreaterThan(0);
  expect(exposed[0]).toContain("terminal create --worktree id:wt-fake613");
  expect(await orcaCallsOfUp(true)).toEqual([]);
}, 180_000);
