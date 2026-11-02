import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { specsBlock } from "../src/cli/init.ts";

test("repository specs instructions match the init wrapper and shipped template", () => {
  const root = join(import.meta.dir, "..");
  const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
  const startMarker = "<!-- AGENT_HUB_SPECS:BEGIN";
  const endMarker = "<!-- AGENT_HUB_SPECS:END -->";
  const start = agents.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(agents.indexOf(startMarker, start + startMarker.length)).toBe(-1);
  const end = agents.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  const block = agents.slice(start, end + endMarker.length) + "\n";
  expect(block).toBe(specsBlock("", true));
  const body = block.slice(block.indexOf("\n") + 1, block.lastIndexOf(endMarker)).trimEnd();
  expect(body).toBe(readFileSync(join(root, "templates/specs.block.md"), "utf8").trim());
});
