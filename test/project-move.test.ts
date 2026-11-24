import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { applyProjectMove, previewProjectMove } from "../src/hub/project-move.ts";
import { realPath } from "../src/hub/project.ts";
import { idFor, Registry, type Project } from "../src/hub/registry.ts";

function withDatabase<T>(file: string, action: (db: Database) => T): T {
  const db = new Database(file);
  try { return action(db); } finally { db.close(); }
}

function fixture() {
  const base = realPath(mkdtempSync(join(tmpdir(), "ahub-project-move-")));
  const registry = new Registry(join(base, "machine", "registry.db"));
  const oldRoot = join(base, "original");
  const newRoot = join(base, "moved");
  const peerRoot = join(base, "peer");
  for (const root of [oldRoot, peerRoot]) mkdirSync(join(root, ".agenthub", "state"), { recursive: true });
  const old = registry.register(oldRoot);
  const peer = registry.register(peerRoot);
  const marker = JSON.stringify({ root: oldRoot, projectId: old.id });
  writeFileSync(join(old.stateDir, "project.json"), marker);
  writeFileSync(join(old.stateDir, "runtime.json"), JSON.stringify({ schema: 1, projectId: old.id, projectRoot: old.root,
    stateDir: old.stateDir, version: "0.46.1", root: base, digest: "a".repeat(64), kind: "restart", instanceId: null }));
  withDatabase(join(old.stateDir, "hub.db"), db => {
    db.run("CREATE TABLE deliveries (project_id TEXT, state TEXT)");
    db.run("INSERT INTO deliveries VALUES (?, 'delivered')", [old.id]);
    db.run("CREATE TABLE delivery_meta (project_id TEXT PRIMARY KEY, project_root TEXT)");
    db.run("INSERT INTO delivery_meta VALUES (?, ?)", [old.id, old.root]);
    db.run('CREATE TABLE "extra state" (project_id TEXT)');
    db.run('INSERT INTO "extra state" VALUES (?)', [old.id]);
  });
  const peerDb = join(peer.stateDir, "hub.db");
  withDatabase(peerDb, db => {
    db.run("CREATE TABLE task_handoff_outbound (remote_project TEXT, remote_task INTEGER)");
    db.run("INSERT INTO task_handoff_outbound VALUES (?, 1)", [old.id]);
    db.run("CREATE TABLE task_handoff_origin (project_id TEXT, task_id INTEGER)");
    db.run("INSERT INTO task_handoff_origin VALUES (?, 2)", [old.id]);
  });
  renameSync(oldRoot, newRoot);
  symlinkSync(newRoot, oldRoot);
  const state = join(newRoot, ".agenthub", "state");
  return { base, registry, old, peer, peerDb, newRoot, marker, state, db: join(state, "hub.db"), close() {
    registry.close();
    rmSync(base, { recursive: true, force: true });
  } };
}

test("project move preserves port and rewrites all scoped rows, both handoff directions and runtime markers", () => {
  const f = fixture();
  try {
    const preview = previewProjectMove(f.registry, f.old.root, f.newRoot);
    expect(preview.stores.map(store => store.rewrites.map(item => item.count))).toEqual([[1, 1, 1], [1, 1]]);
    const applied = applyProjectMove(f.registry, f.old.id, f.newRoot, undefined, preview.fingerprint);
    expect(applied.archive).toBe(preview.archive);
    const newId = idFor(f.newRoot);
    expect(f.registry.get(f.old.id)).toBeUndefined();
    expect(f.registry.get(newId)).toMatchObject({ basePort: f.old.basePort, root: f.newRoot, stateDir: f.state });
    expect(withDatabase(f.db, db => db.query("SELECT * FROM delivery_meta").get())).toEqual({ project_id: newId, project_root: f.newRoot });
    expect(withDatabase(f.db, db => db.query('SELECT * FROM "extra state"').get())).toEqual({ project_id: newId });
    expect(withDatabase(f.peerDb, db => db.query("SELECT * FROM task_handoff_outbound").get())).toMatchObject({ remote_project: newId });
    expect(withDatabase(f.peerDb, db => db.query("SELECT * FROM task_handoff_origin").get())).toMatchObject({ project_id: newId });
    expect(JSON.parse(readFileSync(join(f.state, "project.json"), "utf8"))).toMatchObject({ root: f.newRoot, projectId: newId });
    expect(JSON.parse(readFileSync(join(f.state, "runtime.json"), "utf8"))).toMatchObject({ projectRoot: f.newRoot, projectId: newId, stateDir: f.state });
    expect(withDatabase(join(applied.archive, "registry.db"), db => db.query("SELECT id FROM projects WHERE root = ?").get(f.old.root))).toEqual({ id: f.old.id });
  } finally { f.close(); }
});

