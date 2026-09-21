import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/hub/daemon.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function project(value?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "ahub-model-config-")); dirs.push(dir);
  mkdirSync(join(dir, ".agenthub"));
  if (value !== undefined) writeFileSync(join(dir, ".agenthub/config.json"), typeof value === "string" ? value : JSON.stringify(value));
  return dir;
}
test("normal configuration defaults to bounded Ollama rather than Python", () => {
  expect(loadConfig(project()).mlx).toMatchObject({ provider: "ollama", model: "agenthub-fast-mlx:4b-8k", contextWindow: 8192, maxInputTokens: 6000, maxTokens: 2048 });
  expect(loadConfig(project({ mlx: { maxTokens: 512 } })).mlx.provider).toBe("ollama");
});
test("legacy paths require an explicit legacy provider", () => {
  expect(() => loadConfig(project({ mlx: { modelPath: "old-model" } }))).toThrow("explicit mlx.provider");
  const dir = project({ mlx: { provider: "legacy", modelPath: "old-model" } });
  expect(loadConfig(dir).mlx).toMatchObject({ provider: "legacy", modelPath: join(dir, "old-model"), maxInputTokens: 16000 });
});
test("malformed configuration cannot silently resurrect a runtime", () => {
  expect(() => loadConfig(project("{"))).toThrow();
  expect(() => loadConfig(project({ mlx: { provider: "other" } }))).toThrow("mlx.provider");
  expect(() => loadConfig(project({ mlx: [] }))).toThrow("object");
});
