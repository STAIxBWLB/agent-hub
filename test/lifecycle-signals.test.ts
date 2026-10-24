import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STOP_SIGNALS, awaitStopped } from "../src/hub/lifecycle.ts";
import { Registry } from "../src/hub/registry.ts";

// The project daemon stops through `daemon.stop()` on SIGINT, SIGTERM, SIGHUP and SIGQUIT, never through a signal's default action (#438). A default action ends the process with
// no `exit` event and no stop(), so a memory sync git that agent-mem 0.7.0 runs in its own process group would outlive the hub holding the memory repository. The proof is the
// observable end state of a REAL daemon process: its manifest and registry claim are gone (written only by stop()), and the process is gone.

const CLI = join(import.meta.dir, "..", "src", "cli", "main.ts");
const HUB_HOME = realpathSync(mkdtempSync(join(tmpdir(), "ahub-signals-home-")));
const roots: string[] = [];

/** The person's shell: an agent session (this test may run from one) exports markers the CLI refuses `init` and `up` under, so they are removed, as the other CLI tests do. */
function personEnv(): Record<string, string> {
  const env: Record<string, string | undefined> = { ...process.env, AGENTHUB_HOME: HUB_HOME };
  for (const key of ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "PI_SESSION_ID", "AGENTHUB_PROJECT_DIR", "AGENTHUB_STATE_DIR"]) delete env[key];
  return env as Record<string, string>;
}

async function cli(cwd: string, args: string[]) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], { cwd, env: personEnv(), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, stdout, stderr };
}

async function project(name: string): Promise<string> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `ahub-signals-${name}-`)));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  expect((await cli(root, ["init"])).code).toBe(0);
  writeFileSync(join(root, ".agenthub", "config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false } }));
  return root;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function signalled(name: NodeJS.Signals): Promise<{ pid: number; stoppedByDaemon: boolean; processGone: boolean; manifest: boolean }> {
  const root = await project(name.toLowerCase());
  expect((await cli(root, ["up"])).code).toBe(0);
  const registry = new Registry(join(HUB_HOME, "registry.db"));
  try {
    const row = registry.list().find(p => p.root === realpathSync(root));
    expect(row?.pid, "the daemon registered a pid").toBeGreaterThan(1);
    const pid = row!.pid!, instanceId = row!.instanceId!;
    process.kill(pid, name);
    // Worst case under the 20 s per-test ceiling (docs/agent-notes/tests.md): setup (init + up, about 0.4 s when healthy, bounded by the CLI itself) + this wait. A healthy stop takes
    // about 0.1 s; `awaitStopped` gives up after 10 s on its own, so a daemon that never stops fails this test in about 10 s plus the 4 s below, not at the ceiling.
    let stoppedByDaemon = true;
    try { await awaitStopped(row!, instanceId); } catch { stoppedByDaemon = false; }      // manifest and registry claim gone: only stop() writes that end state
    for (let i = 0; i < 80 && alive(pid); i++) await Bun.sleep(50);
    return { pid, stoppedByDaemon, processGone: !alive(pid), manifest: existsSync(join(root, ".agenthub", "state", "status.json")) };
  } finally { registry.close(); }
}

test("the stop list is the four signals a terminal or a supervisor ends a process with", () => {
  expect([...STOP_SIGNALS]).toEqual(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]);
});

for (const name of STOP_SIGNALS) test(`${name} to a running hub daemon stops it through stop(): state released, process gone (#438)`, async () => {
  const r = await signalled(name);
  expect(r.stoppedByDaemon, `${name}: manifest and registry claim released`).toBe(true);
  expect(r.manifest, `${name}: status.json removed by stop()`).toBe(false);
  expect(r.processGone, `${name}: process ended`).toBe(true);
}, 20_000);

afterAll(async () => {
  for (const root of roots) {
    const result = await cli(root, ["kill"]).catch(() => ({ code: 1 }));
    if (result.code !== 0) {
      const registry = new Registry(join(HUB_HOME, "registry.db"));
      const row = registry.list().find(p => p.root === root);
      if (row?.pid) { try { process.kill(row.pid, "SIGKILL"); } catch { /* gone */ } }
      registry.close();
    }
    rmSync(root, { recursive: true, force: true });
  }
  rmSync(HUB_HOME, { recursive: true, force: true });
});
