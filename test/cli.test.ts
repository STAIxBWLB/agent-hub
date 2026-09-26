import { expect, test } from "bun:test";
import { existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, removeBlock, upsertBlock } from "../src/cli/init.ts";
import { buildLaunch, CLAUDE_CHANNEL, statusLineSettings, UNATTENDED_WARNING } from "../src/cli/launch.ts";
import { allocatePorts } from "../src/hub/ports.ts";
import { nextStep, parseList, pluginState } from "../src/cli/setup.ts";
import { VERSION } from "../src/version.ts";
import { childEnv } from "../src/hub/child-process.ts";
import { freeText } from "../src/cli/free-text.ts";

test("ahub init is idempotent, keeps text outside the markers and writes no CLAUDE.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-"));
  writeFileSync(join(dir, "AGENTS.md"), "# Mine\n\nkeep me\n");
  expect(init(dir).map((p) => p.slice(dir.length + 1)).sort()).toEqual([".agenthub/config.json", ".agenthub/routing.toml", ".gitignore", "AGENTS.md"]);
  const first = readFileSync(join(dir, "AGENTS.md"), "utf8");
  expect(first).toStartWith("# Mine\n\nkeep me\n\n<!-- AGENT_HUB:BEGIN");
  expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
  expect(init(dir)).toEqual([]);
  expect(upsertBlock(first.replace("untrusted", "EDITED"), readFileSync("templates/AGENTS.block.md", "utf8"))).toBe(first);
});

// Any CLAUDE.md stops Claude Code from loading AGENTS.md, so init takes back the block older versions put there.
const LEGACY = upsertBlock("", "## agent-hub\n\nold Claude block\n");

test("ahub init strips a legacy CLAUDE.md block and keeps the user's text", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-"));
  writeFileSync(join(dir, "CLAUDE.md"), `# Mine\n\nkeep me\n\n${LEGACY}`);
  expect(init(dir).map((p) => p.slice(dir.length + 1))).toContain("CLAUDE.md");
  expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("# Mine\n\nkeep me\n");
  expect(init(dir)).toEqual([]);
});

test("ahub init deletes a CLAUDE.md that held only the legacy block", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-"));
  writeFileSync(join(dir, "CLAUDE.md"), `\n${LEGACY}\n`);
  expect(init(dir).map((p) => p.slice(dir.length + 1))).toContain("CLAUDE.md");
  expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
  expect(init(dir)).toEqual([]);
});

test("ahub init leaves a CLAUDE.md symlinked to AGENTS.md alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-"));
  symlinkSync("AGENTS.md", join(dir, "CLAUDE.md"));
  init(dir);
  expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("<!-- AGENT_HUB:BEGIN");
  expect(lstatSync(join(dir, "CLAUDE.md")).isSymbolicLink()).toBe(true);
  expect(init(dir)).toEqual([]);
});

test("ahub init leaves a CLAUDE.md hard-linked to AGENTS.md alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-"));
  writeFileSync(join(dir, "AGENTS.md"), "# Shared\n");
  linkSync(join(dir, "AGENTS.md"), join(dir, "CLAUDE.md"));
  init(dir);
  expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toContain("<!-- AGENT_HUB:BEGIN");
  expect(statSync(join(dir, "CLAUDE.md")).nlink).toBe(2);
  expect(init(dir)).toEqual([]);
});

test("ahub init leaves CLAUDE.md alone when AGENTS.md is a symlink to it", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-"));
  writeFileSync(join(dir, "CLAUDE.md"), "# Mine\n");
  symlinkSync("CLAUDE.md", join(dir, "AGENTS.md"));
  init(dir);
  expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toStartWith("# Mine\n\n<!-- AGENT_HUB:BEGIN");
  expect(lstatSync(join(dir, "AGENTS.md")).isSymbolicLink()).toBe(true);
  expect(init(dir)).toEqual([]);
});

test("ahub init never follows a CLAUDE.md symlink out of the project", () => {
  const dir = mkdtempSync(join(tmpdir(), "agenthub-"));
  const outside = join(mkdtempSync(join(tmpdir(), "agenthub-outside-")), "CLAUDE.md");
  writeFileSync(outside, LEGACY);
  symlinkSync(outside, join(dir, "CLAUDE.md"));
  expect(init(dir).map((p) => p.slice(dir.length + 1))).not.toContain("CLAUDE.md");
  expect(readFileSync(outside, "utf8")).toBe(LEGACY);
  expect(lstatSync(join(dir, "CLAUDE.md")).isSymbolicLink()).toBe(true);
});