test("project move refuses live hubs, unsettled deliveries, duplicate roots and a stale preview", () => {
  const f = fixture();
  try {
    for (const row of [f.old, f.peer]) expect(f.registry.claim(row.id, row.id, process.pid)).toBe(true);
    expect(() => previewProjectMove(f.registry, f.old.id, f.newRoot)).toThrow(`ahub --project ${f.old.id} kill\nahub --project ${f.peer.id} kill`);
    for (const row of [f.old, f.peer]) f.registry.release(row.id, row.id);
    const preview = previewProjectMove(f.registry, f.old.id, f.newRoot);
    withDatabase(f.db, db => db.run("UPDATE deliveries SET state='queued'"));
    expect(() => previewProjectMove(f.registry, f.old.id, f.newRoot)).toThrow("pending deliveries");
    withDatabase(f.db, db => db.run("UPDATE deliveries SET state='discarded'"));
    expect(() => applyProjectMove(f.registry, f.old.id, f.newRoot, undefined, preview.fingerprint)).toThrow("new preview");
    f.registry.register(f.newRoot);
    expect(() => previewProjectMove(f.registry, f.old.id, f.newRoot)).toThrow("destination is registered");
    expect(readFileSync(join(f.state, "project.json"), "utf8")).toBe(f.marker);
    expect(existsSync(join(f.newRoot, ".agenthub", "archive"))).toBe(false);
  } finally { f.close(); }
});

test("project move rolls back database rewrites before surfacing an apply failure", () => {
  const f = fixture();
  try {
    const preview = previewProjectMove(f.registry, f.old.id, f.newRoot);
    expect(() => applyProjectMove(f.registry, f.old.id, f.newRoot, undefined, preview.fingerprint, () => {
      expect(withDatabase(f.db, db => db.query("SELECT project_id FROM deliveries").get())).toEqual({ project_id: preview.next.id });
      throw new Error("fixture failure after rewrite");
    })).toThrow("fixture failure after rewrite");
    expect(withDatabase(f.db, db => db.query("SELECT project_id FROM deliveries").get())).toEqual({ project_id: f.old.id });
    expect(readFileSync(join(f.state, "project.json"), "utf8")).toBe(f.marker);
    expect(f.registry.get(f.old.id)).toEqual(f.old);
    expect(f.registry.get(preview.next.id)).toBeUndefined();
    expect(existsSync(join(f.base, "machine", "project-move.pending.json"))).toBe(false);
  } finally { f.close(); }
});

