import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/hub/registry.ts";

const CLI = join(import.meta.dir, "..", "src", "cli", "main.ts");
const HUB_HOME = mkdtempSync(join(tmpdir(), "ahub-cli-home-"));
const roots: string[] = [];
type Result = { code: number; stdout: string; stderr: string };
async function cli(cwd: string, args: string[], env: Record<string, string> = {}): Promise<Result> {
  const p = Bun.spawn([process.execPath, CLI, ...args], { cwd, env: { ...process.env, AGENTHUB_HOME: HUB_HOME, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: await p.exited, stdout: await new Response(p.stdout).text(), stderr: await new Response(p.stderr).text() };
}
async function project(name: string): Promise<string> {
  const root = join(mkdtempSync(join(tmpdir(), `ahub-cli-${name}-`)), name);
  mkdirSync(root, { recursive: true });
  expect((await cli(root, ["init"])).code).toBe(0);
  writeFileSync(join(root, ".agenthub", "config.json"), JSON.stringify({ memory: { enabled: false }, inference: { enabled: false } }));
  roots.push(root);
  return root;
}
async function cleanup() {
  const registry = new Registry(join(HUB_HOME, "registry.db"));
  for (const root of roots) {
    const result = await cli(root, ["kill"]);
    if (result.code !== 0) {
      const row = registry.list().find((p) => p.root === realpathSync(root));
      if (row?.pid) { try { process.kill(row.pid, "SIGTERM"); } catch {} }
    }
  }
  registry.close();
}

test("CLI project selectors do not cross route nested or inherited contexts", async () => {
  const a = await project("one");
  const b = await project("two");
  const nested = join(a, "src", "nested");
  mkdirSync(nested, { recursive: true });
  try {
    expect((await cli(a, ["up"])).code).toBe(0);
    expect((await cli(b, ["up"])).code).toBe(0);
    expect((await cli(nested, ["status"])).stdout).toContain(a);
    expect((await cli(b, ["--project", a, "status"])).stdout).toContain(a);
    expect((await cli(b, ["status"], { AGENTHUB_STATE_DIR: join(a, ".agenthub", "state") })).stdout).toContain(b);
    expect((await cli(b, ["status"], { AGENTHUB_STATE_DIR: join(a, ".agenthub", "state") })).stdout).not.toContain(a + "/.agenthub");
  } finally {
    await cleanup();
  }
});

test("CLI registry IDs remain distinct and removing a running project is refused", async () => {
  const a = await project("remove-a");
  const b = await project("remove-b");
  try {
    expect((await cli(a, ["up"])).code).toBe(0);
    expect((await cli(b, ["up"])).code).toBe(0);
    const rows = JSON.parse((await cli(a, ["projects", "--json"])).stdout) as any[];
    const row = rows.find((r) => r.root === realpathSync(a));
    expect(row?.id).toBeTruthy();
    expect((await cli(a, ["projects", "remove", row.id])).code).not.toBe(0);
    const stopped = await cli(a, ["kill"]);
    expect(stopped.code, stopped.stderr).toBe(0);
    expect((await cli(a, ["projects", "remove", row.id])).code).toBe(0);
    expect(new Registry(join(HUB_HOME, "registry.db")).get(row.id)).toBeUndefined();
    expect((await cli(b, ["status"])).code).toBe(0);
    expect(existsSync(join(b, ".agenthub", "config.json"))).toBe(true);
  } finally {
    await cleanup();
  }
});

afterAll(cleanup);
