import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { DEFAULT_CONFIG, startDaemon } from "../src/hub/daemon.ts";
import { stopProject } from "../src/hub/lifecycle.ts";
import { Registry } from "../src/hub/registry.ts";

const CLI = join(import.meta.dir, "..", "src", "cli", "main.ts");
const HUB_HOME = mkdtempSync(join(tmpdir(), "ahub-lifecycle-home-"));
const projects: string[] = [];

type Result = { code: number; stdout: string; stderr: string };
async function cli(cwd: string, args: string[], extra: Record<string, string> = {}): Promise<Result> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], { cwd, env: { ...process.env, AGENTHUB_HOME: HUB_HOME, ...extra }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, stdout, stderr };
}

async function makeProject(name: string): Promise<string> {
  const root = join(mkdtempSync(join(tmpdir(), `ahub-${name}-`)), name);
  mkdirSync(root, { recursive: true });
  const initialized = await cli(root, ["init"]);
  expect(initialized.code).toBe(0);
  writeFileSync(join(root, ".agenthub", "config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false } }));
  projects.push(root);
  return root;
}

async function stopAll(): Promise<void> {
  const registry = new Registry(join(HUB_HOME, "registry.db"));
  for (const root of projects) {
    const result = await cli(root, ["kill"]);
    if (result.code !== 0) {
      const row = registry.list().find((p) => p.root === realpathSync(root));
      if (row?.pid) { try { process.kill(row.pid, "SIGTERM"); } catch {} }
    }
  }
  registry.close();
}

test("lifecycle starts two projects, converges same-root starts, and keeps stop scoped", async () => {
  const a = await makeProject("alpha");
  const b = await makeProject("beta");
  try {
    const started = await Promise.all([cli(a, ["up"]), cli(b, ["up"])]);
    expect(started.map((r) => r.code)).toEqual([0, 0]);
    const rows = JSON.parse((await cli(a, ["projects", "--json"])).stdout) as any[];
    expect(rows.filter((r) => r.state === "running")).toHaveLength(2);
    expect(new Set(rows.filter((r) => r.state === "running").map((r) => r.status.controlPort)).size).toBe(2);
    expect(new Set(rows.filter((r) => r.state === "running").map((r) => r.id)).size).toBe(2);

    const convergence = await Promise.all(Array.from({ length: 4 }, () => cli(a, ["up"])));
    expect(convergence.every((r) => r.code === 0)).toBe(true);
    expect((await cli(a, ["status"])).stdout).toContain(a);

    const taskA = await cli(a, ["task", "propose", "--class", "test", "alpha task"]);
    const taskB = await cli(b, ["task", "propose", "--class", "test", "beta task"]);
    expect(taskA.code).toBe(0);
    expect(taskB.code).toBe(0);
    expect((await cli(a, ["board"])).stdout).toContain("alpha task");
    expect((await cli(a, ["board"])).stdout).not.toContain("beta task");
    expect((await cli(b, ["board"])).stdout).toContain("beta task");

    const stopped = await cli(a, ["kill"]);
    expect(stopped.code, stopped.stderr).toBe(0);
    expect((await cli(a, ["status"])).code).not.toBe(0);
    expect((await cli(b, ["status"])).code).toBe(0);
  } finally {
    await stopAll();
  }
});

test("lifecycle supports custom state, explicit project selection, and inherited-state fallback", async () => {
  const a = await makeProject("nested");
  const b = await makeProject("explicit");
  const custom = join(mkdtempSync(join(tmpdir(), "ahub-custom-state-")), "state");
  try {
    expect((await cli(a, ["up"], { AGENTHUB_STATE_DIR: join(a, ".agenthub", "state") })).code).toBe(0);
    expect((await cli(b, ["--project", a, "status"], { AGENTHUB_STATE_DIR: join(b, ".agenthub", "state") })).code).toBe(0);
    expect((await cli(b, ["status"], { AGENTHUB_STATE_DIR: join(a, ".agenthub", "state") })).code).not.toBe(0);

    const registry = new Registry(join(HUB_HOME, "registry.db"));
    const project = registry.register(b, custom);
    registry.close();
    expect((await cli(b, ["--project", project.id, "up"])).code).toBe(0);
    expect(existsSync(join(custom, "status.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(custom, "status.json"), "utf8")).cwd).toBe(realpathSync(b));
  } finally {
    // The daemon above lives in the custom state dir; a plain kill in b's cwd looks at the
    // default state dir, finds nothing, exits 0 and stopAll's fallback never fires (#56).
    await cli(b, ["kill"], { AGENTHUB_STATE_DIR: custom });
    await stopAll();
  }
});

test("four cold starts of one project converge to one daemon", async () => {
  const root = await makeProject("cold");
  try {
    const starts = await Promise.all(Array.from({ length: 4 }, () => cli(root, ["up"])));
    expect(starts.every((r) => r.code === 0), starts.map((r) => r.stderr).join("\n")).toBe(true);
    const rows = JSON.parse((await cli(root, ["projects", "--json"])).stdout) as any[];
    expect(rows.filter((r) => r.root === realpathSync(root) && r.state === "running")).toHaveLength(1);
  } finally { await stopAll(); }
});

test("occupied control and app ports cause reallocation without touching the foreign listeners", async () => {
  const root = await makeProject("occupied");
  const registry = new Registry(join(HUB_HOME, "registry.db"));
  let project = registry.register(root);
  let listeners: ReturnType<typeof createServer>[] = [];
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = [createServer(), createServer()];
      try {
        await Promise.all(candidate.map((server, i) => new Promise<void>((resolve, reject) => {
          server.on("error", reject);
          server.listen(project.basePort + i, "127.0.0.1", () => resolve());
        })));
        listeners = candidate;
        break;
      } catch (error) {
        for (const server of candidate) if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        expect(registry.claim(project.id, "test-port-reserver", process.pid)).toBe(true);
        project = { ...project, basePort: registry.reallocate(project.id, "test-port-reserver") };
        registry.release(project.id, "test-port-reserver");
        if (attempt === 99) throw error;
      }
    }
    registry.close();
    expect((await cli(root, ["up"])).code).toBe(0);
    const updated = new Registry(join(HUB_HOME, "registry.db")).get(project.id)!;
    expect(updated.basePort).not.toBe(project.basePort);
    expect(listeners.every((s) => s.listening)).toBe(true);
  } finally {
    for (const server of listeners) server.close();
    await stopAll();
  }
});

test("incompatible manifest refuses the wrong kill and preserves project state", async () => {
  const root = await makeProject("stale");
  try {
    expect((await cli(root, ["up"])).code).toBe(0);
    const state = join(root, ".agenthub", "state", "status.json");
    const status = JSON.parse(readFileSync(state, "utf8"));
    writeFileSync(state, JSON.stringify({ ...status, protocol: 6 }));
    const result = await cli(root, ["kill"]);
    expect(result.code).not.toBe(0);
    expect(existsSync(state)).toBe(true);
    const registry = new Registry(join(HUB_HOME, "registry.db"));
    const row = registry.list().find((p) => p.root === realpathSync(root));
    if (row?.pid) { try { process.kill(row.pid, "SIGTERM"); } catch {} }
    registry.close();
  } finally { await stopAll(); }
});

// `ahub kill` returns only once the hub let go of its registry claim: a `projects remove` or `up` right after it must not
// meet a claim whose process is still on its way out (the CI flake of "removing a running project is refused").
test("stopProject waits for the registry claim, not only for the control files", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ahub-claim-")));
  const previous = process.env.AGENTHUB_HOME;
  process.env.AGENTHUB_HOME = HUB_HOME;
  const registry = new Registry();
  try {
    const project = registry.register(root);
    mkdirSync(project.stateDir, { recursive: true });
    expect(registry.claim(project.id, "held", process.pid)).toBe(true);
    const daemon = await startDaemon({ cwd: root, stateDir: project.stateDir, projectId: project.id, instanceId: "held", controlPort: 0, codexAppPort: 0, codexProxyPort: 0,
      config: { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled: false }, inference: { ...DEFAULT_CONFIG.inference, enabled: false } } });
    // The claim outlives the control files by 300 ms here; the real daemon process releases it a moment after them.
    let released = false;
    void daemon.stopped.then(() => setTimeout(() => { released = true; registry.release(project.id, "held"); }, 300));
    await stopProject(registry.get(project.id)!);
    expect(released).toBe(true);
    registry.remove(project.id); // throws while a live claim is held
  } finally {
    registry.close();
    if (previous === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

afterAll(async () => {
  await stopAll();
});
