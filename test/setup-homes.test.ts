import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupClaudeHomes, type SetupHomesPorts } from "../src/cli/setup-homes.ts";
import { PLUGIN, type InstalledPlugin } from "../src/cli/setup.ts";
import { discoverClaudeHomes } from "../src/cli/claude-homes.ts";
import { checkClaudeProfileHook } from "../src/cli/claude-profile-hook.ts";
import type { ClaudeHome, ClaudeHomeProbe } from "../src/cli/claude-homes.ts";
import { VERSION } from "../src/version.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(missingSecond = false) {
  const root = mkdtempSync(join(tmpdir(), "ahub-setup-homes-")); roots.push(root);
  const user = join(root, "user"), packageRoot = join(root, "package");
  mkdirSync(user); mkdirSync(join(packageRoot, "plugins", "agent-hub"), { recursive: true });
  writeFileSync(join(packageRoot, "plugins", "agent-hub", "server.js"), "fixture bundle");
  const homes: ClaudeHome[] = [0, 1].map(i => ({ path: join(user, `selected-${i}`), exists: !(i === 1 && missingSecond), sources: ["environment"] }));
  for (const home of homes) if (home.exists) mkdirSync(home.path, { mode: 0o700 });
  const unused = join(user, "unused"); mkdirSync(unused, { mode: 0o700 });
  const unusedSettings = join(unused, "settings.json");
  writeFileSync(unusedSettings, '{"statusLine":{"command":"unused-status"}}\n', { mode: 0o600 });
  const env = { HOME: user, CLAUDE_CONFIG_DIR: unused, TEST_CONTEXT: "preserved" };
  const states = new Map(homes.map(home => [home.path, { marketplace: false, marketplacePath: undefined as string | undefined, plugins: [] as InstalledPlugin[] }]));
  const probes: { argv: readonly string[]; home: string; timeoutMs: number }[] = [], runs: { argv: readonly string[]; env: NodeJS.ProcessEnv }[] = [], printed: string[] = [];
  const probe: ClaudeHomeProbe = (argv, options) => {
    const home = options.env.CLAUDE_CONFIG_DIR!;
    const state = states.get(home); if (!state) throw new Error("an unused home was probed");
    probes.push({ argv, home, timeoutMs: options.timeoutMs });
    expect(options.env.HOME).toBe(user);
    const value = argv.includes("marketplace")
      ? state.marketplace ? [{ name: "agent-hub", path: state.marketplacePath ?? packageRoot }] : []
      : state.plugins;
    return { status: 0, stdout: JSON.stringify(value) };
  };
  const run: SetupHomesPorts["run"] = async (argv, scoped) => {
    const home = scoped.CLAUDE_CONFIG_DIR!;
    const state = states.get(home); if (!state) throw new Error("an unused home was changed");
    runs.push({ argv, env: scoped });
    if (!existsSync(home)) mkdirSync(home, { mode: 0o700 });
    if (argv[2] === "marketplace" && argv[3] === "add") state.marketplace = true;
    else if (argv[2] === "uninstall") {
      expect(argv.slice(-2)).toEqual(["--scope", "user"]);
      state.plugins = state.plugins.filter(plugin => plugin.id !== PLUGIN || plugin.scope !== "user");
    }
    else if (argv[2] === "install") {
      expect(argv.slice(-2)).toEqual(["--scope", "user"]);
      const installPath = join(home, "plugin-cache");
      mkdirSync(installPath);
      writeFileSync(join(installPath, "server.js"), "fixture bundle");
      state.plugins = [...state.plugins, { id: PLUGIN, version: VERSION, scope: "user", installPath }];
    } else throw new Error("unexpected fake native step");
    return 0;
  };
  let asks = 0;
  const ports: SetupHomesPorts = { env, packageRoot, yes: false, homes, probe, run, ask: async () => { asks++; return "y"; }, print: line => printed.push(line) };
  return { root, user, packageRoot, homes, unused, unusedSettings, env, states, probes, runs, printed, ports, asks: () => asks };
}

