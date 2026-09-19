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
  const status = async () => {
    const client = await ControlClient.connect(join(root, ".agenthub/state"), { role: "console", projectRoot: root });
    try { return (await client.request({ t: "status" })).status; }
    finally { client.close(); }
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
    expect({ phase: receipt.phase, error: receipt.error }).toEqual({ phase: "completed", error: undefined });
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
  } finally {
    const stop = await cli(["kill"], operation ? { AGENTHUB_RECOVERY_OPERATION: operation } : {});
    if (stop.code === 0) rmSync(temp, { recursive: true, force: true });
  }
}, 30_000);
