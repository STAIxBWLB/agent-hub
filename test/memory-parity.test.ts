import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../src/memory/platform.ts";
import { memoryHome } from "../src/memory/home.ts";
import { MemoryStore } from "../src/memory/store.ts";
import { canonicalPath, hubHome, realPath } from "../src/hub/project.ts";
import { DENY_NAMES, DENY_SEGMENTS, isDenied } from "../src/local/deny.ts";
import { hubGitArgv, hubGitEnv, hubGitSync } from "../src/hub/git.ts";
import { processLiveness, processSignature } from "../src/pi/process-signature.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "amem-parity-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test("hub deny policy re-exports the exact core function and constants (#412)", () => {
  expect(isDenied).toBe(core.isDenied);
  expect(DENY_NAMES).toBe(core.DENY_NAMES);
  expect(DENY_SEGMENTS).toBe(core.DENY_SEGMENTS);
});

test("hub path resolution re-exports the exact core functions (#412)", () => {
  expect(realPath).toBe(core.realPath);
  expect(canonicalPath).toBe(core.canonicalPath);
});

test("hub git helpers re-export the exact core argv, environment and execution functions (#412)", () => {
  expect(hubGitArgv).toBe(core.memoryGitArgv);
  expect(hubGitEnv).toBe(core.memoryGitEnv);
  expect(hubGitSync).toBe(core.memoryGitSync);
});

test("Pi process identity re-exports the exact Node-safe core functions (#412)", () => {
  expect(processSignature).toBe(core.processSignature);
  expect(processLiveness).toBe(core.processLiveness);
});

test("core memory home honors AMEM_HOME and preserves historical parent-home canonicalization", () => {
  const dir = temp(); mkdirSync(join(dir, "parent")); symlinkSync("parent", join(dir, "alias"));
  expect(memoryHome({ AMEM_HOME: ` ${join(dir, "direct")} `, AGENTHUB_HOME: join(dir, "ignored") })).toBe(canonicalPath(join(dir, "direct")));
  for (const env of [{}, { AGENTHUB_HOME: " " }, { AGENTHUB_HOME: join(dir, "alias") }, { AGENTHUB_HOME: join(dir, "missing") }]) expect(memoryHome(env)).toBe(join(hubHome(env), "memory"));
  expect(memoryHome({})).toBe(join(canonicalPath(join(homedir(), ".agenthub")), "memory"));
  const original = process.env.AMEM_HOME; process.env.AMEM_HOME = join(dir, "direct");
  let defaults: MemoryStore | undefined, explicit: MemoryStore | undefined;
  try {
    defaults = new MemoryStore(); explicit = new MemoryStore({ home: join(dir, "explicit") });
    expect(defaults.dir).toBe(canonicalPath(join(dir, "direct")));
    expect(explicit.dir).toBe(join(dir, "explicit", "memory"));
  } finally { defaults?.close(); explicit?.close(); if (original === undefined) delete process.env.AMEM_HOME; else process.env.AMEM_HOME = original; }
});


test("test preload discards inherited AMEM_HOME without opening the person's store", () => {
  const dir = temp(), hub = join(dir, "isolated-hub"), sentinel = join(dir, "must-not-open");
  const source = `import { MemoryStore } from ${JSON.stringify(join(import.meta.dir, "../src/memory/store.ts"))}; const store = new MemoryStore(); console.log(store.dir); store.close();`;
  const child = Bun.spawnSync([process.execPath, "--preload", join(import.meta.dir, "hub-home.ts"), "-e", source], {
    env: { ...process.env, AMEM_HOME: sentinel, AGENTHUB_HOME: hub }, stdout: "pipe", stderr: "pipe",
  });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString().trim()).toBe(join(canonicalPath(hub), "memory"));
  expect(existsSync(join(hub, "memory", "index.db"))).toBe(true);
  expect(existsSync(sentinel)).toBe(false);
});