test("the next registry opener restores an interrupted project move before taking claims", () => {
  const f = fixture();
  try {
    const plan = previewProjectMove(f.registry, f.old.id, f.newRoot);
    const child = Bun.spawnSync([process.execPath, "-e", `
      import { Registry } from "./src/hub/registry.ts";
      import { ControlClient } from "../src/hub/control-client.ts";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { applyProjectMove } from "./src/hub/project-move.ts";
      const [file, old, root, fingerprint] = process.argv.slice(1);
      applyProjectMove(new Registry(file), old, root, undefined, fingerprint, () => process.exit(42));
    `, f.registry.path, f.old.id, f.newRoot, plan.fingerprint], { cwd: join(import.meta.dir, "..") });
    expect(child.exitCode, child.stderr.toString()).toBe(42);
    expect(withDatabase(f.db, db => db.query("SELECT project_id FROM deliveries").get())).toEqual({ project_id: plan.next.id });
    const reopened = new Registry(f.registry.path);
    try {
      expect(reopened.get(f.old.id)).toEqual(f.old);
      expect(reopened.get(plan.next.id)).toBeUndefined();
      expect(withDatabase(f.db, db => db.query("SELECT project_id FROM deliveries").get())).toEqual({ project_id: f.old.id });
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test("two daemons reopen a moved project's board and resolve its handoff after CLI confirmation", async () => {
  const base = realPath(mkdtempSync(join(tmpdir(), "ahub-project-move-daemons-")));
  const home = join(base, "hub-home");
  const previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = home;
  const registry = new Registry(join(home, "registry.db"));
  const daemons: Awaited<ReturnType<typeof startDaemon>>[] = [];
  const clients: ControlClient[] = [];
  let restarted: Project | undefined;
  const start = async (project: Project) => {
    const daemon = await startDaemon({ cwd: project.root, stateDir: project.stateDir, projectId: project.id,
      controlPort: 0, codexAppPort: 0, codexProxyPort: 0, configWatch: false, notifier() {},
      config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false, native: false },
        snapshots: { ...DEFAULT_CONFIG.snapshots, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false },
        pi: { ...DEFAULT_CONFIG.pi, enabled: false, auto_start: false }, research: { ...DEFAULT_CONFIG.research, enabled: false },
        task_sweep: { ...DEFAULT_CONFIG.task_sweep, enabled: false }, approvals: { ...DEFAULT_CONFIG.approvals, notify: false } } });
    daemons.push(daemon);
    const client = await ControlClient.connect(project.stateDir, { role: "console", projectRoot: project.root, projectId: project.id });
    clients.push(client);
    return client;
  };
  const stop = async () => {
    for (const client of clients.splice(0)) client.close();
    for (const daemon of daemons.splice(0)) await daemon.stop();
  };
  const add = (name: string) => {
    const root = join(base, name);
    mkdirSync(join(root, ".agenthub", "state"), { recursive: true });
    writeFileSync(join(root, ".agenthub", "config.json"), JSON.stringify({
      memory: { enabled: false, native: false }, pi: { enabled: false, auto_start: false },
      snapshots: { enabled: false }, research: { enabled: false }, inference: { enabled: false },
    }));
    const project = registry.register(root);
    writeFileSync(join(project.stateDir, "project.json"), JSON.stringify({ root, projectId: project.id }));
    return project;
  };
  const cli = async (...args: string[]) => {
    const env: NodeJS.ProcessEnv = { ...process.env, AGENTHUB_HOME: home };
    for (const key of Object.keys(env)) if ((key.startsWith("AGENTHUB_") && key !== "AGENTHUB_HOME") ||
        ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CODEX_THREAD_ID", "KIMI_CODE"].includes(key)) delete env[key];
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...args], {
      cwd: base, env, stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exitCode, stdout, stderr };
  };
  try {
    const origin = add("origin"), target = add("target");
    const source = await start(origin);
    await start(target);
    const reply = await source.request({ t: "task", op: "hub_task_handoff", args: { project: target.id, title: "Shared board survives the move", class: "implement" } });
    expect(reply.ok, JSON.stringify(reply)).toBe(true);
    await stop();

    const moved = join(base, "target-renamed");
    renameSync(target.root, moved);
    const args = ["projects", "move", target.id, moved];
    const preview = await cli(...args);
    expect(preview.exitCode, preview.stderr).toBe(0);
    expect(preview.stdout).toContain("ahub autonomy on");
    const fingerprint = /--confirm (\S+)/.exec(preview.stdout)?.[1];
    expect(fingerprint).toBeDefined();
    const confirm = await cli(...args, "--confirm", fingerprint!);
    expect(confirm.exitCode, confirm.stderr).toBe(0);

    const registered = registry.get(idFor(moved))!;
    expect(registered.basePort).toBe(target.basePort);
    expect(registry.list().map(project => project.id).sort()).toEqual([origin.id, registered.id].sort());
    restarted = registered;
    const up = await cli("--project", registered.id, "up", "--no-agents", "--no-console");
    expect(up.exitCode, up.stderr).toBe(0);
    const destination = await ControlClient.connect(registered.stateDir, { role: "console", projectRoot: registered.root, projectId: registered.id });
    clients.push(destination);
    const returned = await destination.request({ t: "task", op: "task_show", args: { id: 1 } });
    expect(JSON.parse(returned.text)).toMatchObject({ title: "Shared board survives the move" });
    await start(origin);
    const handoffs = await cli("--project", origin.id, "task", "handoff", "--list", "--json");
    expect(handoffs.exitCode, handoffs.stderr).toBe(0);
    expect(JSON.parse(handoffs.stdout).handoffs).toEqual([
      expect.objectContaining({ remoteProject: registered.id, reach: "reachable" }),
    ]);
  } finally {
    await stop();
    if (restarted) {
      const down = await cli("--project", restarted.id, "kill");
      expect(down.exitCode, down.stderr).toBe(0);
    }
    registry.close();
    if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous;
    rmSync(base, { recursive: true, force: true });
  }
}, 30_000);
