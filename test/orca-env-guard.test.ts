import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORCA_LAUNCHER_ENV, isOrcaEnvName, withoutOrcaEnv } from "../src/hub/orca-env.ts";
import { realPath } from "../src/hub/project.ts";

// #613 (agent-hub#1048): a run started from an Orca pane inherits ORCA_*, which the ahub launcher and the hub's terminal opener read to open
// real tabs and agents in the person's running Orca. Nothing here can reach a real Orca: ORCA_CLI_COMMAND is always a stub script that records
// its calls, and every ORCA_ value is fake.
const ROOT = realPath(join(import.meta.dir, ".."));
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

test("the test preload removes every ORCA_ variable the parent carried, from the process and from the children it spawns", async () => {
  const code = `console.log(JSON.stringify(Object.keys(process.env).filter(name => name.startsWith("ORCA_"))))`;
  const run = async (preload: boolean) => {
    const proc = Bun.spawn([process.execPath, ...(preload ? ["--preload", PRELOAD] : []), "-e", code], { env: { ...process.env, ...FAKE, ORCA_CLI_COMMAND: "/nonexistent/orca-stub" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 8_000);
    try { const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]); return JSON.parse(out) as string[]; } finally { clearTimeout(timer); }
  };
  expect((await run(false)).sort()).toEqual(["ORCA_CLI_COMMAND", ...Object.keys(FAKE)].sort());   // the hazard is real without the preload
  expect(await run(true)).toEqual([]);                                                            // and gone with it
}, 20_000);

/** One bounded child: killed at `ms`, never a blocking spawn, so a test timeout cannot fire inside it (docs/agent-notes/tests.md). */
async function child(argv: string[], options: { cwd?: string; env: Record<string, string>; ms: number }) {
  const proc = Bun.spawn(argv, { ...(options.cwd ? { cwd: options.cwd } : {}), env: options.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), options.ms);
  try {
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    void new Response(proc.stdout).text();                                                  // drained so a full pipe never blocks the child
    return { code, stderr };
  } finally { clearTimeout(timer); }
}

/** A real `ahub init` and `ahub up` of a temp project, whose hub starts its default agents through the hub's terminal opener. `scrubbed` runs both under the test preload. Every step is bounded, 13 s in all. */
async function orcaCallsOfUp(scrubbed: boolean): Promise<string[]> {
  const base = realPath(mkdtempSync(join(tmpdir(), "ahub-orca-guard-"))), root = join(base, "p"), home = join(base, "home"), calls = join(base, "orca-calls.log"), stub = join(base, "orca-stub");
  mkdirSync(root); mkdirSync(home);
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 1\n`); chmodSync(stub, 0o755);
  Bun.spawnSync(["git", "-C", root, "init", "-q"], { timeout: 5_000 });                  // a local init that takes milliseconds, bounded all the same
  const person: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !/^(AGENTHUB_|CLAUDE|CODEX|ORCA_|KIMI|QWEN|JCODE|PI_|OMNIROUTE)/.test(key)) person[key] = value;
  const env = { ...person, AGENTHUB_HOME: home, ...FAKE, ORCA_CLI_COMMAND: stub };
  const run = (ms: number, ...args: string[]) => child([process.execPath, ...(scrubbed ? ["--preload", PRELOAD] : []), MAIN, ...args], { cwd: root, env, ms });
  cleanup.push(async () => { await run(5_000, "kill"); rmSync(base, { recursive: true, force: true }); });
  const init = await run(5_000, "init");
  expect(init.code, init.stderr).toBe(0);
  const up = await run(8_000, "up", "--no-console");
  expect(up.code, up.stderr).toBe(0);
  return existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : [];
}

test("AC2: without the preload a real ahub up reaches the stub Orca CLI with the parent's ORCA_ values, so the guard below can fail", async () => {
  const exposed = await orcaCallsOfUp(false);
  expect(exposed.length, "the unscrubbed run must reach the stub, or the guard proves nothing").toBeGreaterThan(0);
  expect(exposed[0]).toContain("terminal create --worktree id:wt-fake613");
}, 20_000);

test("AC1/AC2: under the preload a real ahub up never calls the Orca CLI with the parent's ORCA_ values", async () => {
  expect(await orcaCallsOfUp(true)).toEqual([]);
}, 20_000);
