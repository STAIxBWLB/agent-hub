import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, DEFAULT_CONFIG } from "../src/hub/daemon.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
for (const overlay of [false, true]) test(`#553 invalid routing does not break unrelated config reads, overlay=${overlay}`, () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-routing-config-")); roots.push(root);
  mkdirSync(join(root, ".agenthub"));
  writeFileSync(join(root, ".agenthub/routing.toml"), overlay ? '[local]\nfixed_model="coding"\n' : '[local');
  if (overlay) writeFileSync(join(root, ".agenthub/routing.local.toml"), '[classes');
  expect(loadConfig(root)).toBe(DEFAULT_CONFIG);
  writeFileSync(join(root, ".agenthub/config.json"), JSON.stringify({ memory: { enabled: false } }));
  expect(loadConfig(root).memory.enabled).toBe(false);
  expect(loadConfig(root).retired ?? []).toEqual([]);
});
