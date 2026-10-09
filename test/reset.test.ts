import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Board } from "../src/hub/board.ts";
import { Budget } from "../src/hub/budget.ts";
import { ConductorHolds } from "../src/hub/conductor.ts";
import { DEFAULT_CONFIG } from "../src/hub/daemon.ts";
import { DeliveryJournal } from "../src/hub/delivery-journal.ts";
import { newEnvelope } from "../src/hub/envelope.ts";
import { Registry } from "../src/hub/registry.ts";
import { drainCliAudits } from "../src/cli/identity-audit.ts";

const CLI = join(import.meta.dir, "../src/cli/main.ts");
const MARKERS = ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_COMPANION_SESSION_ID", "AGENTHUB_CHANNEL", "AGENTHUB_STATE_DIR", "AGENTHUB_PROJECT_DIR", "AGENTHUB_UNATTENDED", "AGENTHUB_RECOVERY_OPERATION"];
const SECRET = "reset-secret-body";

/** The CLI as a person runs it (no agent markers unless given), with a hub home of the fixture's own. */
async function cli(root: string, args: string[], markers: Record<string, string> = {}) {
  const wrapper = join(root, "..", `cli-${randomUUID()}.ts`);
  writeFileSync(wrapper, `for (const name of ${JSON.stringify(MARKERS)}) delete process.env[name];
Object.assign(process.env, ${JSON.stringify(markers)}, { AGENTHUB_HOME: ${JSON.stringify(join(root, "..", "home"))} });
process.argv = [process.execPath, ${JSON.stringify(CLI)}, ...${JSON.stringify(args)}];
await import(${JSON.stringify(CLI)});
`);
  const child = Bun.spawn([process.execPath, wrapper], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "agenthub-reset-")));
  const root = join(base, "project"), stateDir = join(root, ".agenthub", "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(root, ".agenthub", "config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false }, snapshots: { enabled: false } }));
  const registry = new Registry(join(base, "home", "registry.db"));
  const project = registry.register(root);
  registry.close();
  return { base, root, stateDir, project };
}

/** A stopped hub's state: three open deliveries, one queue entry without a row, every kind of hold, and kept records. */
function seed(stateDir: string, project: { id: string; root: string }) {
  const file = join(stateDir, "hub.db");
  const env = (to: string) => newEnvelope("user", SECRET, { to: [to] });
  const [a, b, c, d, queuedOnly] = [env("codex"), env("claude"), env("claude"), env("codex"), env("kimi")];
  const journal = new DeliveryJournal({ file, projectRoot: project.root, projectId: project.id, instanceId: "seed" });
  journal.createDelivery({ id: "d-queued", peer: "codex", state: "queued", createdAt: 1, originals: [a], out: [a] });
  journal.createDelivery({ id: "d-review", peer: "claude", state: "needs_review", createdAt: 2, originals: [b], out: [b], reason: "daemon stopped during delivery" });
  journal.createDelivery({ id: "d-accepted", peer: "claude", state: "accepted", createdAt: 3, originals: [c], out: [c] });
  journal.createDelivery({ id: "d-done", peer: "codex", state: "completed", createdAt: 4, originals: [d], out: [d] });
  journal.persistBus({ schemaVersion: 1, queues: { kimi: [queuedOnly] }, prefaces: {}, seen: [], attempts: {}, withdrawn: [] }, ["kimi"]);
  journal.close();
  const board = new Board(file);
  board.propose("user", { title: SECRET, class: "test" });
  board.close();
  new Budget(file, DEFAULT_CONFIG.budget, {} as never).close();
  const db = new Database(file);
  db.query("INSERT INTO budget_pauses (peer, since, resets_at, reason) VALUES ('codex', 1, ?, 'quota')").run(Date.now() + 3_600_000);
  db.close();
  const holds = new ConductorHolds(file);
  holds.hold("local", "claude");
  holds.close();
  for (const name of ["sessions.json", "claude-session.json", "claude-context.json"]) writeFileSync(join(stateDir, name), "{}");
  mkdirSync(join(stateDir, "pi-sessions"));
  writeFileSync(join(stateDir, "pi-sessions", "s.jsonl"), "{}\n");
  writeFileSync(join(stateDir, "hub.log"), "log line\n");
  writeFileSync(join(stateDir, "events.jsonl"), "{}\n");
  writeFileSync(join(stateDir, "project.json"), JSON.stringify({ root: project.root, projectId: project.id }));
  return `q:kimi:${queuedOnly.id}`;
}

