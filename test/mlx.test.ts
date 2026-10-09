import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireGeneration, ensureMlx, inspectMlx, stopMlx } from "../src/models/mlx.ts";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

test("MLX supervisor records an owned process, enforces one generation, and cleans up only its owner", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "agenthub-mlx-"));
  let killed = false;
  const child = { pid: 43210, kill: () => { killed = true; return true; } } as any;
  const processInfo = () => ({ command: "/venv/bin/mlx_lm.server --model /models/qwen3", start: "start-1" });
  const handle = await ensureMlx({ runtimeDir, modelPath: "/models/qwen3", bin: "/venv/bin/mlx_lm.server", port: 47771,
    spawn: (() => child) as any, processInfo, health: async () => true });
  cleanup.push(async () => { await handle.close(); rmSync(runtimeDir, { recursive: true, force: true }); });
  const second = await ensureMlx({ runtimeDir, modelPath: "/models/qwen3", bin: "/venv/bin/mlx_lm.server", port: 47771, processInfo, health: async () => true });
  expect(handle.url).toBe("http://127.0.0.1:47771/v1");
  expect(JSON.parse(readFileSync(join(runtimeDir, "owner.json"), "utf8"))).toMatchObject({ pid: 43210, modelPath: "/models/qwen3" });
  const release = await handle.acquire();
  const cancelled = new AbortController();
  const waiting = second.acquire(cancelled.signal);
  cancelled.abort();
  await expect(waiting).rejects.toThrow("cancelled");
  release();
  await handle.close();
  expect(killed).toBe(false); // relay close never stops the shared MLX process.
});

test("MLX stop refuses a PID whose start signature changed", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "agenthub-mlx-owner-"));
  writeFileSync(join(runtimeDir, "owner.json"), JSON.stringify({ schema: 1, token: "t", pid: 43210, bin: "/venv/bin/mlx_lm.server", modelPath: "/models/qwen3", host: "127.0.0.1", port: 47771, startedAt: Date.now(), processStart: "old-start" }));
  await expect(stopMlx({ runtimeDir, processInfo: () => ({ command: "/venv/bin/mlx_lm.server --model /models/qwen3", start: "new-start" }) })).rejects.toThrow("refusing to kill");
  rmSync(runtimeDir, { recursive: true, force: true });
});

test("MLX refuses malformed owner state instead of starting a duplicate", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "agenthub-mlx-malformed-"));
  writeFileSync(join(runtimeDir, "owner.json"), "{}\n");
  await expect(inspectMlx({ runtimeDir })).rejects.toThrow("owner record");
  rmSync(runtimeDir, { recursive: true, force: true });
});

test("generation slots reclaim a dead or reused PID, then preserve an active claimant", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "agenthub-mlx-generation-reclaim-"));
  const deadPid = 2_000_000_000;
  const reusedPid = deadPid + 1;
  const db = new Database(join(runtimeDir, "generation-slots.db"), { create: true });
  db.run(`CREATE TABLE generation_slots (slot INTEGER PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, process_start TEXT NOT NULL)`);
  db.query("INSERT INTO generation_slots (slot, token, pid, process_start) VALUES (?, ?, ?, ?)").run(0, "dead-owner", deadPid, "old-start");
  db.close();
  const child = { pid: deadPid + 2, kill: () => true, unref: () => {} } as any;
  const processInfo = (pid: number) => pid === reusedPid
    ? { command: "/venv/bin/mlx_lm.server --model /models/qwen3", start: "reused-start" }
    : pid === child.pid
      ? { command: "/venv/bin/mlx_lm.server --model /models/qwen3", start: "child-start" }
      : pid === process.pid
        ? { command: "bun test", start: "self-start" }
        : undefined;
  const handle = await ensureMlx({ runtimeDir, modelPath: "/models/qwen3", bin: "/venv/bin/mlx_lm.server", port: 47772,
    spawn: (() => child) as any, processInfo, health: async () => true });
  cleanup.push(async () => { await handle.close(); rmSync(runtimeDir, { recursive: true, force: true }); });

  const releasedDeadOwner = await handle.acquire();
  releasedDeadOwner();
  const reused = new Database(join(runtimeDir, "generation-slots.db"), { create: true });
  reused.query("INSERT OR REPLACE INTO generation_slots (slot, token, pid, process_start) VALUES (?, ?, ?, ?)").run(0, "reused-owner", reusedPid, "old-start");
  reused.close();
  const release = await handle.acquire();
  const secondHandle = await ensureMlx({ runtimeDir, modelPath: "/models/qwen3", bin: "/venv/bin/mlx_lm.server", port: 47772, processInfo, health: async () => true });
  let secondFinished = false;
  const waiting = secondHandle.acquire().then((releaseSecond) => { secondFinished = true; return releaseSecond; });
  await Bun.sleep(70);
  expect(secondFinished).toBe(false);
  release();
  const releaseSecond = await waiting;
  releaseSecond();
  expect(secondFinished).toBe(true);
});

