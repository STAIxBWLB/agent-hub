import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryClient, workerUrl } from "../src/memory/client.ts";
import { startFakeMemWorker } from "./fakes/mem-worker.ts";

test("health against a live worker", async () => {
  const fake = startFakeMemWorker();
  expect(await new MemoryClient(fake.url).health()).toEqual({ ok: true, version: "13.25.1" });
  fake.stop();
});

test("fail-open: a stopped worker, an unknown endpoint and a hang all yield undefined with one log line", async () => {
  const fake = startFakeMemWorker();
  const lines: string[] = [];
  const client = new MemoryClient(fake.url, 100, (l) => lines.push(l));
  expect(await client.request("POST", "/api/nope", {})).toBeUndefined();
  fake.stop();
  expect(await client.health()).toEqual({ ok: false });
  expect(lines).toHaveLength(2);
});

test("worker port comes from claude-mem settings, default 37701", () => {
  const file = join(mkdtempSync(join(tmpdir(), "agenthub-")), "settings.json");
  expect(workerUrl(file)).toBe("http://127.0.0.1:37701");
  writeFileSync(file, JSON.stringify({ CLAUDE_MEM_WORKER_PORT: "38000" }));
  expect(workerUrl(file)).toBe("http://127.0.0.1:38000");
});
