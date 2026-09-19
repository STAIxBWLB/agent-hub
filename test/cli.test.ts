import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, upsertBlock } from "../src/cli/init.ts";
import { buildLaunch, CLAUDE_CHANNEL, UNATTENDED_WARNING } from "../src/cli/launch.ts";
import { allocatePorts } from "../src/hub/ports.ts";

test("hub init is idempotent and keeps text outside the markers", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-"));
  writeFileSync(join(dir, "CLAUDE.md"), "# Mine\n\nkeep me\n");
  expect(init(dir).map((p) => p.slice(dir.length + 1)).sort()).toEqual([".agenthub/config.json", ".gitignore", "AGENTS.md", "CLAUDE.md"]);
  const first = readFileSync(join(dir, "CLAUDE.md"), "utf8");
  expect(first).toStartWith("# Mine\n\nkeep me\n\n<!-- AGENT_HUB:BEGIN");
  expect(init(dir)).toEqual([]);
  expect(upsertBlock(first.replace("untrusted", "EDITED"), readFileSync("templates/CLAUDE.block.md", "utf8"))).toBe(first);
});

test("default launches keep permission prompts; --unattended opts out and warns", () => {
  const claude = buildLaunch("claude", ["--model", "opus"], { unattended: false });
  expect(claude.args).toEqual(["--dangerously-load-development-channels", CLAUDE_CHANNEL, "--model", "opus"]);
  expect(claude.warning).toBeUndefined();

  const codex = buildLaunch("codex", ["--new"], { unattended: false, proxyUrl: "ws://127.0.0.1:4602" });
  expect(codex.args).toEqual(["--enable", "tui_app_server", "--remote", "ws://127.0.0.1:4602"]);

  const loud = buildLaunch("claude", ["--unattended"], { unattended: false });
  expect(loud.args).toContain("--dangerously-skip-permissions");
  expect(loud.warning).toBe(UNATTENDED_WARNING);
  expect(buildLaunch("codex", [], { unattended: true, proxyUrl: "ws://x" }).args).toContain("--dangerously-bypass-approvals-and-sandbox");
});

test("launchers refuse user-supplied copies of hub-owned flags", () => {
  expect(() => buildLaunch("claude", ["--dangerously-skip-permissions"], { unattended: false })).toThrow(/managed by the hub/);
  expect(() => buildLaunch("codex", ["--remote=ws://evil"], { unattended: false, proxyUrl: "ws://x" })).toThrow(/managed by the hub/);
});

test("port registry: base 4600, stride 10, stable per project", () => {
  const registry = join(mkdtempSync(join(tmpdir(), "agenthub-")), "ports.json");
  expect(allocatePorts("/a", registry)).toBe(4600);
  expect(allocatePorts("/b", registry)).toBe(4610);
  expect(allocatePorts("/a", registry)).toBe(4600);
});
