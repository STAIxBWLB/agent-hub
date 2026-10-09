import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";

test("installed-layout detached restart completes in an isolated project and preserves its task board", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ahub-recovery-cli-"));
  mkdirSync(join(temp, "project"));
  const root = realpathSync(join(temp, "project")), home = join(temp, "home");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || key.startsWith("ORCA_")) delete env[key];
  env.AGENTHUB_HOME = home;
  const main = join(import.meta.dir, "../src/cli/main.js");
  const cli = async (args: string[], extra: Record<string, string> = {}) => {
    const p = Bun.spawn([process.execPath, main, "--project", root, ...args], { cwd: root, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code, out, err };
  };
  let operation: string | undefined;
  // Every daemon generation this test starts (up, restart, recovery) is recorded, so a
  // failed `kill` can never leave a detached hub spinning behind the suite (issue #56).
  const pids = new Set<number>();
  const status = async () => {
    const client = await ControlClient.connect(join(root, ".agenthub/state"), { role: "console", projectRoot: root });
    try {
      const reply = (await client.request({ t: "status" })).status;
      if (typeof reply?.pid === "number") pids.add(reply.pid);
      return reply;
    }
    finally { client.close(); }
  };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const waitDead = async (pid: number, ms: number) => {
    const deadline = Date.now() + ms;
    while (alive(pid) && Date.now() < deadline) await Bun.sleep(50);
    return !alive(pid);
  };
  try {
    expect((await cli(["init"])).code).toBe(0);
    writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false }, omniroute: { urls: [] } }));
    expect((await cli(["up"])).code).toBe(0);
    expect((await cli(["task", "propose", "--class", "implement", "Keep this task through restart"])).code).toBe(0);
    const before = await status();
    const plan = await cli(["restart", "--dry-run"]);
    expect(plan.code).toBe(0);
    expect(JSON.parse(plan.out).projects[0].blockers).toEqual([]);
    const applied = await cli(["restart", "--yes"]);
    expect(applied.code).toBe(0);
    operation = /Recovery operation ([a-f0-9-]{36}) scheduled/.exec(applied.out)?.[1];
    expect(operation).toBeDefined();
    let receipt: any;
    for (let n = 0; n < 200; n++) {
      receipt = JSON.parse(readFileSync(join(home, "recovery", `${operation}.json`), "utf8"));
      if (["completed", "blocked"].includes(receipt.phase)) break;
      await Bun.sleep(50);
    }
    expect({ phase: receipt.phase, step: receipt.step, error: receipt.error }).toEqual({ phase: "completed", step: "completed", error: undefined });
    const after = await status();
    expect(after.instanceId).not.toBe(before.instanceId);
    expect(after.projectId).toBe(before.projectId);
    expect(after.tasks).toEqual(before.tasks);
    expect((await cli(["board"])).out).toContain("Keep this task through restart");
    expect((await cli(["task", "propose", "--class", "implement", "Normal writes after recovery"])).code).toBe(0);
    const second = await cli(["restart", "--dry-run"]);
    expect(JSON.parse(second.out).projects[0].blockers).toEqual([]);
    // An agent restored by this operation may later invoke CLI commands with the old
    // operation environment still inherited. A regular stop/up must not replay it.
    expect((await cli(["kill"], { AGENTHUB_RECOVERY_OPERATION: operation! })).code).toBe(0);
    expect((await cli(["up"], { AGENTHUB_RECOVERY_OPERATION: operation! })).code).toBe(0);
    expect((await status()).recovery).toBeUndefined();
    expect((await cli(["board"])).out).toContain("Keep this task through restart");
    expect(pids.size).toBeGreaterThan(0); // the harness recorded at least one daemon generation
  } finally {
    try { await cli(["kill"], operation ? { AGENTHUB_RECOVERY_OPERATION: operation } : {}); } catch { /* best effort; the pid sweep below is the guarantee */ }
    // The recovery flow also runs a detached dashboard manager out of the staged source.
    try {
      const manifest = JSON.parse(readFileSync(join(home, "manager", "status.json"), "utf8"));
      if (typeof manifest?.pid === "number") pids.add(manifest.pid);
    } catch { /* no manager this run */ }
    for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
    for (const pid of pids) if (!(await waitDead(pid, 5_000))) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    const stuck = [];
    for (const pid of pids) if (!(await waitDead(pid, 2_000))) stuck.push(pid);
    rmSync(temp, { recursive: true, force: true }); // unconditional: the watchdog removes the state a straggler still holds
    if (stuck.length) throw new Error(`hub daemon(s) survived SIGTERM and SIGKILL: ${stuck.join(", ")}`);
  }
}, 30_000);

// #206 AC3: a refused --yes names each blocker on stderr, not only its last line.
test("a refused restart lists every blocker before its final line", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ahub-refused-cli-"));
  mkdirSync(join(temp, "project"));
  const root = realpathSync(join(temp, "project"));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || key.startsWith("ORCA_") || ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"].includes(key)) delete env[key];
  env.AGENTHUB_HOME = join(temp, "home");
  const cli = async (args: string[]) => {
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.js"), "--project", root, ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const [code, , err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code, err: err.trim().split("\n") };
  };
  try {
    expect(await cli(["restart", "--dry-run"])).toEqual({ code: 0, err: ["ahub: blocker: no running registered projects in scope"] });
    expect(await cli(["restart", "--yes"])).toEqual({ code: 1, err: ["ahub: blocker: no running registered projects in scope", "ahub: plan has blockers; no runtime was changed"] });
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

// #215 AC4: the disposition is a person's decision; an agent shell is refused before any receipt is read.
test("an agent shell cannot dispose of a recovery operation", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ahub-dispose-cli-"));
  mkdirSync(join(temp, "project"));
  const root = realpathSync(join(temp, "project"));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || key.startsWith("ORCA_") || ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"].includes(key)) delete env[key];
  Object.assign(env, { AGENTHUB_HOME: join(temp, "home"), CLAUDECODE: "1" });
  try {
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.js"), "--project", root, "recovery", "dispose", "00000000-0000-4000-8000-000000000000", "--stop-and-archive", "--reason", "test"],
      { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const [code, , err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect({ code, err: err.trim() }).toEqual({ code: 1, err: "ahub: claude cannot run ahub recovery dispose; the person runs it in ahub console or a terminal" });
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
