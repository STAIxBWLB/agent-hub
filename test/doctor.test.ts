import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/hub/registry.ts";

const CLI = join(import.meta.dir, "..", "src", "cli", "main.ts");
const temps: string[] = [];
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

type Result = { code: number; stdout: string; stderr: string };
async function cli(home: string, cwd: string, args: string[]): Promise<Result> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], { cwd, env: { ...process.env, AGENTHUB_HOME: home }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, stdout, stderr };
}

function registerGone(home: string, pid?: number): { id: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "ahub-orphan-root-"));
  const registry = new Registry(join(home, "registry.db"));
  try {
    const project = registry.register(root);
    if (pid !== undefined) expect(registry.claim(project.id, "orphan-test-instance", pid)).toBe(true);
    rmSync(root, { recursive: true, force: true });
    return { id: project.id, root: project.root };
  } finally { registry.close(); }
}

// issue #56: operator tooling for daemons whose project directory was deleted under them.
test("doctor --orphans lists a registration whose project root is gone and skips healthy ones", async () => {
  const home = temp("ahub-doctor-home-");
  const gone = registerGone(home);
  const alive = temp("ahub-doctor-alive-");
  const registry = new Registry(join(home, "registry.db"));
  try { registry.register(alive); } finally { registry.close(); }

  const result = await cli(home, alive, ["doctor", "--orphans"]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("orphaned hub registrations");
  expect(result.stdout).toContain(gone.root);
  expect(result.stdout).toContain("no live process");
  expect(result.stdout).not.toContain(alive);
});

test("doctor --orphans reports none when every registration is intact", async () => {
  const home = temp("ahub-doctor-home-");
  const cwd = temp("ahub-doctor-cwd-");
  const registry = new Registry(join(home, "registry.db"));
  try { registry.register(cwd); } finally { registry.close(); }
  const result = await cli(home, cwd, ["doctor", "--orphans"]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("no orphaned hub registrations");
});

test("doctor --orphans --kill refuses a pid whose command line is not the project's hub daemon", async () => {
  const home = temp("ahub-doctor-home-");
  const cwd = temp("ahub-doctor-cwd-");
  // The bun test process is live, but its argv is not `--project <root> daemon`.
  registerGone(home, process.pid);
  const result = await cli(home, cwd, ["doctor", "--orphans", "--kill"]);
  expect(result.code).toBe(1);
  expect(result.stdout).toContain("refusing to kill");
  process.kill(process.pid, 0); // still here: the refusal was not a kill
});

/** A live process whose argv masquerades as a hub daemon: `<argv0> --project <root> daemon`. */
function fakeDaemon(argvRoot: string): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(["bash", "-c", `exec -a 'bun /opt/agent-hub/src/cli/main.ts --project ${argvRoot} daemon' sleep 30`]);
}

// #56 review: /tmp/foo must not match a healthy hub launched with --project /tmp/foo2.
test("doctor --orphans --kill refuses a daemon argv whose project only shares a path prefix", async () => {
  const home = temp("ahub-doctor-home-");
  const cwd = temp("ahub-doctor-cwd-");
  const gone = registerGone(home);
  const impostor = fakeDaemon(`${gone.root}2`);
  try {
    const registry = new Registry(join(home, "registry.db"));
    try { expect(registry.claim(gone.id, "orphan-test-instance", impostor.pid)).toBe(true); } finally { registry.close(); }
    const result = await cli(home, cwd, ["doctor", "--orphans", "--kill"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("refusing to kill");
    expect(impostor.exitCode).toBeNull(); // the prefix lookalike was not signaled
  } finally { if (impostor.exitCode === null) { impostor.kill("SIGKILL"); await impostor.exited; } }
});

test("doctor --orphans --kill stops a daemon argv that names the registered root exactly", async () => {
  const home = temp("ahub-doctor-home-");
  const cwd = temp("ahub-doctor-cwd-");
  const gone = registerGone(home);
  const orphan = fakeDaemon(gone.root);
  try {
    const registry = new Registry(join(home, "registry.db"));
    try { expect(registry.claim(gone.id, "orphan-test-instance", orphan.pid)).toBe(true); } finally { registry.close(); }
    const result = await cli(home, cwd, ["doctor", "--orphans", "--kill"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("stopped with SIGTERM");
    await orphan.exited;
    expect(orphan.exitCode !== null || orphan.signalCode !== null).toBe(true);
  } finally { if (orphan.exitCode === null) { orphan.kill("SIGKILL"); await orphan.exited; } }
});


test("orphan kill JSON remains one document, with successful diagnostics on stderr", async () => {
  const home = temp("ahub-doctor-json-home-");
  const cwd = temp("ahub-doctor-json-cwd-");
  const gone = registerGone(home);
  const orphan = fakeDaemon(gone.root);
  try {
    const registry = new Registry(join(home, "registry.db"));
    try { expect(registry.claim(gone.id, "orphan-json-instance", orphan.pid)).toBe(true); } finally { registry.close(); }
    const result = await cli(home, cwd, ["doctor", "--orphans", "--kill", "--json", "--color=always"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([expect.objectContaining({ project: expect.objectContaining({ id: gone.id }), pids: [orphan.pid] })]);
    expect(result.stdout).not.toContain("\x1b"); expect(result.stdout).not.toContain("stopped with SIGTERM");
    expect(result.stderr).toContain("stopped with SIGTERM");
    await orphan.exited; expect(orphan.exitCode !== null || orphan.signalCode !== null).toBe(true);
  } finally { if (orphan.exitCode === null) { orphan.kill("SIGKILL"); await orphan.exited; } }
});