test("generation slots fail closed for malformed owner rows", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "agenthub-mlx-generation-malformed-"));
  const db = new Database(join(runtimeDir, "generation-slots.db"), { create: true });
  db.run(`CREATE TABLE generation_slots (slot INTEGER PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, process_start TEXT NOT NULL)`);
  db.query("INSERT INTO generation_slots (slot, token, pid, process_start) VALUES (?, ?, ?, ?)").run(0, "", 2_000_000_000, "old-start");
  db.close();
  const child = { pid: 2_000_000_001, kill: () => true, unref: () => {} } as any;
  const processInfo = (pid: number) => pid === child.pid
    ? { command: "/venv/bin/mlx_lm.server --model /models/qwen3", start: "child-start" }
    : pid === process.pid ? { command: "bun test", start: "self-start" } : undefined;
  const handle = await ensureMlx({ runtimeDir, modelPath: "/models/qwen3", bin: "/venv/bin/mlx_lm.server", port: 47773,
    spawn: (() => child) as any, processInfo, health: async () => true });
  await expect(handle.acquire()).rejects.toThrow("generation owner is malformed");
  rmSync(runtimeDir, { recursive: true, force: true });
});

test("generation slots fail closed when a live owner cannot be authenticated", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "agenthub-mlx-generation-unknown-"));
  const db = new Database(join(runtimeDir, "generation-slots.db"), { create: true });
  db.run(`CREATE TABLE generation_slots (slot INTEGER PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL, process_start TEXT NOT NULL)`);
  db.query("INSERT INTO generation_slots (slot, token, pid, process_start) VALUES (?, ?, ?, ?)").run(0, "unknown-owner", process.ppid, "old-start");
  db.close();
  const child = { pid: 2_000_000_021, kill: () => true, unref: () => {} } as any;
  const processInfo = (pid: number) => pid === child.pid
    ? { command: "/venv/bin/mlx_lm.server --model /models/qwen3", start: "child-start" }
    : pid === process.pid ? { command: "bun test", start: "self-start" } : undefined;
  const handle = await ensureMlx({ runtimeDir, modelPath: "/models/qwen3", bin: "/venv/bin/mlx_lm.server", port: 47774,
    spawn: (() => child) as any, processInfo, health: async () => true });
  await expect(handle.acquire()).rejects.toThrow("owner cannot be authenticated");
  rmSync(runtimeDir, { recursive: true, force: true });
});

test("an absent optional MLX executable rejects without an unhandled child error", () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "agenthub-mlx-absent-"));
  cleanup.push(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const code = `import { ensureMlx } from ${JSON.stringify(join(import.meta.dir, "../src/models/mlx.ts"))};
    try { await ensureMlx(${JSON.stringify({ runtimeDir, modelPath: join(runtimeDir, "model"), bin: join(runtimeDir, "absent") })}); throw new Error("unexpected startup"); }
    catch (error) { if (error.message === "unexpected startup") throw error; }
    await Bun.sleep(50); console.log("caller survived");`;
  const result = Bun.spawnSync([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("caller survived");
  expect(result.stderr.toString()).not.toContain("ENOENT");
});

// issue #177: the default process identity pins LC_ALL=C/TZ=UTC on the ps read, so a
// generation claimant recorded under one timezone is still authenticated when a later
// invocation re-reads it under another. The fake ps renders lstart from its own TZ,
// like the real one; unpinned, the second acquisition would reclaim the live claimant's slot.
test("MLX generation identity survives a timezone change between invocations", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "agenthub-mlx-tz-"));
  const binDir = mkdtempSync(join(tmpdir(), "agenthub-mlx-ps-"));
  cleanup.push(() => { rmSync(runtimeDir, { recursive: true, force: true }); rmSync(binDir, { recursive: true, force: true }); });
  const log = join(binDir, "ps-env.log");
  const fakePs = [
    "#!/bin/sh",
    `echo "LC_ALL=$LC_ALL TZ=$TZ" >> '${log}'`,
    'if [ "$TZ" = "UTC" ]; then echo "Wed Oct 07 12:00:00 2026 /fake/mlx_lm.server --model /models/qwen3"; else echo "Wed Oct 07 21:00:00 2026 /fake/mlx_lm.server --model /models/qwen3"; fi',
    "",
  ].join("\n");
  writeFileSync(join(binDir, "ps"), fakePs, { mode: 0o755 });
  const previous = { path: process.env.PATH, tz: process.env.TZ, lc: process.env.LC_ALL };
  cleanup.push(() => {
    if (previous.path === undefined) delete process.env.PATH; else process.env.PATH = previous.path;
    if (previous.tz === undefined) delete process.env.TZ; else process.env.TZ = previous.tz;
    if (previous.lc === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = previous.lc;
  });
  process.env.PATH = `${binDir}:${previous.path}`;
  process.env.TZ = "UTC";
  delete process.env.LC_ALL;

  const first = await acquireGeneration(runtimeDir, 2);
  process.env.TZ = "America/New_York";
  const second = await acquireGeneration(runtimeDir, 2);
  const db = new Database(join(runtimeDir, "generation-slots.db"), { readonly: true });
  const rows = db.query("SELECT slot FROM generation_slots ORDER BY slot").all() as { slot: number }[];
  db.close();
  expect(rows.map((row) => row.slot)).toEqual([0, 1]);
  const lines = readFileSync(log, "utf8").trim().split("\n");
  expect(lines.length).toBeGreaterThan(0);
  expect(new Set(lines)).toEqual(new Set(["LC_ALL=C TZ=UTC"]));
  first();
  second();
});

test("a generation slot asked for without waiting is refused at once while all are taken (#198)", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "agenthub-mlx-busy-"));
  cleanup.push(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const held = await acquireGeneration(runtimeDir, 1);
  const t0 = Date.now();
  await expect(acquireGeneration(runtimeDir, 1, undefined, undefined, 0)).rejects.toThrow("MLX generation is busy");
  expect(Date.now() - t0).toBeLessThan(1000);
  held();
  (await acquireGeneration(runtimeDir, 1, undefined, undefined, 0))();
});
