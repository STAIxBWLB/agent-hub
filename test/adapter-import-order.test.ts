import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// Separate interpreters expose initialization cycles that a cached module in this test process would hide.
for (const first of ["definitions/qwen", "registry"]) test(`#451 adapter metadata initializes with ${first} imported first`, () => {
  const path = new URL(`../src/adapters/${first}.ts`, import.meta.url).href;
  const code = `await import(${JSON.stringify(path)}); const r = await import(${JSON.stringify(new URL("../src/adapters/registry.ts", import.meta.url).href)}); if (r.definitionOf("qwen")?.kind !== "qwen") throw new Error("registry unavailable");`;
  const result = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 5000 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

// Native planning helpers must not pull an eagerly initialized hub export back through the registry.
for (const first of ["hub/start-mode", "hub/daemon", "hub/config-reload", "cli/preview"]) test(`#451 registry initializes when ${first} is the entrypoint`, () => {
  const path = new URL(`../src/${first}.ts`, import.meta.url).href;
  const registry = new URL("../src/adapters/registry.ts", import.meta.url).href;
  const code = `await import(${JSON.stringify(path)}); const r = await import(${JSON.stringify(registry)}); if (!r.definitionOf("pi")) throw new Error("registry unavailable");`;
  const result = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 5000 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
