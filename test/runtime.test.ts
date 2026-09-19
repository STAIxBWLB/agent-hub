import { expect, test } from "bun:test";
import { join } from "node:path";
import { VERSION } from "../src/version.ts";

const entry = join(import.meta.dir, "..", "src", "cli", "main.js");

test("Node gets one actionable line before any Bun-only module is loaded", () => {
  const result = Bun.spawnSync(["node", entry, "--version"]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe("ahub: Bun >=1.3.0 is required. Install Bun: https://bun.sh\n");
});

test("Bun runs the installed entrypoint with arguments intact", () => {
  const result = Bun.spawnSync([process.execPath, entry, "--version"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(`${VERSION}\n`);
  expect(result.stderr.toString()).toBe("");
});
