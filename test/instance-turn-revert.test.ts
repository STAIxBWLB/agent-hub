import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { Turns } from "../src/hub/snapshots.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const freePort = () => { const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }), port = server.port!; server.stop(true); return port; };
async function until(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt++) await Bun.sleep(10);
  expect(condition(), label).toBe(true);
}
async function fixture(extra = true) {
  const base = realPath(mkdtempSync(join(tmpdir(), "ahub-instance-revert-"))), project = join(base, "project"); mkdirSync(project);
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = hubGitSync(["-C", project, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`fixture git failed: ${result.stderr}`);
    return result.stdout;
  };
  git("init", "-q"); writeFileSync(join(project, ".gitignore"), ".agenthub/\n.worktrees/\n");
  writeFileSync(join(project, "owned.txt"), "original\n"); git("add", ".gitignore", "owned.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
  const peer = extra ? "codex-worker" : "codex", cwd = extra ? join(project, ".worktrees", peer) : project;
  if (extra) git("worktree", "add", "-b", "instance-revert", cwd, "HEAD");
  mkdirSync(join(project, ".agenthub"));
  const declarationFile = join(project, ".agenthub", "config.local.json");
  const instances = extra ? { [peer]: { kind: "codex", roles: ["reviewer"], start_mode: "headless" as const, worktree: cwd } } : {};
  writeFileSync(declarationFile, JSON.stringify({ instances }));
  const bin = join(base, "fake-codex"), record = join(base, "reverts.jsonl"), stateDir = join(project, ".agenthub", "state");
  writeFileSync(bin, `#!${process.execPath}\nprocess.argv.push("--record",${JSON.stringify(record)});\nawait import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "fakes/codex-bin.ts")).href)});\n`, { mode: 0o700 });
  const daemon = await startDaemon({ cwd: project, stateDir, controlPort: 0, codexAppPort: freePort(), codexProxyPort: freePort(), snapshotClock: () => 0, // #661: held, so a slow runner cannot spend the shared snapshot budget (#576)
    config: { ...DEFAULT_CONFIG, instances, codex_bin: bin, batch_ms: 0, snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: true },
      memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
      approvals: { ...DEFAULT_CONFIG.approvals, notify: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false } } });
  cleanup.push(() => daemon.stop());
  const console_ = await ControlClient.connect(stateDir, { role: "console", projectRoot: project }); cleanup.push(() => console_.close());
  const started = await console_.request({ t: "start", peer }); expect(started).toMatchObject({ ok: true });
  const seen: any[] = [], tui = new WebSocket(started.proxyUrl); cleanup.push(() => tui.close());
  tui.onmessage = event => seen.push(JSON.parse(String(event.data)));
  await new Promise<void>((resolve, reject) => { tui.onopen = () => resolve(); tui.onerror = () => reject(new Error("fake TUI connection failed")); });
  tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "instance-revert-fixture" } } }));
  await until(() => seen.some(message => message.id === 1), "native initialize reply");
  tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
  await until(() => seen.some(message => message.id === 2 && message.result?.thread?.id) && daemon.bus.stateOf(peer) === "idle", "native thread adopted");
  const turns = new Turns(join(stateDir, "hub.db"), true); cleanup.push(() => turns.close());
  daemon.bus.publish(newEnvelope("user", "isolated native revert probe", { to: [peer] }));
  await until(() => turns.latest(peer)?.ended != null && daemon.bus.stateOf(peer) === "idle", "real native turn completed");
  const turn = turns.latest(peer)!; expect(turn.native).toMatch(/^turn\d+$/);
  expect(turns.workspace(turn.id)).toBe(extra ? cwd : undefined);
  const reverts = () => existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const revert = () => console_.request({ t: "task", op: "turn_revert", args: { turn: turn.id } });
  return { project, cwd, stateDir, peer, daemon, declarationFile, git, turns, turn, reverts, revert };
}

test("native revert accepts an extra turn only in its recorded current execution worktree", async () => {
  const f = await fixture();
  expect(await f.revert()).toMatchObject({ ok: true });
  expect(f.reverts()).toEqual([{ threadId: "th1", beforeTurnId: f.turn.native }]);
  expect(f.daemon.bus.stateOf(f.peer)).toBe("idle");
}, 20_000);

test("native revert refuses a different recorded extra workspace before changing native history", async () => {
  const f = await fixture(), prior = join(f.project, ".worktrees", "codex-previous");
  f.git("worktree", "add", "-b", "previous-execution", prior, "HEAD");
  // Public receipt API models historical workspace evidence while retaining the actual completed native turn id.
  const writer = new Turns(join(f.stateDir, "hub.db"));
  try {
    writer.begin(f.turn.id, f.peer, f.turn.start_tree ?? undefined, prior);
    writer.native(f.turn.id, f.turn.native!); writer.end(f.turn.id, f.turn.end_tree ?? undefined, f.turn.changed, 20);
  } finally { writer.close(); }
  const refused = await f.revert();
  expect(refused.ok).toBe(false); expect(refused.error).toMatch(/workspace|worktree|declar/i);
  expect(f.reverts()).toEqual([]);
  expect(f.daemon.bus.stateOf(f.peer)).toBe("idle");
}, 20_000);

test("native revert rechecks fresh trusted declaration revocation without requiring reload", async () => {
  const f = await fixture();
  writeFileSync(f.declarationFile, JSON.stringify({ instances: {} }));
  const refused = await f.revert();
  expect(refused.ok).toBe(false); expect(refused.error).toMatch(/workspace|worktree|declar/i);
  expect(f.reverts()).toEqual([]);
  expect(f.daemon.bus.stateOf(f.peer)).toBe("idle");
}, 20_000);

test("legacy builtin native revert remains available without an extra workspace receipt", async () => {
  const f = await fixture(false);
  expect(await f.revert()).toMatchObject({ ok: true });
  expect(f.reverts()).toEqual([{ threadId: "th1", beforeTurnId: f.turn.native }]);
  expect(f.daemon.bus.stateOf(f.peer)).toBe("idle");
}, 20_000);

test("configured ACP declaration beside a Codex extra preserves native turn revert", async () => {
  const f = await fixture();
  const current = JSON.parse(readFileSync(f.declarationFile, "utf8"));
  current.adapters = { fixture: { transport: "acp", command: "fixture-only", displayName: "Fixture", roles: ["verifier"] } };
  current.instances["fixture-reader"] = { kind: "fixture", roles: ["verifier"] };
  writeFileSync(f.declarationFile, JSON.stringify(current));
  expect(await f.revert()).toMatchObject({ ok: true });
  expect(f.reverts()).toEqual([{ threadId: "th1", beforeTurnId: f.turn.native }]);
  expect(f.daemon.bus.stateOf(f.peer)).toBe("idle");
}, 20_000);