test("one confirmation configures plugin and hook in both selected homes under their own environments", async () => {
  const f = fixture(true), before = readFileSync(f.unusedSettings, "utf8"), unusedListing = readdirSync(f.unused);
  f.ports.ask = async () => {
    expect(f.printed.some(line => line.includes(f.homes[0]!.path))).toBe(true);
    expect(f.printed.some(line => line.includes(f.homes[1]!.path))).toBe(true);
    expect(f.runs).toEqual([]);
    expect(existsSync(f.homes[1]!.path)).toBe(false);
    return "yes";
  };
  let confirmations = 0; const ask = f.ports.ask;
  f.ports.ask = async prompt => { confirmations++; return ask(prompt); };
  await setupClaudeHomes(f.ports);
  expect(confirmations).toBe(1);
  expect(f.runs.map(call => [call.env.CLAUDE_CONFIG_DIR, ...call.argv.slice(1)])).toEqual([
    [f.homes[0]!.path, "plugin", "marketplace", "add", f.packageRoot],
    [f.homes[0]!.path, "plugin", "install", "agent-hub@agent-hub", "--scope", "user"],
    [f.homes[1]!.path, "plugin", "marketplace", "add", f.packageRoot],
    [f.homes[1]!.path, "plugin", "install", "agent-hub@agent-hub", "--scope", "user"],
  ]);
  for (const call of f.runs) expect(call.env).toMatchObject({ HOME: f.user, TEST_CONTEXT: "preserved" });
  for (const home of f.homes) expect(checkClaudeProfileHook({ ...home, exists: true }).state).toBe("installed");
  for (const probe of f.probes) {
    expect(f.homes.some(home => home.path === probe.home)).toBe(true);
    expect(probe.timeoutMs).toBeGreaterThan(0); expect(probe.timeoutMs).toBeLessThanOrEqual(30_000);
  }
  expect(readFileSync(f.unusedSettings, "utf8")).toBe(before);
  expect(readdirSync(f.unused)).toEqual(unusedListing);
  expect(f.env.CLAUDE_CONFIG_DIR).toBe(f.unused);
});

test("a stale project-scope row is preserved while setup installs the user-scope plugin", async () => {
  const f = fixture(), home = f.homes[0]!;
  f.ports.homes = [home]; f.ports.yes = true;
  const projectPath = join(f.root, "project-home");
  f.states.get(home.path)!.marketplace = true;
  f.states.get(home.path)!.plugins = [{ id: PLUGIN, scope: "project", projectPath, version: "0.23.1" }];

  await setupClaudeHomes(f.ports);

  expect(f.runs.map(call => call.argv)).toEqual([["claude", "plugin", "install", PLUGIN, "--scope", "user"]]);
  expect(f.states.get(home.path)!.plugins).toEqual([
    { id: PLUGIN, scope: "project", projectPath, version: "0.23.1" },
    expect.objectContaining({ id: PLUGIN, scope: "user", version: VERSION }),
  ]);
  expect(f.printed.join("\n")).toContain(`project plugin row preserved at ${projectPath} (version 0.23.1)`);
});

test("a current user-scope row needs no plugin step when a stale project row is also present", async () => {
  const f = fixture(), home = f.homes[0]!;
  f.ports.homes = [home]; f.ports.yes = true;
  const projectPath = join(f.root, "project-home");
  f.states.get(home.path)!.marketplace = true;
  f.states.get(home.path)!.plugins = [
    { id: PLUGIN, scope: "project", projectPath, version: "0.23.1" },
    { id: PLUGIN, scope: "user", version: VERSION },
  ];

  await setupClaudeHomes(f.ports);

  expect(f.runs).toEqual([]);
  expect(f.printed.join("\n")).toContain(`project plugin row preserved at ${projectPath} (version 0.23.1)`);
});

test("replacing a stale user-scope plugin uses explicit user scope for both plugin commands", async () => {
  const f = fixture(), home = f.homes[0]!;
  f.ports.homes = [home]; f.ports.yes = true;
  f.states.get(home.path)!.marketplace = true;
  f.states.get(home.path)!.plugins = [{ id: PLUGIN, scope: "user", version: "0.23.1" }];

  await setupClaudeHomes(f.ports);

  expect(f.runs.map(call => call.argv)).toEqual([
    ["claude", "plugin", "uninstall", PLUGIN, "--scope", "user"],
    ["claude", "plugin", "install", PLUGIN, "--scope", "user"],
  ]);
});

