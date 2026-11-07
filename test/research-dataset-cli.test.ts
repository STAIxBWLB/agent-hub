import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import { Registry } from "../src/hub/registry.ts";
import { appendRecords, projectKey, taskRecords } from "../src/hub/research.ts";
import { readEvidence } from "../src/hub/research-record.ts";
import { boardWith, cleanDirs, familyOf, scenarioBoard, scenarioDeliveries, scenarioEvents, tempDir } from "./helpers/research-fixture.ts";

// #1277 AC3 through the real CLI: `ahub research export --dataset <dir> [--since] [--all]` over two registered fixture projects, and its refusals.

const dirs: string[] = [];
afterEach(() => cleanDirs(dirs));
const writer = { version: "test", source: "backfill" as const };
const CLI = join(import.meta.dir, "../src/cli/main.ts");

function world() {
  const home = tempDir(dirs, "user"), hub = join(home, "hub-home");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || key.startsWith("CODEX_") || key === "CLAUDECODE" || key === "CLAUDE_CODE_SESSION_ID" || key.startsWith("ORCA_") || key === "CI") delete env[key];
  Object.assign(env, { HOME: home, AGENTHUB_HOME: hub, AMEM_HOME: join(home, "memory"), GIT_CONFIG_GLOBAL: "/dev/null" });
  mkdirSync(hub, { recursive: true });
  const registry = new Registry(join(hub, "registry.db"));
  const project = (name: string, research: boolean) => {
    const root = join(home, name); mkdirSync(root);
    expect(hubGitSync(["init", "-q"], { cwd: root, encoding: "utf8", timeout: 5000, env }).status).toBe(0);
    const row = registry.register(root);
    const events = scenarioEvents();
    boardWith(row.stateDir, scenarioBoard(), scenarioDeliveries().map(d => ({ ...d, project: row.id })));
    writeFileSync(join(row.stateDir, "events.jsonl"), events.map(e => JSON.stringify(e)).join("\n") + "\n");
    if (research) appendRecords(row.id, taskRecords(events, row.id, writer, { ...readEvidence(row.stateDir, row.id), familyOf }), hub);
    return row;
  };
  const run = (cwd: string, args: string[]) => Bun.spawnSync([process.execPath, CLI, ...args], { cwd, env, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  return { home, hub, project, run, close: () => registry.close() };
}

test("AC3: export --dataset writes this project's three files and says what it wrote", () => {
  const w = world(), a = w.project("alpha", true), out = join(w.home, "out");
  const r = w.run(a.root, ["research", "export", "--dataset", out]);
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  expect(r.stdout.toString()).toContain(`${projectKey(a.id)}: 4 tasks (1 approved, 3 cancelled), 0 labels`);
  expect(readdirSync(join(out, projectKey(a.id))).sort()).toEqual(["manifest.json", "quality.json", "tasks.jsonl"]);
  w.close();
});

test("AC3: --all covers two registered projects and skips one with no records", () => {
  const w = world(), a = w.project("alpha", true), b = w.project("beta", true); w.project("gamma", false);
  const out = join(w.home, "out");
  const r = w.run(a.root, ["research", "export", "--dataset", out, "--all"]);
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  expect(readdirSync(out).sort()).toEqual([projectKey(a.id), projectKey(b.id)].sort());
  w.close();
});

test("--since keeps the records closed inside the window", () => {
  const w = world(), a = w.project("alpha", true), out = join(w.home, "out");
  const r = w.run(a.root, ["research", "export", "--dataset", out, "--since", "2099-01-01"]);
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  expect(JSON.parse(readFileSync(join(out, projectKey(a.id), "manifest.json"), "utf8")).counts).toEqual({ tasks: 0, approved: 0, cancelled: 0, labels: 0 });
  w.close();
});

test("the CLI refuses a target inside any registered project, outside the home, and a missing directory name, writing nothing", () => {
  const w = world(), a = w.project("alpha", true), b = w.project("beta", true);
  const inside = w.run(a.root, ["research", "export", "--dataset", join(b.root, "dataset"), "--all"]);
  expect(inside.exitCode).not.toBe(0);
  expect(inside.stderr.toString()).toContain("outside the project");
  expect(existsSync(join(b.root, "dataset"))).toBe(false);
  const outside = w.run(a.root, ["research", "export", "--dataset", join(tempDir(dirs, "elsewhere"), "d")]);
  expect(outside.exitCode).not.toBe(0);
  expect(outside.stderr.toString()).toContain("inside your home");
  const bare = w.run(a.root, ["research", "export", "--dataset"]);
  expect(bare.exitCode).not.toBe(0);
  expect(bare.stderr.toString()).toContain("--dataset takes a directory");
  const both = w.run(a.root, ["research", "export", "--dataset", join(w.home, "out"), "--format", "csv"]);
  expect(both.exitCode).not.toBe(0);
  expect(both.stderr.toString()).toContain("replaces --format");
  const wrong = w.run(a.root, ["research", "--dataset", join(w.home, "out")]);
  expect(wrong.exitCode).not.toBe(0);
  w.close();
});

test("a project with no records says so and writes nothing", () => {
  const w = world(), g = w.project("gamma", false), out = join(w.home, "out");
  const r = w.run(g.root, ["research", "export", "--dataset", out]);
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr.toString()).toContain("no research records");
  expect(existsSync(out)).toBe(false);
  w.close();
});

test("the existing export formats still work next to --dataset", () => {
  const w = world(), a = w.project("alpha", true);
  const jsonl = w.run(a.root, ["research", "export"]);
  expect(jsonl.exitCode, jsonl.stderr.toString()).toBe(0);
  expect(jsonl.stdout.toString().trim().split("\n")).toHaveLength(4);
  const csv = w.run(a.root, ["research", "export", "--format", "csv"]);
  expect(csv.exitCode).toBe(0);
  expect(csv.stdout.toString().split("\n")[0]).toContain("outcome");
  w.close();
});
