import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, upsertBlock } from "../src/cli/init.ts";
import { buildLaunch, CLAUDE_CHANNEL, statusLineSettings, UNATTENDED_WARNING } from "../src/cli/launch.ts";
import { allocatePorts } from "../src/hub/ports.ts";

test("ahub init is idempotent and keeps text outside the markers", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-"));
  writeFileSync(join(dir, "CLAUDE.md"), "# Mine\n\nkeep me\n");
  expect(init(dir).map((p) => p.slice(dir.length + 1)).sort()).toEqual([".agenthub/config.json", ".agenthub/routing.toml", ".gitignore", "AGENTS.md", "CLAUDE.md"]);
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

test("status line tee: records rate_limits, runs the wrapped command with the same input, never breaks the render", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "agenthub-tee-"));
  const tee = join(import.meta.dir, "..", "src", "cli", "statusline-tee.ts");
  const run = (input: string, original: string) => Bun.spawnSync(["bun", tee], { stdin: Buffer.from(input), env: { ...process.env, AGENTHUB_STATE_DIR: stateDir, AGENTHUB_STATUSLINE_CMD: original } });
  const input = JSON.stringify({ model: { display_name: "Fable" }, rate_limits: { five_hour: { used_percentage: 91, resets_at: 1_900_000_000 } } });
  const out = run(input, `python3 -c "import sys,json; print('HUD', json.load(sys.stdin)['model']['display_name'])"`);
  expect(out.stdout.toString()).toBe("HUD Fable\n");
  expect(JSON.parse(readFileSync(join(stateDir, "claude-usage.json"), "utf8")).rate_limits.five_hour.used_percentage).toBe(91);
  expect(run("not json", "echo still-renders").stdout.toString()).toBe("still-renders\n");
  expect(run(input, "").stdout.toString()).toBe("agent-hub  5h 91%  wk -\n"); // no status line to wrap: a line of its own, not a blank one
});

test("ahub claude injects the tee through --settings, wraps the user's command, and steps aside for a user --settings", () => {
  const tee = { script: "/repo/src/cli/statusline-tee.ts", stateDir: "/p/.agenthub/state", original: { command: "~/.claude/it's-hud.py # dot-hud", refreshInterval: 5 } };
  const settings = JSON.parse(statusLineSettings(tee));
  expect(settings.statusLine).toMatchObject({ type: "command", refreshInterval: 5 });
  expect(settings.statusLine.command).toContain("AGENTHUB_STATE_DIR='/p/.agenthub/state'");
  expect(settings.statusLine.command).toContain(`AGENTHUB_STATUSLINE_CMD='~/.claude/it'\\''s-hud.py # dot-hud'`); // quoted for sh
  const launch = buildLaunch("claude", [], { unattended: false, statusLine: tee });
  expect(launch.args.slice(2, 4)).toEqual(["--settings", statusLineSettings(tee)]);
  const own = buildLaunch("claude", ["--settings", "{}"], { unattended: false, statusLine: tee });
  expect(own.args.filter((a) => a === "--settings")).toHaveLength(1);
  expect(own.warning).toContain("status line tee is off");
});
