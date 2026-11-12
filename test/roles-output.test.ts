import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL } from "../src/hub/control-client.ts";
import { Registry } from "../src/hub/registry.ts";
import { hubGitSync } from "../src/hub/git.ts";
import { realPath } from "../src/hub/project.ts";
import { renderRoles, rolesView } from "../src/cli/output.ts";

// #1411 T2: `ahub roles [--json]` prints the flow roles the running hub settled, from its status reply, and works from a task worktree (AC4).
const CLI = join(import.meta.dir, "../src/cli/main.ts");
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const parses = (text: string) => { try { JSON.parse(text); return true; } catch { return false; } };
const text = (rows: { text: string }[][]) => rows.map(row => row.map(cell => cell.text).join("")).join("\n");

const STATUS = {
  roster: [{ peer: "claude", on: true }, { peer: "codex", on: true }, { peer: "kimi", on: false }],
  roleInfo: { claude: { flowRoles: ["planner", "reviewer", "conductor"] }, codex: { flowRoles: ["implementer", "verifier"] }, kimi: { flowRoles: ["implementer"] }, "codex-review": { flowRoles: ["reviewer"] } },
  planner: { peers: ["claude"], source: "roles" },
  reviewFallback: { required: false, sameFamily: "fallback" },
};

function fixture(status: Record<string, unknown>) {
  const root = realPath(mkdtempSync(join(tmpdir(), "ahub-roles-output-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "project"), stateDir = join(project, ".agenthub/state"); mkdirSync(stateDir, { recursive: true });
  const registry = new Registry(join(root, "home/registry.db"));
  const registered = registry.register(project, stateDir); registry.close();
  const base = { projectId: registered.id, pid: process.pid, cwd: project, controlPort: 12345, instanceId: "roles-output-fixture", peers: {}, tasks: {} };
  const requests: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req, srv) { if (srv.upgrade(req)) return; return new Response("no", { status: 400 }); }, websocket: {
    message(ws, body) {
      const req = JSON.parse(String(body)); requests.push(req);
      const reply = req.t === "hello" ? { t: "welcome", cwd: project, projectId: registered.id, instanceId: base.instanceId } : req.t === "status" ? { status: { ...base, ...status } } : {};
      ws.send(JSON.stringify({ ok: true, ...reply, rid: req.rid }));
    },
  } });
  cleanup.push(() => server.stop(true));
  writeFileSync(join(stateDir, "status.json"), JSON.stringify({ ...base, controlPort: server.port, protocol: PROTOCOL }));
  writeFileSync(join(stateDir, "control-token"), "fixture-token");
  writeFileSync(join(project, ".agenthub/config.json"), "{}");
  writeFileSync(join(project, ".gitignore"), "/.agenthub/\n/.worktrees/\n");
  const env: Record<string, string> = { ...process.env as Record<string, string>, HOME: join(root, "user"), AGENTHUB_HOME: join(root, "home"), GIT_CONFIG_GLOBAL: "/dev/null", TERM: "xterm-256color" };
  for (const key of Object.keys(env)) if ((key.startsWith("AGENTHUB_") && key !== "AGENTHUB_HOME") || key.startsWith("CODEX_") || key.startsWith("ORCA_") || ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID"].includes(key)) delete env[key];
  const git = (args: string[]) => expect(hubGitSync(["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: project, env, encoding: "utf8", timeout: 5000 }).status).toBe(0);
  const run = async (args: string[], cwd = project, extra: Record<string, string> = {}) => {
    const proc = Bun.spawn([process.execPath, CLI, "roles", ...args], { cwd, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code, stdout, stderr };
  };
  return { project, run, git, requests };
}

test("ahub roles prints each rostered peer's settled roles for a person, and --json is the view as data (#1411 T2)", async () => {
  const f = fixture(STATUS);
  const human = await f.run(["--color=never"], f.project, { COLUMNS: "200" });
  expect(human.code, human.stderr).toBe(0);
  expect(parses(human.stdout)).toBe(false);
  expect(human.stdout).toContain("planner, reviewer, conductor"); expect(human.stdout).toContain("implementer, verifier");
  expect(human.stdout).toContain("codex-review"); expect(human.stdout).not.toContain("kimi"); // off the roster
  expect(human.stdout).toContain("planner: claude (roles)");
  expect(human.stdout).toContain("when no reviewer can run: a planner other than the task's owner (claude), another family first, else the person");
  const json = await f.run(["--json"]);
  expect(json.code, json.stderr).toBe(0);
  expect(json.stdout).toBe(JSON.stringify(rolesView({ ...STATUS }), null, 2) + "\n");
  expect(JSON.parse(json.stdout).peers.map((row: { peer: string }) => row.peer)).toEqual(["claude", "codex", "codex-review"]);
  for (const columns of ["80", "200"]) for (const line of (await f.run(["--color=never"], f.project, { COLUMNS: columns })).stdout.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(Number(columns));
  expect((await f.run(["claude"])).code).toBe(1);
});

test("ahub roles run from a task worktree without .agenthub prints what the project root prints (AC4)", async () => {
  const f = fixture(STATUS);
  f.git(["init", "-q"]); f.git(["add", ".gitignore"]); f.git(["commit", "-qm", "c"]);
  const worktree = join(f.project, ".worktrees/task-1");
  f.git(["worktree", "add", "-q", "-b", "task-1", worktree]);
  const fromRoot = await f.run(["--json"]), fromWorktree = await f.run(["--json"], worktree);
  expect(fromWorktree.code, fromWorktree.stderr).toBe(0);
  expect(fromWorktree.stdout).toBe(fromRoot.stdout);
});

test("who reviews when no reviewer can run follows review.pool and review.same_family; an older hub reads as unknown (#1411 T2)", () => {
  const line = (reviewFallback: unknown, planner: unknown = { peers: ["claude"], source: "roles" }) => text(renderRoles(rolesView({ ...STATUS, planner, reviewFallback }), 200));
  expect(line({ required: true, sameFamily: "fallback" })).toContain("the person (review.pool is set)");
  expect(line({ required: true, sameFamily: "never" })).toContain("a planner of another family than the task's owner (claude), else the person");
  expect(line({ required: false, sameFamily: "fallback" }, { peers: [], source: "none" })).toContain("the person (no planner)");
  expect(line(undefined)).toContain("unknown: this hub does not report it");
});
