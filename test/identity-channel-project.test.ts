import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { channelProject } from "../src/hub/channel-project.ts";
import { realPath } from "../src/hub/project.ts";

// #604 PR B item 10 and AC8, with two real temporary roots: the main checkout (which runs a hub) and a linked worktree started from it. Roots resolved with realPath.
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const git = (cwd: string, ...args: string[]) => { const r = spawnSync("git", args, { cwd, encoding: "utf8" }); expect(r.status, r.stderr).toBe(0); };

function repos() {
  const main = realPath(mkdtempSync(join(tmpdir(), "ahub-identity-main-")));
  cleanup.push(() => rmSync(main, { recursive: true, force: true }));
  git(main, "init", "-q"); git(main, "config", "user.email", "a@b.c"); git(main, "config", "user.name", "x");
  mkdirSync(join(main, ".agenthub", "state"), { recursive: true }); writeFileSync(join(main, ".agenthub", "config.json"), "{}");
  const stateDir = join(main, ".agenthub", "state");
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ cwd: main })); // the daemon's own marker: it records the root it serves
  git(main, "add", "-A"); git(main, "commit", "-qm", "init"); mkdirSync(join(main, ".worktrees"));
  git(main, "worktree", "add", "-q", join(main, ".worktrees", "other"), "-b", "other");
  const worktree = realPath(join(main, ".worktrees", "other"));
  return { main, worktree, stateDir };
}
const roles = () => ({});

test("the main checkout keeps its own inherited state dir; a linked worktree with the same inherited pair does not take it", () => {
  const r = repos(), inherited = { AGENTHUB_STATE_DIR: r.stateDir, AGENTHUB_PROJECT_DIR: r.main, AGENTHUB_PEER_ID: "claude" } as NodeJS.ProcessEnv;
  expect(channelProject(r.main, inherited, roles)).toMatchObject({ root: r.main, stateDir: r.stateDir, inherited: true });
  const fromWorktree = channelProject(r.worktree, inherited, roles);
  expect(fromWorktree?.root).toBe(r.worktree);                                       // its own project, not the main repository
  expect(fromWorktree?.stateDir).not.toBe(r.stateDir);
  expect(fromWorktree).toMatchObject({ inherited: false, stateDir: join(r.worktree, ".agenthub", "state") });
});

test("a cwd with no project of its own and a state dir that records another root is refused or confined, never joined", () => {
  const r = repos(), elsewhere = realPath(mkdtempSync(join(tmpdir(), "ahub-identity-elsewhere-")));
  cleanup.push(() => rmSync(elsewhere, { recursive: true, force: true }));
  const inherited = { AGENTHUB_STATE_DIR: r.stateDir, AGENTHUB_PROJECT_DIR: r.main } as NodeJS.ProcessEnv;
  const project = channelProject(elsewhere, inherited, roles);
  expect(project?.stateDir).not.toBe(r.stateDir);
  expect(project?.inherited).toBe(false);
});

test("a fresh state dir that records no root is taken only when the declared project dir names this process's own root", () => {
  const r = repos(); rmSync(join(r.stateDir, "status.json"));
  expect(channelProject(r.main, { AGENTHUB_STATE_DIR: r.stateDir, AGENTHUB_PROJECT_DIR: r.main } as NodeJS.ProcessEnv, roles)?.inherited).toBe(true);
  expect(channelProject(r.main, { AGENTHUB_STATE_DIR: r.stateDir, AGENTHUB_PROJECT_DIR: r.worktree } as NodeJS.ProcessEnv, roles)?.inherited).toBe(false);
  expect(channelProject(r.worktree, { AGENTHUB_STATE_DIR: r.stateDir, AGENTHUB_PROJECT_DIR: r.main } as NodeJS.ProcessEnv, roles)?.inherited).toBe(false);
});

// The real plugin process, started in the linked worktree with the main checkout's inherited variables and a hub listening for the main checkout: it must not reach that hub.
test("AC8: the real channel plugin started in a linked worktree with the main checkout's variables does not attach to the main hub", async () => {
  const r = repos(), hellos: any[] = [];
  const hub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, server) { return server.upgrade(req) ? undefined : new Response("ws only", { status: 400 }); },
    websocket: { message(ws, raw) { const message = JSON.parse(String(raw)); if (message.t === "hello") { hellos.push(message); ws.send(JSON.stringify({ t: "welcome", rid: message.rid, ok: true, projectId: "main", instanceId: "main-instance", cwd: r.main })); } else ws.send(JSON.stringify({ rid: message.rid, ok: true })); } } });
  cleanup.push(() => hub.stop(true));
  writeFileSync(join(r.stateDir, "status.json"), JSON.stringify({ protocol: PROTOCOL, controlPort: hub.port, projectId: "main", instanceId: "main-instance", cwd: r.main }));
  writeFileSync(join(r.stateDir, "control-token"), "fixture-token");
  const run = async (cwd: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: r.main, AGENTHUB_HOME: join(r.main, "hub-home"), AMEM_HOME: join(r.main, "memory-home"), CLAUDE_CONFIG_DIR: join(r.main, "claude-home"),
      AGENTHUB_STATE_DIR: r.stateDir, AGENTHUB_PROJECT_DIR: r.main, AGENTHUB_PEER_ID: "claude", AGENTHUB_INSTANCE_ID: "main-instance" };
    delete env.AGENTHUB_CHANNEL; delete env.AGENTHUB_MODE; delete env.AGENTHUB_LAUNCH_ID;
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/adapters/claude-channel.ts")], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    let diagnostics = ""; const err = (async () => { for await (const data of child.stderr) diagnostics += Buffer.from(data).toString(); })();
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    for (let n = 0; n < 300 && !diagnostics.includes("connected to hub") && !diagnostics.includes("no hub running"); n++) await Bun.sleep(10);
    child.stdin.end(); const timer = setTimeout(() => child.kill("SIGKILL"), 1500); await child.exited; clearTimeout(timer); await err;
    return diagnostics;
  };
  const fromMain = await run(r.main);
  expect(fromMain).toContain("connected to hub"); expect(hellos).toHaveLength(1);       // control: the same fixture does reach the hub from the main checkout
  const fromWorktree = await run(r.worktree);
  expect(hellos).toHaveLength(1);                                                       // the worktree's plugin sent no hello to the main hub
  expect(fromWorktree).toContain("ignoring an inherited AGENTHUB_STATE_DIR");
  expect(fromWorktree).not.toContain("connected to hub");
}, 30_000);
