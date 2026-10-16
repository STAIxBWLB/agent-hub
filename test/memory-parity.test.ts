import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { memoryHome } from "@staix/agent-mem";
import { MemoryStore } from "@staix/agent-mem";
import { canonicalPath, hubHome } from "../src/hub/project.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "amem-parity-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };

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
  const source = `import { MemoryStore } from ${JSON.stringify("@staix/agent-mem")}; const store = new MemoryStore(); console.log(store.dir); store.close();`;
  const child = Bun.spawnSync([process.execPath, "--preload", join(import.meta.dir, "hub-home.ts"), "-e", source], {
    env: { ...process.env, AMEM_HOME: sentinel, AGENTHUB_HOME: hub }, stdout: "pipe", stderr: "pipe",
  });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString().trim()).toBe(join(canonicalPath(hub), "memory"));
  expect(existsSync(join(hub, "memory", "index.db"))).toBe(true);
  expect(existsSync(sentinel)).toBe(false);
});

// Exercise the extension's dependency closure after TypeScript transpilation, on a real Node runtime.
test("Pi process identity uses the package's Node-safe platform entry (#412)", async () => {
  const result = await Bun.build({ entrypoints: [join(import.meta.dir, "../src/pi/process-signature.ts")], target: "node" });
  expect(result.success).toBe(true);
  const entry = join(temp(), "platform.mjs");
  writeFileSync(entry, await result.outputs[0]!.text());
  const child = spawnSync("node", ["--input-type=module", "-e",
    `import { processSignature, processLiveness } from ${JSON.stringify(entry)}; if (typeof processSignature !== "function" || typeof processLiveness !== "function") process.exit(1);`], { encoding: "utf8" });
  expect(child.stderr).not.toContain("bun:");
  expect(child.status).toBe(0);
});
