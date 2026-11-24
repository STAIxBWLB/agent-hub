import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("the CLI inventory renders the host-free help and output measurements", () => {
  const script = fileURLToPath(new URL("../scripts/cli-output-inventory.ts", import.meta.url));
  const run = Bun.spawnSync([process.execPath, script]);
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  const report = run.stdout.toString();
  expect(report).toContain("| roadmap | main.ts |");
  expect(report).toMatch(/src\/cli\/output.ts:renderDoctor \| Direct \|[^\n]+\| \d+ \|/);
});

test("CLI inventory numeric contracts are classified", async () => {
  const config = await Bun.file(new URL("../scripts/inventory-hardcoded-values.classifications.json", import.meta.url)).json();
  const entries = Object.entries(config).filter(([key]) => key.startsWith("scripts/cli-output-inventory.ts:"));
  expect(entries.some(([key, kind]) => key.includes(":columns:") && kind === "contract")).toBe(true);
  expect(entries.some(([key, kind]) => key.includes(":controlPort:") && kind === "test seam")).toBe(true);
});
