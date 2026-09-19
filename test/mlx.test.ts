import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMlx, inspectMlx, stopMlx } from "../src/models/mlx.ts";

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
