import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("core deny policy matches every hub deny name, segment and extra-policy case", () => {
  expect(core.DENY_NAMES).toEqual(DENY_NAMES);
  expect(core.DENY_SEGMENTS).toEqual(DENY_SEGMENTS);
  const paths = ["src/public.ts", "file.env.md", ".env", ".env.local", "a/.env", "keys/a.pem", "id_rsa.pub", "credentials.json", "auth.json", ".netrc", ".npmrc", ".pypirc", ".maru/secrets/key", ".agenthub/state/hub.db", ".agenthub/archive/a/hub.db", "private/ordinary.txt", "a/.agenthub/stateful/safe.txt", "secrets\\id_ed25519"];
  for (const extra of [[], ["private/"], ["ordinary"], [""]]) for (const path of paths) expect(core.isDenied(path, extra)).toBe(isDenied(path, extra));
});

test("core real paths preserve hub symlink, missing-path and backslash behavior", () => {
  const dir = temp();
  mkdirSync(join(dir, "target")); mkdirSync(join(dir, "target", "child"));
  writeFileSync(join(dir, "target", "child", "한글.txt"), "fixture");
  mkdirSync(join(dir, "back\\slash")); writeFileSync(join(dir, "back\\slash", "file.txt"), "fixture");
  symlinkSync("target/child", join(dir, "alias")); symlinkSync("missing", join(dir, "dangling"));
  for (const path of [dir, join(dir, "alias", "한글.txt"), join(dir, "alias", ".."), join(dir, "back\\slash", "file.txt")]) expect(core.realPath(path)).toBe(realPath(path));
  for (const path of [join(dir, "missing"), join(dir, "dangling"), join(dir, "back\\slash", "missing")]) {
    expect(() => realPath(path)).toThrow(); expect(() => core.realPath(path)).toThrow();
  }
  for (const path of [dir, join(dir, "alias"), join(dir, "new", "deeper")]) expect(core.canonicalPath(path)).toBe(canonicalPath(path));
});

test("core git argv and environment preserve credential and execution safeguards", () => {
  for (const credentials of [undefined, false, true]) for (const args of [["status", "--porcelain"], ["-C", "/tmp/한글 path", "rev-parse", "HEAD"], ["show", "--no-ext-diff", "--no-textconv", "HEAD:src/a.ts"]]) expect(core.memoryGitArgv(args, { credentials })).toEqual(hubGitArgv(args, { credentials }));
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_TERMINAL_PROMPT: "1", FIXTURE: "unchanged" };
  expect(core.memoryGitEnv(env)).toEqual(hubGitEnv(env));
  expect(env.GIT_TERMINAL_PROMPT).toBe("1");
  const args = ["--version"], options = { encoding: "utf8" as const, env };
  const original = hubGitSync(args, options), copy = core.memoryGitSync(args, options);
  expect(copy.status).toBe(original.status); expect(copy.stdout).toBe(original.stdout); expect(copy.stderr).toBe(original.stderr);
});

test("core process identity and liveness match hub unknown, matching, reused and unreadable owners", () => {
  expect(core.processSignature(process.pid)).toBe(processSignature(process.pid));
  for (const pid of [null, undefined, "1", 0, -1, 0.5, Number.NaN, process.pid]) for (const signature of [undefined, null, "recorded"]) {
    for (const identity of [() => "recorded", () => "different", () => undefined, () => { throw new Error("unreadable"); }]) expect(core.processLiveness(pid, signature, identity)).toBe(processLiveness(pid, signature, identity));
  }
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
