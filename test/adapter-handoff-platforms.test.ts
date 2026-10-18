import { expect, test } from "bun:test";
import { definitionOf, QUOTA_HANDOFF_PLATFORMS } from "../src/adapters/registry.ts";

test("#451 R1 quota handoff retains the original native memory platform map", () => {
  expect(QUOTA_HANDOFF_PLATFORMS).toEqual({ claude: "claude", codex: "codex", kimi: "kimi", qwen: "qwen", jcode: "jcode" });
  for (const peer of ["kimi", "jcode"]) expect(definitionOf(peer)?.hooks?.recallInjected === true).toBe(false);
});
