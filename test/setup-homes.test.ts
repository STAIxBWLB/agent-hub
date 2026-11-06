import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupClaudeHomes, type SetupHomesPorts } from "../src/cli/setup-homes.ts";
import { PLUGIN, type InstalledPlugin } from "../src/cli/setup.ts";
import { discoverClaudeHomes } from "../src/cli/claude-homes.ts";
import { checkClaudeProfileHook } from "../src/cli/claude-profile-hook.ts";
import type { ClaudeHome, ClaudeHomeProbe } from "../src/cli/claude-homes.ts";
import { stablePackageRoot } from "../src/cli/install-paths.ts";
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


function nativeSetupFixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-install-aware-setup-")); roots.push(root);
  const user = join(root, "user"), profile = join(user, "profile"), bin = join(root, "bin"), tools = join(root, "tools/ahub");
  for (const directory of [user, profile, bin, tools]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const packageAt = (version: string) => join(tools, version, "lib/node_modules/@staix/agent-hub");
  const packages = [packageAt("A"), packageAt("B")];
  for (const packageRoot of packages) {
    mkdirSync(join(packageRoot, "src/cli"), { recursive: true }); mkdirSync(join(packageRoot, "plugins/agent-hub"), { recursive: true });
    writeFileSync(join(packageRoot, "src/cli/main.js"), "// fake installed CLI operand, never executed\n");
    writeFileSync(join(packageRoot, "src/cli/claude-profile-hook.ts"), "// fake hook path, never executed\n");
    writeFileSync(join(packageRoot, "plugins/agent-hub/server.js"), "fixture bundle");
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@staix/agent-hub", version: VERSION }));
  }
  const current = join(tools, "current"); symlinkSync("A", current);
  symlinkSync("../tools/ahub/current/lib/node_modules/@staix/agent-hub/src/cli/main.js", join(bin, "ahub"));
  const stateFile = join(profile, "native-state.json"), callsFile = join(profile, "native-calls.jsonl"), settings = join(profile, "settings.json");
  const preserved = { id: PLUGIN, scope: "project", projectPath: user, version: "0.23.1", installPath: join(profile, "old-cache") };
  writeFileSync(stateFile, JSON.stringify({ marketplacePath: null, plugins: [preserved] }));
  writeFileSync(settings, JSON.stringify({ statusLine: { command: "preserve-status" }, hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "preserve-foreign-hook" }] }] } }), { mode: 0o600 });
  const fake = join(bin, "fake-claude.ts");
  writeFileSync(fake, `import { readFileSync, writeFileSync, appendFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2), file = process.env.FIXTURE_STATE!, state = JSON.parse(readFileSync(file, "utf8"));
appendFileSync(process.env.FIXTURE_CALLS!, JSON.stringify(args) + "\\n");
if (args.join(" ") === "plugin list --json") console.log(JSON.stringify(state.plugins));
else if (args.join(" ") === "plugin marketplace list --json") console.log(JSON.stringify(state.marketplacePath ? [{ name: "agent-hub", path: state.marketplacePath }] : []));
else {
  if (args[0] !== "plugin") throw Error("unexpected fake command");
  if (args[1] === "marketplace" && args[2] === "add") state.marketplacePath = args[3];
  else if (args[1] === "marketplace" && args[2] === "remove") throw Error("marketplace removal must not run");
  else if (args[1] === "install" && args.slice(-2).join(" ") === "--scope user") {
    const cache = join(process.env.CLAUDE_CONFIG_DIR!, "plugin-cache"); mkdirSync(cache, { recursive: true });
    copyFileSync(join(process.env.FIXTURE_PACKAGE_ROOT!, "plugins/agent-hub/server.js"), join(cache, "server.js"));
    state.plugins = [...state.plugins.filter((row: any) => row.id !== ${JSON.stringify(PLUGIN)} || row.scope !== "user"), { id: ${JSON.stringify(PLUGIN)}, scope: "user", version: ${JSON.stringify(VERSION)}, installPath: cache }];
  } else if (args[1] === "uninstall" && args.slice(-2).join(" ") === "--scope user") state.plugins = state.plugins.filter((row: any) => row.id !== ${JSON.stringify(PLUGIN)} || row.scope !== "user");
  else throw Error("unexpected fake mutation");
  writeFileSync(file, JSON.stringify(state));
}
`);
  const env = { ...process.env, HOME: user, CLAUDE_CONFIG_DIR: profile, AGENTHUB_HOME: join(root, "hub"), AMEM_HOME: join(root, "amem"),
    FIXTURE_STATE: stateFile, FIXTURE_CALLS: callsFile, FIXTURE_PACKAGE_ROOT: packages[0]!, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` };
  const home: ClaudeHome = { path: profile, exists: true, sources: ["environment"] }, printed: string[] = [];
  const native = (argv: readonly string[], scoped: NodeJS.ProcessEnv) => Bun.spawnSync([process.execPath, fake, ...argv.slice(1)], { env: scoped, stdin: "ignore" });
  const ports: SetupHomesPorts = { env, packageRoot: packages[0]!, homes: [home], yes: true,
    probe: (argv, options) => { const result = native(argv, options.env); return { status: result.exitCode, stdout: result.stdout.toString() }; },
    run: async (argv, scoped) => native(argv, scoped).exitCode, ask: async () => { throw new Error("yes mode must not prompt"); }, print: line => printed.push(line) };
  const readState = (): { marketplacePath: string | null; plugins: InstalledPlugin[] } => JSON.parse(readFileSync(stateFile, "utf8"));
  const calls = (): string[][] => existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { root, user, profile, packages, current, env, home, ports, preserved, settings, stateFile, readState, calls };
}

test("fake Claude setup retains a verified current alias across A to B without marketplace removal or duplicate hooks", async () => {
  const f = nativeSetupFixture(), previousPath = process.env.PATH;
  try {
    process.env.PATH = f.env.PATH;
    const stable = stablePackageRoot(f.packages[0]!);
    expect(stable).toContain("/current/");
    f.ports.hook = { script: join(stable, "src/cli/claude-profile-hook.ts"), runtime: process.execPath };
    await setupClaudeHomes(f.ports);
    const first = readFileSync(f.settings, "utf8");
    expect(f.readState().marketplacePath).toBe(stable);
    expect(f.readState().plugins).toContainEqual(f.preserved);
    rmSync(f.current); symlinkSync("B", f.current);
    f.ports.packageRoot = f.packages[1]!; f.env.FIXTURE_PACKAGE_ROOT = f.packages[1]!;
    f.ports.hook = { script: join(stablePackageRoot(f.packages[1]!), "src/cli/claude-profile-hook.ts"), runtime: process.execPath };
    await setupClaudeHomes(f.ports);
    expect(f.readState().marketplacePath).toBe(stable);
    expect(f.readState().plugins).toContainEqual(f.preserved);
    expect(f.calls().filter(call => call[1] === "marketplace" && call[2] === "add")).toHaveLength(1);
    expect(f.calls().some(call => call[1] === "marketplace" && call[2] === "remove")).toBe(false);
    expect(readFileSync(f.settings, "utf8")).toBe(first);
    const settings = JSON.parse(first), entries = settings.hooks.PreToolUse;
    expect(entries.filter((entry: { hooks: { command: string }[] }) => entry.hooks.some(hook => hook.command.includes("claude-profile-hook.ts")))).toHaveLength(1);
    expect(entries[0]).toEqual({ matcher: "Read", hooks: [{ type: "command", command: "preserve-foreign-hook" }] });
    expect(settings.statusLine).toEqual({ command: "preserve-status" });
    expect(checkClaudeProfileHook(f.home, f.ports.hook).state).toBe("installed");
  } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; }
});

test("fake Claude refusal names every blocking field and exact inventory without running any mutation", async () => {
  const f = nativeSetupFixture(), future = { id: PLUGIN, scope: "future-scope", projectPath: join(f.root, "future-project"), version: "0.22.0", installPath: join(f.profile, "future-cache") };
  writeFileSync(f.stateFile, JSON.stringify({ marketplacePath: join(f.root, "old-package"), plugins: [f.preserved, future] }));
  const before = readFileSync(f.stateFile, "utf8"), settings = readFileSync(f.settings, "utf8");
  let failure = "";
  try { await setupClaudeHomes(f.ports); } catch (error) { failure = (error as Error).message; }
  expect(failure).toContain("Claude setup refused marketplace removal");
  for (const row of [f.preserved, future]) for (const field of ["scope", "projectPath", "version", "installPath"] as const) expect(failure).toContain(`${field}=${JSON.stringify(row[field])}`);
  expect(failure).toContain("~/.agenthub/releases"); expect(failure).toContain(join(f.user, ".agenthub/releases"));
  expect(failure).toContain("Do not run 'claude plugin uninstall --scope project' from $HOME");
  expect(failure).toContain("~/.claude/settings.json"); expect(failure).toContain("Next: back up"); expect(failure).toContain("manually remove only rows confirmed stale and unused");
  expect(failure).toContain(join(f.profile, "plugins/installed_plugins.json"));
  expect(f.calls()).toEqual([["plugin", "list", "--json"], ["plugin", "marketplace", "list", "--json"]]);
  expect(readFileSync(f.stateFile, "utf8")).toBe(before); expect(readFileSync(f.settings, "utf8")).toBe(settings);
});