test("a stale marketplace is not removed when that could remove project-scope plugin rows", async () => {
  const f = fixture(), home = f.homes[0]!;
  f.ports.homes = [home]; f.ports.yes = true;
  const projectPath = join(f.root, "project-home"), state = f.states.get(home.path)!;
  state.marketplace = true; state.marketplacePath = join(f.root, "old-package");
  state.plugins = [{ id: PLUGIN, scope: "project", projectPath, version: "0.23.1" }];

  await expect(setupClaudeHomes(f.ports)).rejects.toThrow("marketplace removal in");

  expect(f.runs).toEqual([]);
  expect(state.plugins).toEqual([{ id: PLUGIN, scope: "project", projectPath, version: "0.23.1" }]);
  expect(f.printed.join("\n")).toContain(`project plugin row preserved at ${projectPath} (version 0.23.1)`);
});

test("ahub setup records --agents after a Claude plugin step fails and still exits non-zero", () => {
  const root = mkdtempSync(join(tmpdir(), "ahub-setup-home-failure-")); roots.push(root);
  const bin = join(root, "bin"), userHome = join(root, "user"), claudeHome = join(root, "claude"), hubHome = join(root, "hub");
  const calls = join(root, "calls.log"), claude = join(bin, "claude"), packageRoot = realpathSync(process.cwd());
  mkdirSync(bin); mkdirSync(userHome); mkdirSync(claudeHome);
  writeFileSync(claude, `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
case "$*" in
  "plugin list --json") printf '%s\\n' '[]' ;;
  "plugin marketplace list --json") printf '%s\\n' '[{"name":"agent-hub","path":"${packageRoot}"}]' ;;
  *) exit 7 ;;
esac
`, { mode: 0o755 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTHUB_(?!HOME$)|CLAUDECODE|CLAUDE_CODE_SESSION_ID|CODEX_THREAD_ID)/.test(key))) as NodeJS.ProcessEnv;
  Object.assign(env, { HOME: userHome, CLAUDE_CONFIG_DIR: claudeHome, AGENTHUB_HOME: hubHome,
    AMEM_HOME: join(root, "amem"), PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` });
  const result = Bun.spawnSync(["bun", join(process.cwd(), "src/cli/main.ts"), "setup", "--agents", "pi,codex", "--yes"], { env, stdin: "ignore" });

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("Claude plugin setup failed");
  expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
    "plugin list --json",
    "plugin marketplace list --json",
    "plugin install agent-hub@agent-hub --scope user",
  ]);
  expect(JSON.parse(readFileSync(join(hubHome, "defaults.json"), "utf8"))).toEqual({ schema: 1, start: { agents: ["pi", "codex"] } });
});

test("revoked recovery authority cannot write a profile hook after confirmation or a final probe", async () => {
  for (const phase of ["confirmation", "probe"]) {
    const f = fixture(); let allowed = true;
    for (const state of f.states.values()) { state.marketplace = true; state.plugins = [{ id: PLUGIN, scope: "user", version: VERSION }]; }
    f.ports.current = () => { if (!allowed) throw new Error("recovery authority changed"); };
    if (phase === "confirmation") f.ports.ask = async () => { allowed = false; return "y"; };
    else {
      f.ports.yes = true;
      const probe = f.ports.probe;
      f.ports.probe = async (argv, options) => { const result = await probe(argv, options); allowed = false; return result; };
    }
    await expect(setupClaudeHomes(f.ports)).rejects.toThrow("recovery authority changed");
    expect(f.runs).toEqual([]);
    for (const home of f.homes) expect(existsSync(join(home.path, "settings.json"))).toBe(false);
  }
});

test("non-interactive setup without yes fails instead of reporting a successful cancellation", async () => {
  const f = fixture(); let asks = 0;
  const ports = { ...f.ports, interactive: false, ask: async () => { asks++; return null; } };
  await expect(setupClaudeHomes(ports)).rejects.toThrow("not a terminal");
  expect(asks).toBe(0); expect(f.runs).toEqual([]);
  for (const home of f.homes) {
    expect(f.printed.some(line => line.includes(home.path) && line.includes("claude plugin marketplace add"))).toBe(true);
    expect(existsSync(join(home.path, "settings.json"))).toBe(false);
  }
});

test("denying the single confirmation mutates no selected or unused home and never probes a missing home", async () => {
  const f = fixture(true), before = readFileSync(f.unusedSettings, "utf8");
  let asks = 0; f.ports.ask = async () => { asks++; return "n"; };
  await setupClaudeHomes(f.ports);
  expect(asks).toBe(1); expect(f.runs).toEqual([]);
  expect(f.probes.every(probe => probe.home === f.homes[0]!.path)).toBe(true);
  expect(readdirSync(f.homes[0]!.path)).toEqual([]);
  expect(existsSync(f.homes[1]!.path)).toBe(false);
  expect(readFileSync(f.unusedSettings, "utf8")).toBe(before);
  expect(f.printed).toContain("Claude setup was not changed.");
});

test("unknown native inventory refuses before confirmation or any plugin and hook write", async () => {
  const f = fixture();
  f.ports.probe = () => ({ status: 1, stdout: "sensitive-native-failure" });
  await expect(setupClaudeHomes(f.ports)).rejects.toThrow("cannot safely inspect");
  expect(f.asks()).toBe(0); expect(f.runs).toEqual([]);
  expect(f.printed.join(" ")).not.toContain("sensitive-native-failure");
  for (const home of f.homes) expect(readdirSync(home.path)).toEqual([]);
});

test("disableAllHooks in any selected home refuses the whole setup before writes", async () => {
  const f = fixture(), blocked = f.homes[1]!;
  const file = join(blocked.path, "settings.json"), contents = '{"disableAllHooks":true,"statusLine":{"command":"keep"}}';
  writeFileSync(file, contents, { mode: 0o600 });
  await expect(setupClaudeHomes(f.ports)).rejects.toThrow("cannot safely inspect");
  expect(f.asks()).toBe(0); expect(f.runs).toEqual([]);
  expect(f.probes.every(probe => probe.home !== blocked.path)).toBe(true);
  expect(readFileSync(file, "utf8")).toBe(contents);
  expect(readdirSync(f.homes[0]!.path)).toEqual([]);
});

test("a successful native step that never advances state is bounded at six and leaves later homes untouched", async () => {
  const f = fixture(); f.ports.yes = true;
  f.ports.run = async (argv, env) => { f.runs.push({ argv, env }); return 0; };
  await expect(setupClaudeHomes(f.ports)).rejects.toThrow("exceeded six plugin steps");
  expect(f.runs).toHaveLength(6);
  expect(f.runs.every(call => call.env.CLAUDE_CONFIG_DIR === f.homes[0]!.path)).toBe(true);
  expect(f.asks()).toBe(0);
  for (const home of f.homes) expect(readdirSync(home.path)).toEqual([]);
});

test("no selected home is a read-only notice with no prompts, probes or native changes", async () => {
  const f = fixture(); f.ports.homes = [];
  await setupClaudeHomes(f.ports);
  expect(f.probes).toEqual([]); expect(f.runs).toEqual([]); expect(f.asks()).toBe(0);
  expect(f.printed[0]).toContain("No Claude configuration home in use");
});


test("fresh default home is previewed without creating it, then configured after confirmation", async () => {
  const f = fixture(), defaultHome = join(f.user, ".claude");
  const found = await discoverClaudeHomes({ home: f.user, env: { HOME: f.user } });
  expect(found.homes).toEqual([{ path: defaultHome, exists: false, sources: ["default"] }]);
  f.ports.homes = found.homes;
  f.states.set(defaultHome, { marketplace: false, marketplacePath: undefined, plugins: [] });
  f.ports.ask = async () => {
    expect(existsSync(defaultHome)).toBe(false);
    expect(f.runs).toEqual([]);
    expect(f.printed.some(line => line.includes("claude plugin marketplace add"))).toBe(true);
    return "yes";
  };
  await setupClaudeHomes(f.ports);
  expect(f.runs.map(call => call.env.CLAUDE_CONFIG_DIR)).toEqual([defaultHome, defaultHome]);
  expect(checkClaudeProfileHook({ path: defaultHome, exists: true, sources: ["default"] }).state).toBe("installed");
});