test("removeBlock drops only the managed block", () => {
  expect(removeBlock(`a\n\n${LEGACY}\nb\n`)).toBe("a\n\nb\n");
  expect(removeBlock("no markers\n")).toBe("no markers\n");
  expect(removeBlock("<!-- AGENT_HUB:BEGIN unterminated\n")).toBe("<!-- AGENT_HUB:BEGIN unterminated\n");
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

test("native launcher environment drops recovery authority but keeps profile and state paths", () => {
  const env = childEnv({ AGENTHUB_RECOVERY_OPERATION: "operation-secret", CODEX_HOME: "/account/codex", CLAUDE_CONFIG_DIR: "/account/claude", AGENTHUB_STATE_DIR: "/project/state" });
  expect(env.AGENTHUB_RECOVERY_OPERATION).toBeUndefined();
  expect(env.CODEX_HOME).toBe("/account/codex");
  expect(env.CLAUDE_CONFIG_DIR).toBe("/account/claude");
  expect(env.AGENTHUB_STATE_DIR).toBe("/project/state");
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

test("one version: package.json, the plugin manifest, the CLI and the MCP server agree", async () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")).version;
  expect(VERSION).toBe(pkg);
  expect(JSON.parse(readFileSync("plugins/agent-hub/.claude-plugin/plugin.json", "utf8")).version).toBe(pkg);
  expect(Bun.spawnSync(["bun", "src/cli/main.ts", "--version"]).stdout.toString().trim()).toBe(pkg);
  expect(readFileSync("plugins/agent-hub/server.js", "utf8")).toContain(`version: "${pkg}"`); // stamped into the bundle
});

// issue #40: the text after a leading @peer was absorbed into the body, so `ahub say --backend mlx hi`
// sent the flag as chat and ignored the option it named.
test("say refuses a message that would absorb a flag, before touching the daemon", () => {
  const cwd = mkdtempSync(join(tmpdir(), "agenthub-cli-flags-"));
  const cli = join(process.cwd(), "src/cli/main.ts");
  const run = (...args: string[]) => Bun.spawnSync(["bun", cli, ...args], { cwd });
  const bad = run("say", "--backend", "mlx", "hi");
  expect(bad.exitCode).toBe(1);
  expect(bad.stderr.toString()).toContain("absorb");
  expect(bad.stderr.toString()).toContain("--backend");
  expect(run("say", "@pi", "try --model dgx/fast", "--verbose").exitCode).toBe(1);
  // `--` ends the options, so a message that really is about a flag is still sendable (it fails on the daemon
  // connection, not on the parse: the refusal above happens before `connect()`).
  expect(run("say", "@pi", "--", "--backend", "is", "broken").stderr.toString()).not.toContain("absorb");
  expect(run("remember", "--backend", "mlx").stderr.toString()).toContain("absorb");
});

test("free text preserves words before -- and still rejects preceding flags", () => {
  expect(freeText(["hello", "--", "--backend"], "say")).toBe("hello --backend");
  expect(freeText(["--", "--backend", "--"], "say")).toBe("--backend --");
  expect(() => freeText(["--backend", "mlx", "--", "hello"], "say")).toThrow("absorb");
  expect(freeText(["hello", "--"], "remember")).toBe("hello");
});

test("ahub setup: one step at a time from the JSON listings; paths compared exactly; a stale cached bundle counts as stale", () => {
  const root = mkdtempSync(join(tmpdir(), "agenthub-pkg-"));
  Bun.spawnSync(["mkdir", "-p", join(root, "plugins/agent-hub"), join(root, "cache")]);
  writeFileSync(join(root, "plugins/agent-hub/server.js"), "bundle v2");
  writeFileSync(join(root, "cache/server.js"), "bundle v2");
  const plugin = (version: string) => [{ id: "agent-hub@agent-hub", version, installPath: join(root, "cache") }];
  const here = [{ name: "agent-hub", path: root }];
  const step = (p: any, m: any) => nextStep(p, m, root)?.argv.slice(2).join(" ");

  expect(parseList("not json")).toEqual([]);
  expect(step([], [])).toBe(`marketplace add ${realpathSync(root)}`);
  expect(step([], here)).toBe("install agent-hub@agent-hub");
  expect(step(plugin(VERSION), here)).toBeUndefined();
  expect(step(plugin("0.0.9"), here)).toBe("uninstall agent-hub@agent-hub");
  // a prefix of the path, or another checkout, is not this package
  expect(step(plugin(VERSION), [{ name: "agent-hub", path: `${root}-old` }])).toBe("marketplace remove agent-hub");
  // a marketplace with another name whose path merely contains "agent-hub" is none of our business
  expect(step([], [{ name: "someone-elses", path: "/x/agent-hub" }])).toBe(`marketplace add ${realpathSync(root)}`);
  // same version, different bundle: Claude Code would run an older wire protocol
  writeFileSync(join(root, "cache/server.js"), "bundle v1");
  expect(pluginState(plugin(VERSION), root)).toMatchObject({ state: "stale" });
  expect(step(plugin(VERSION), here)).toBe("uninstall agent-hub@agent-hub");
  expect(step([{ id: "agent-hub@agent-hub", version: "9.9.9" }], here)).toBe("uninstall agent-hub@agent-hub");
});