/** Every file's content hash. The SQLite shared-memory index changes on any read; the CLI audit outbox is its own record. */
function contents(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) { if (name !== "cli-audit") walk(path); }
      else if (!name.endsWith("-shm")) out[relative(dir, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

function rows(stateDir: string, sql: string): any[] {
  const db = new Database(join(stateDir, "hub.db"), { readonly: true });
  try { return db.query(sql).all(); } finally { db.close(); }
}

async function stopDaemon(root: string, base: string) {
  if ((await cli(root, ["kill"])).code === 0) return;
  const registry = new Registry(join(base, "home", "registry.db"));
  const pid = registry.list()[0]?.pid;
  registry.close();
  if (pid) try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
}

test("AC1: the dry run lists ids and counts, no task or message text, and changes nothing", async () => {
  const { base, root, stateDir, project } = fixture();
  try {
    const queuedOnly = seed(stateDir, project);
    const before = contents(stateDir);
    for (const args of [["reset"], ["reset", "--all"]]) {
      const result = await cli(root, args);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain(`queued 2: d-queued, ${queuedOnly}`);
      expect(result.stdout).toContain("needs_review 1: d-review");
      expect(result.stdout).toContain("in flight 1: d-accepted");
      expect(result.stdout).toContain("manual holds 1: kimi");
      expect(result.stdout).toContain("budget pauses 1: codex");
      expect(result.stdout).toContain("conductor holds 1: local");
      expect(result.stdout).toContain("session pointers 3: sessions.json, claude-session.json, claude-context.json");
      expect(result.stdout).toContain("claude-mem is not touched");
      expect(result.stdout).toContain("nothing was changed; add --yes to apply");
      expect(result.stdout).not.toContain(SECRET);
      expect(contents(stateDir)).toEqual(before);
    }
    expect(existsSync(join(root, ".agenthub", "archive"))).toBe(false);
  } finally { rmSync(base, { recursive: true, force: true }); }
}, 30_000);

test("AC2: a runtime reset discards every queued and needs_review delivery once, clears holds and pauses and keeps the board and logs", async () => {
  const { base, root, stateDir, project } = fixture();
  try {
    const queuedOnly = seed(stateDir, project);
    const board = rows(stateDir, "SELECT * FROM tasks");
    const kept = ["hub.log", "events.jsonl", "pi-sessions/s.jsonl", "project.json"].map((name) => readFileSync(join(stateDir, name), "utf8"));
    const result = await cli(root, ["reset", "--yes"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('settled 4 deliveries as discard with reason "reset"');
    expect(result.stdout).toContain("relaunch them with ahub claude");
    expect(result.stdout).toContain("claude-mem is not touched");
    expect(result.stdout).not.toContain(SECRET);
    const history = rows(stateDir, "SELECT delivery_id, action, reason FROM resolution_history ORDER BY delivery_id");
    expect(history).toEqual(["d-accepted", "d-queued", "d-review", queuedOnly].sort().map((id) => ({ delivery_id: id, action: "discard", reason: "reset" })));
    expect(rows(stateDir, "SELECT id FROM deliveries WHERE state NOT IN ('discarded', 'completed')")).toEqual([]);
    expect(rows(stateDir, "SELECT state FROM deliveries WHERE id = 'd-done'")).toEqual([{ state: "completed" }]);
    const meta = rows(stateDir, "SELECT manual_paused, bus_snapshot FROM delivery_meta")[0];
    expect(JSON.parse(meta.manual_paused)).toEqual([]);
    expect(JSON.parse(meta.bus_snapshot).queues.kimi).toEqual([]);
    expect(rows(stateDir, "SELECT * FROM budget_pauses")).toEqual([]);
    expect(rows(stateDir, "SELECT * FROM conductor_holds")).toEqual([]);
    expect(rows(stateDir, "SELECT * FROM tasks")).toEqual(board);
    expect(["hub.log", "events.jsonl", "pi-sessions/s.jsonl", "project.json"].map((name) => readFileSync(join(stateDir, name), "utf8"))).toEqual(kept);
    for (const name of ["sessions.json", "claude-session.json", "claude-context.json"]) expect(existsSync(join(stateDir, name))).toBe(false);
    // The registry claim the reset held while acting is released again.
    const registry = new Registry(join(base, "home", "registry.db"));
    expect(registry.get(project.id)?.instanceId).toBeNull();
    registry.close();
    // A second reset finds nothing left and settles nothing twice.
    const again = await cli(root, ["reset", "--yes"]);
    expect(again.stdout).toContain("settled 0 deliveries");
    expect(rows(stateDir, "SELECT count(*) AS n FROM resolution_history")).toEqual([{ n: 4 }]);
  } finally { rmSync(base, { recursive: true, force: true }); }
}, 30_000);

test("AC3/AC4: --all stops the running hub first, archives the state directory, and ahub up starts empty under the same id", async () => {
  const { base, root, stateDir, project } = fixture();
  try {
    expect((await cli(root, ["up", "--no-console"])).code).toBe(0);
    expect((await cli(root, ["task", "propose", "--class", "test", SECRET])).code).toBe(0);
    const dry = await cli(root, ["reset", "--all"]);
    expect(dry.stdout).toContain("the hub is running; --yes stops it first");
    expect(existsSync(join(stateDir, "status.json"))).toBe(true);
    const result = await cli(root, ["reset", "--all", "--yes"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("hub stopped");
    const archive = join(root, ".agenthub", "archive");
    const [name, ...more] = readdirSync(archive).filter((entry) => entry.startsWith("state-"));
    expect(more).toEqual([]);
    expect(name).toMatch(/^state-\d{8}T\d{6}Z$/);
    expect(statSync(join(archive, name!)).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(archive, ".gitignore"), "utf8")).toBe("*\n");
    expect(existsSync(join(archive, name!, "hub.db"))).toBe(true);
    expect(existsSync(join(archive, name!, "status.json"))).toBe(false);
    expect(readdirSync(stateDir)).toEqual(["project.json"]);
    expect(readFileSync(join(stateDir, "project.json"), "utf8")).toBe(readFileSync(join(archive, name!, "project.json"), "utf8"));
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(root, ".agenthub", "config.json"), "utf8")).toContain("memory");

    expect((await cli(root, ["up", "--no-console"])).code).toBe(0);
    const projects = JSON.parse((await cli(root, ["projects", "--json"])).stdout) as { id: string; state: string }[];
    expect(projects.map((p) => [p.id, p.state])).toEqual([[project.id, "running"]]);
    expect((await cli(root, ["board"])).stdout.trim()).toBe("no tasks");
    expect((await cli(root, ["queue", "list"])).stdout.trim()).toBe("no retained deliveries");
  } finally { await stopDaemon(root, base); rmSync(base, { recursive: true, force: true }); }
}, 60_000);

test("AC4: the runtime reset stops a running hub first", async () => {
  const { base, root, stateDir } = fixture();
  try {
    expect((await cli(root, ["up", "--no-console"])).code).toBe(0);
    const result = await cli(root, ["reset", "--yes"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("hub stopped\nsettled 0 deliveries");
    expect(existsSync(join(stateDir, "status.json"))).toBe(false);
    expect(JSON.parse((await cli(root, ["projects", "--json"])).stdout)[0].state).toBe("stopped");
  } finally { await stopDaemon(root, base); rmSync(base, { recursive: true, force: true }); }
}, 60_000);

test("AC4: an agent shell, an open recovery operation and an unmatched registration are refused with nothing changed", async () => {
  const { base, root, stateDir, project } = fixture();
  try {
    seed(stateDir, project);
    const before = contents(stateDir);
    for (const markers of [{ AGENTHUB_PEER_ID: "claude" }, { CLAUDECODE: "1" }, { CODEX_THREAD_ID: "thread" }] as Record<string, string>[]) {
      const result = await cli(root, ["reset", "--all", "--yes"], markers);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("cannot run ahub reset; the person runs it in ahub console or a terminal");
    }
    expect(drainCliAudits(stateDir).map((row) => [row.command, row.outcome])).toEqual(Array(3).fill(["reset", "refused"]));

    const owner = randomUUID();
    writeFileSync(join(base, "home", "recovery.lock"), JSON.stringify({ operationId: owner }));
    for (const args of [["reset"], ["reset", "--yes"], ["reset", "--all", "--yes"]]) {
      const result = await cli(root, args);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/recovery operation [0-9a-f-]{36} is active/);
    }
    // Not even a shell that carries the operation's own id: a reset is never part of an operation.
    const inside = await cli(root, ["reset", "--yes"], { AGENTHUB_RECOVERY_OPERATION: owner });
    expect(inside.code).toBe(1);
    expect(inside.stderr).toContain(`recovery operation ${owner} is active`);
    rmSync(join(base, "home", "recovery.lock"));

    const registry = new Registry(join(base, "home", "registry.db"));
    registry.remove(project.id);
    registry.close();
    writeFileSync(join(stateDir, "status.json"), JSON.stringify({ cwd: root, controlPort: 9, pid: 999_999_999 }));
    writeFileSync(join(stateDir, "control-token"), "fixture-token");
    const withManifest = contents(stateDir);
    const unmatched = await cli(root, ["reset", "--yes"]);
    expect(unmatched.code).toBe(1);
    expect(unmatched.stderr).toContain("hub has no matching registration");
    expect(contents(stateDir)).toEqual(withManifest);
    for (const name of ["status.json", "control-token"]) rmSync(join(stateDir, name));
    expect(contents(stateDir)).toEqual(before);
    expect(existsSync(join(root, ".agenthub", "archive"))).toBe(false);
  } finally { rmSync(base, { recursive: true, force: true }); }
}, 60_000);

test("AC4: --all refuses a state directory outside <root>/.agenthub, and a stopped unregistered project is told how to register", async () => {
  const { base, root, stateDir, project } = fixture();
  const custom = join(base, "custom-state");
  try {
    mkdirSync(custom);
    writeFileSync(join(custom, "project.json"), JSON.stringify({ root, projectId: project.id }));
    writeFileSync(join(custom, "sessions.json"), "{}");
    const registry = new Registry(join(base, "home", "registry.db"));
    registry.register(root, custom);
    registry.close();
    const before = contents(custom);
    for (const args of [["reset", "--all"], ["reset", "--all", "--yes"]]) {
      const result = await cli(root, args, { AGENTHUB_STATE_DIR: custom });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`--all moves only ${stateDir}; this project's state is in ${custom}`);
    }
    expect(contents(custom)).toEqual(before);
    expect(existsSync(join(root, ".agenthub", "archive"))).toBe(false);
    // The runtime scope still works on such a state directory.
    const runtime = await cli(root, ["reset", "--yes"], { AGENTHUB_STATE_DIR: custom });
    expect(runtime.code, runtime.stderr).toBe(0);
    expect(existsSync(join(custom, "sessions.json"))).toBe(false);
    // From a plain terminal the default state directory has no registration; `ahub up` would orphan the custom one.
    const plain = await cli(root, ["reset", "--yes"]);
    expect(plain.code).toBe(1);
    expect(plain.stderr).toContain(`this project is registered with the state directory ${custom}; run ahub --project ${project.id} reset; nothing was changed`);

    const again = new Registry(join(base, "home", "registry.db"));
    again.remove(project.id);
    again.close();
    const unregistered = await cli(root, ["reset", "--yes"]);
    expect(unregistered.code).toBe(1);
    expect(unregistered.stderr).toContain("no registration matches this project and state directory; nothing was changed (ahub up registers it)");
  } finally { rmSync(base, { recursive: true, force: true }); }
}, 60_000);

test("a crashed hub's manifest and dead-pid claim do not block either scope; the runtime reset removes the manifest", async () => {
  const { base, root, stateDir, project } = fixture();
  const crash = () => {
    const dead = Bun.spawnSync(["true"]).pid; // reaped: its pid names no process now
    const registry = new Registry(join(base, "home", "registry.db"));
    expect(registry.claim(project.id, "crashed", dead)).toBe(true);
    registry.close();
    writeFileSync(join(stateDir, "status.json"), JSON.stringify({ cwd: root, projectId: project.id, instanceId: "crashed", controlPort: 9, pid: dead }));
    writeFileSync(join(stateDir, "control-token"), "stale-token");
    writeFileSync(join(stateDir, "hub.pid"), `${dead}\n`);
  };
  try {
    seed(stateDir, project);
    crash();
    const dry = await cli(root, ["reset"]);
    expect(dry.stdout).toContain("the hub is stopped");
    expect(dry.stdout).toContain("remove the manifest a hub left when it did not stop cleanly: status.json, control-token, hub.pid");
    const result = await cli(root, ["reset", "--yes"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('settled 4 deliveries as discard with reason "reset"');
    expect(result.stdout).toContain("removed the manifest a hub left when it did not stop cleanly: status.json, control-token, hub.pid");
    for (const name of ["status.json", "control-token", "hub.pid"]) expect(existsSync(join(stateDir, name))).toBe(false);
    const registry = new Registry(join(base, "home", "registry.db"));
    expect(registry.get(project.id)?.instanceId).toBeNull();
    registry.close();

    crash();
    writeFileSync(join(stateDir, "hub.pid"), "garbled"); // beside the dead status.json: that crash's leftover too
    const all = await cli(root, ["reset", "--all", "--yes"]);
    expect(all.code, all.stderr).toBe(0);
    expect(readdirSync(stateDir)).toEqual(["project.json"]);
    const [name] = readdirSync(join(root, ".agenthub", "archive")).filter((entry) => entry.startsWith("state-"));
    expect(readFileSync(join(root, ".agenthub", "archive", name!, "control-token"), "utf8")).toBe("stale-token");
  } finally { rmSync(base, { recursive: true, force: true }); }
}, 60_000);

test("a state the reset cannot read points to --all, which archives it as it is and restores an edited archive .gitignore", async () => {
  const { base, root, stateDir, project } = fixture();
  try {
    // A journal for another root: the journal refuses it on every open, so a rerun cannot finish the runtime reset.
    const journal = new DeliveryJournal({ file: join(stateDir, "hub.db"), projectRoot: "/elsewhere", projectId: project.id, instanceId: "seed" });
    journal.close();
    writeFileSync(join(stateDir, "project.json"), JSON.stringify({ root, projectId: project.id }));
    const runtime = await cli(root, ["reset", "--yes"]);
    expect(runtime.code).toBe(1);
    expect(runtime.stderr).toContain("project root does not match database");
    expect(runtime.stderr).toContain("a rerun fails the same way; ahub reset --all --yes archives it as it is");

    writeFileSync(join(stateDir, "hub.db"), "not a database at all, and long enough to be read as a page header..........");
    const before = contents(stateDir);
    const dry = await cli(root, ["reset"]);
    expect(dry.code).toBe(1);
    expect(dry.stderr).toContain("ahub reset --all --yes archives it as it is");
    const dryAll = await cli(root, ["reset", "--all"]);
    expect(dryAll.code, dryAll.stderr).toBe(0);
    expect(dryAll.stdout).toContain("could not read the state");
    expect(contents(stateDir)).toEqual(before);

    mkdirSync(join(root, ".agenthub", "archive"));
    writeFileSync(join(root, ".agenthub", "archive", ".gitignore"), "!*\n");
    const all = await cli(root, ["reset", "--all", "--yes"]);
    expect(all.code, all.stderr).toBe(0);
    expect(readFileSync(join(root, ".agenthub", "archive", ".gitignore"), "utf8")).toBe("*\n");
    const [name] = readdirSync(join(root, ".agenthub", "archive")).filter((entry) => entry.startsWith("state-"));
    expect(contents(join(root, ".agenthub", "archive", name!))).toEqual(before);
    expect(readdirSync(stateDir)).toEqual(["project.json"]);
  } finally { rmSync(base, { recursive: true, force: true }); }
}, 60_000);

test("--all refuses a symlinked archive or .gitignore before stopping anything, and replaces a hard-linked .gitignore", async () => {
  const { base, root, stateDir, project } = fixture();
  const archive = join(root, ".agenthub", "archive");
  const outside = join(base, "synced"), precious = join(base, "precious.txt");
  try {
    seed(stateDir, project);
    mkdirSync(outside);
    writeFileSync(precious, "keep me\n");
    const before = contents(stateDir);
    symlinkSync(outside, archive);
    for (const args of [["reset", "--all"], ["reset", "--all", "--yes"]]) {
      const result = await cli(root, args);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`${archive} is not a directory of this user (a symlink, or another owner's); nothing was changed`);
    }
    expect(readdirSync(outside)).toEqual([]);
    rmSync(archive);

    mkdirSync(archive);
    symlinkSync(precious, join(archive, ".gitignore"));
    const linked = await cli(root, ["reset", "--all", "--yes"]);
    expect(linked.code).toBe(1);
    expect(linked.stderr).toContain(`${join(archive, ".gitignore")} is not a regular file; nothing was changed`);
    expect(readFileSync(precious, "utf8")).toBe("keep me\n");
    expect(contents(stateDir)).toEqual(before);
    rmSync(join(archive, ".gitignore"));

    linkSync(precious, join(archive, ".gitignore"));
    const hard = await cli(root, ["reset", "--all", "--yes"]);
    expect(hard.code, hard.stderr).toBe(0);
    expect(readFileSync(precious, "utf8")).toBe("keep me\n");
    expect(readFileSync(join(archive, ".gitignore"), "utf8")).toBe("*\n");
    expect(lstatSync(join(archive, ".gitignore")).nlink).toBe(1);
  } finally { rmSync(base, { recursive: true, force: true }); }
}, 60_000);

test("a parser error is named by class only: data it choked on is never printed", async () => {
  const { base, root, stateDir, project } = fixture();
  try {
    seed(stateDir, project);
    const db = new Database(join(stateDir, "hub.db"));
    // One bare identifier: Bun's JSON error quotes it whole ("Unexpected identifier ...").
    const token = "privatebodytoken";
    db.query("UPDATE delivery_meta SET bus_snapshot = ?").run(`{"queues": ${token}`);
    db.close();
    const dry = await cli(root, ["reset"]);
    expect(dry.code).toBe(1);
    expect(dry.stderr).toContain("cannot read the state (SyntaxError reading hub.db); nothing was changed; ahub reset --all --yes archives it as it is");
    const dryAll = await cli(root, ["reset", "--all"]);
    expect(dryAll.stdout).toContain("could not read the state (SyntaxError reading hub.db); it is archived as it is");
    const runtime = await cli(root, ["reset", "--yes"]);
    expect(runtime.code).toBe(1);
    expect(runtime.stderr).toContain("SyntaxError reading hub.db; the hub is stopped and the reset is incomplete");
    for (const out of [dry, dryAll, runtime]) expect(out.stdout + out.stderr).not.toContain(token);
  } finally { rmSync(base, { recursive: true, force: true }); }
}, 60_000);

test("valid JSON of the wrong shape counts as damage: the dry run and --yes point to --all", async () => {
  const { base, root, stateDir, project } = fixture();
  try {
    seed(stateDir, project);
    const set = (column: string, value: string) => {
      const db = new Database(join(stateDir, "hub.db"));
      db.query(`UPDATE delivery_meta SET ${column} = ?`).run(value);
      db.close();
    };
    set("manual_paused", "{}");
    const dry = await cli(root, ["reset"]);
    expect(dry.code).toBe(1);
    expect(dry.stderr).toContain("cannot read the state (invalid delivery journal: manual_paused has the wrong shape); nothing was changed; ahub reset --all --yes archives it as it is");
    const yes = await cli(root, ["reset", "--yes"]);
    expect(yes.code).toBe(1);
    expect(yes.stderr).toContain("a rerun fails the same way; ahub reset --all --yes archives it as it is");
    set("manual_paused", "[]");
    set("bus_snapshot", JSON.stringify({ schemaVersion: 1, queues: { kimi: {} }, prefaces: {}, seen: [], attempts: {}, withdrawn: [] }));
    const queue = await cli(root, ["reset"]);
    expect(queue.stderr).toContain("bus_snapshot has the wrong shape");
    expect(rows(stateDir, "SELECT count(*) AS n FROM resolution_history")).toEqual([{ n: 0 }]);
  } finally { rmSync(base, { recursive: true, force: true }); }
}, 60_000);
