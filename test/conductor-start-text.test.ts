import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONDUCTOR_START_PEERS, SUPPORTED_PEERS, conductorStartText, definitionOf } from "../src/adapters/registry.ts";
import { conductorStart } from "../src/hub/conductor.ts";
import { CONDUCTOR_TOOLS } from "../src/hub/hub-tools.ts";

// #1408 T4 (R5): the conductor's start texts and type read the adapter definitions, not a claude/codex/pi literal.
const ROOT = join(import.meta.dir, "..");

test("the start text names exactly the startable kinds, optional ones apart, in registry order, with no kind written by hand", () => {
  const text = conductorStartText();
  const startable = SUPPORTED_PEERS.filter(peer => definitionOf(peer)!.start.conductorStartable);
  expect(startable).toEqual(["claude", "codex", "kimi", "pi", "local", "qwen", "jcode"]);
  expect(text.peers).toBe("claude, codex, kimi, pi, local, qwen or jcode");
  expect(text.refusal).toBe("only claude, codex, kimi, pi and local, plus the opt-in qwen and jcode, may be started by the conductor");
  expect(text.tuiPeers).toBe("claude, codex, kimi, pi and jcode");
  // agy is not startable, so it is in none of the three
  for (const words of Object.values(text)) expect(words).not.toContain("agy");
});

test("hub_peer_start's description is built from the same text, and its schema lists the same peers as before", () => {
  const tool = CONDUCTOR_TOOLS.find(entry => entry.name === "hub_peer_start")!;
  const text = conductorStartText();
  expect(tool.description).toContain(`Start ${text.peers} in the start mode a person set for it`);
  expect(tool.description).toContain(`A TUI peer (${text.tuiPeers} by default) opens in a terminal`);
  expect((tool.inputSchema.properties.peer as { enum: string[] }).enum).toEqual([...CONDUCTOR_START_PEERS]);
});

test("conductorStart refuses a peer that is not startable with the derived sentence, and starts every startable kind in the form its start mode names", () => {
  expect(() => conductorStart("agy", undefined, () => "no", true, () => "tui")).toThrow(conductorStartText().refusal);
  expect(() => conductorStart("not-a-peer", undefined, () => "no", true, () => "tui")).toThrow(conductorStartText().refusal);
  for (const peer of SUPPORTED_PEERS.filter(id => definitionOf(id)!.start.conductorStartable)) {
    expect(conductorStart(peer, undefined, id => `ahub ${id}`, true, () => "headless"), peer).toEqual({ peer, mode: "headless" });
    // a tui start carries the hub's own preview command for ANY startable kind (the type is no longer claude, codex and pi only)
    expect(conductorStart(peer, undefined, id => `ahub ${id}`, true, () => "tui"), peer).toEqual({ peer, mode: "tui", command: `ahub ${peer}` });
  }
});

test("no source line hard-codes the old start sentence or the claude/codex/pi start type", () => {
  const conductor = readFileSync(join(ROOT, "src/hub/conductor.ts"), "utf8");
  expect(conductor).not.toContain("only claude, codex, kimi, pi and local");
  expect(conductor).not.toMatch(/"claude" \| "codex" \| "pi"/);
  expect(readFileSync(join(ROOT, "src/hub/hub-tools.ts"), "utf8")).not.toContain("Start local, kimi, qwen, jcode, pi, claude or codex");
});

test("the docs say where the planner default comes from and how to change it", () => {
  const operations = readFileSync(join(ROOT, "docs/operations.md"), "utf8"), roles = readFileSync(join(ROOT, "docs/roles.md"), "utf8");
  expect(operations).not.toMatch(/That is `claude`\s+by default/);
  expect(operations).toMatch(/shipped `templates\/config\.json`/);
  expect(roles).toContain("it comes from the `roles` block of `templates/config.json`");
  expect(roles).not.toContain("and nothing else does");
});
