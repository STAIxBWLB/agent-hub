import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { ControlClient } from "../src/hub/control-client.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { Turns } from "../src/hub/snapshots.ts";

const freePort = () => { const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }), port = server.port!; server.stop(true); return port; };
async function until(condition: () => boolean, name: string): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt++) await Bun.sleep(10);
  expect(condition(), name).toBe(true);
}

test("instance native cwd and completed turn snapshots follow its validated worktree", async () => {
  const base = realPath(mkdtempSync(join(tmpdir(), "ahub-instance-tree-"))), project = join(base, "project"); mkdirSync(project);
  const git = (...args: string[]) => {
    const result = hubGitSync(["-C", project, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`fixture git failed: ${result.stderr}`);
    return result.stdout;
  };
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined, console_: ControlClient | undefined, tui: WebSocket | undefined, turns: Turns | undefined;
  let untap: (() => void) | undefined;
  try {
    git("init", "-q");
    writeFileSync(join(project, ".gitignore"), ".agenthub/\n.worktrees/\n");
    writeFileSync(join(project, "owned.txt"), "canonical old\n");
    git("add", ".gitignore", "owned.txt"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    const instance = "codex-worker", worktree = join(project, ".worktrees", instance);
    git("worktree", "add", "-b", "instance-worker", worktree, "HEAD");
    writeFileSync(join(worktree, "owned.txt"), "worktree old\n");
    const stateDir = join(project, ".agenthub", "state"), record = join(base, "spawn.json"), bin = join(base, "fake-codex");
    writeFileSync(bin, `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(record)},JSON.stringify({cwd:process.cwd(),peer:process.env.AGENTHUB_PEER_ID}));\nawait import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "fakes/codex-bin.ts")).href)});\n`, { mode: 0o700 });
    daemon = await startDaemon({ cwd: project, stateDir, controlPort: 0, codexAppPort: freePort(), codexProxyPort: freePort(), snapshotClock: () => 0, // #661: held, so a slow runner cannot spend the shared snapshot budget (#576)
      config: { ...DEFAULT_CONFIG, instances: { [instance]: { kind: "codex", roles: ["reviewer"], start_mode: "headless", worktree } }, codex_bin: bin, batch_ms: 0,
        snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: true }, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
        approvals: { ...DEFAULT_CONFIG.approvals, notify: false }, mlx: { ...DEFAULT_CONFIG.mlx, enabled: false }, pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false } } });
    console_ = await ControlClient.connect(stateDir, { role: "console", projectRoot: project });
    const started = await console_.request({ t: "start", peer: instance }); expect(started).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({ cwd: worktree, peer: instance });
    const seen: any[] = [];
    tui = new WebSocket(started.proxyUrl); tui.onmessage = event => seen.push(JSON.parse(String(event.data)));
    await new Promise<void>((resolve, reject) => { tui!.onopen = () => resolve(); tui!.onerror = () => reject(new Error("fake TUI connection failed")); });
    // The TUI owns initialize. The daemon's app-server proxy must not synthesize it.
    tui.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "instance-worktree-fixture" } } }));
    await until(() => seen.some(message => message.id === 1), "native initialize reply");
    tui.send(JSON.stringify({ id: 2, method: "thread/start", params: {} }));
    await until(() => seen.some(message => message.id === 2 && message.result?.thread?.id) && daemon!.bus.stateOf(instance) === "idle", "instance adopted its native thread");
    turns = new Turns(join(stateDir, "hub.db"), true);
    let mutated = false;
    // The daemon registered its snapshot tap first, so busy is observed only after the start-tree receipt exists.
    untap = daemon.bus.tap(event => {
      if (event.t !== "state" || event.peer !== instance || event.state !== "busy" || mutated) return;
      mutated = true;
      writeFileSync(join(worktree, "owned.txt"), "worktree new\n");
    });
    daemon.bus.publish(newEnvelope("user", "isolated instance snapshot probe", { to: [instance] }));
    await until(() => mutated && turns!.latest(instance)?.ended != null, "the worktree turn completed with a durable receipt");
    const latest = turns.latest(instance)!;
    expect(latest.peer).toBe(instance);
    expect(latest.start_tree).not.toBeNull(); expect(latest.end_tree).not.toBeNull(); expect(latest.end_tree).not.toBe(latest.start_tree);
    expect(latest.changed).toEqual(["owned.txt"]);
    expect(readFileSync(join(project, "owned.txt"), "utf8")).toBe("canonical old\n");
    expect(readFileSync(join(worktree, "owned.txt"), "utf8")).toBe("worktree new\n");
    expect(git("status", "--porcelain")).toBe("");
    expect(turns.latest("codex")).toBeUndefined();
  } finally {
    untap?.(); tui?.close(); console_?.close(); turns?.close();
    await daemon?.stop(); rmSync(base, { recursive: true, force: true });
  }
}, 20_000);
