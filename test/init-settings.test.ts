import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import { init, initSettingRows, planInit } from "../src/cli/init.ts";
import { HELP } from "../src/cli/help.ts";
import { INIT_SETTINGS, INIT_SETTING_FLAGS, editJsonText, parseInitSettings, planInitSettings } from "../src/cli/init-settings.ts";
import { loadConfig } from "../src/hub/daemon.ts";
import { loadSdlc } from "../src/hub/sdlc.ts";

// #1065 T1: the init settings table, its plan rows, validated writes, flags and help.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-init-settings-")); roots.push(root);
  const user = join(root, "user"), home = join(root, "hub"); mkdirSync(user);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || key.startsWith("CODEX_") || key === "CLAUDECODE" || key === "CLAUDE_CODE_SESSION_ID" || key.startsWith("ORCA_") || key === "CI") delete env[key];
  Object.assign(env, { HOME: user, AGENTHUB_HOME: home, CLAUDE_CONFIG_DIR: join(user, "claude"), AMEM_HOME: join(root, "memory"), GIT_CONFIG_GLOBAL: "/dev/null" });
  const repo = (name: string) => { const cwd = join(root, name); mkdirSync(cwd); expect(hubGitSync(["init", "-q"], { cwd, env, encoding: "utf8", timeout: 3000 }).status).toBe(0); return cwd; };
  const run = (cwd: string, args: string[], overrides: NodeJS.ProcessEnv = {}) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...args], { cwd, env: { ...env, ...overrides }, stdout: "pipe", stderr: "pipe", timeout: 15000 });
  const text = (cwd: string, name: string) => readFileSync(join(cwd, ".agenthub", name), "utf8");
  const json = (cwd: string, name: string) => JSON.parse(text(cwd, name));
  const tree = (cwd: string) => Object.fromEntries(readdirSync(join(cwd, ".agenthub")).filter(name => !name.startsWith("state")).map(name => [name, existsSync(join(cwd, ".agenthub", name)) && !name.endsWith("shadow.git") ? (() => { try { return readFileSync(join(cwd, ".agenthub", name), "utf8"); } catch { return "<dir>"; } })() : "<dir>"]));
  return { root, home, env, repo, run, text, json, tree };
}
const out = (result: { stdout: Buffer; stderr: Buffer }) => `${result.stdout.toString()}${result.stderr.toString()}`;

// ---- AC1: each flag writes its key to the stated file on a new project; --dry-run --json shows the same rows and writes nothing ----

test("each settings flag writes its key to the stated file on a new project (#1065 AC1)", () => {
  const p = fixture(), cwd = p.repo("new");
  const done = p.run(cwd, ["init", "--agents", "claude,codex", "--sdlc", "enforce", "--coordination", "turn-free", "--no-memory", "--no-snapshots", "--pi", "--autonomy", "off"]);
  expect(done.exitCode, out(done)).toBe(0);
  const config = p.json(cwd, "config.json");
  expect(config.coordination).toBe("turn-free");
  expect(config.memory.enabled).toBe(false);
  expect(config.snapshots.enabled).toBe(false);
  expect(config.pi.enabled).toBe(true);
  expect(config.memory.inject_tokens).toBe(2000); // a neighbour key of a written one is the template's
  expect(p.json(cwd, "config.local.json")).toEqual({ start: { agents: ["claude", "codex"] } });
  expect(p.text(cwd, "sdlc.toml")).toBe('mode = "enforce"\n');
  expect(loadSdlc(cwd).mode).toBe("enforce");
  expect(loadConfig(cwd).coordination).toBe("turn-free");
});

test("every flag of the table writes a different key in the right file, and --memory --snapshots --pi write true (#1065 AC1)", () => {
  const p = fixture(), cwd = p.repo("on");
  expect(p.run(cwd, ["init", "--memory", "--snapshots", "--no-pi", "--coordination", "advisory", "--sdlc", "advise", "--agents", "none"]).exitCode).toBe(0);
  const config = p.json(cwd, "config.json");
  expect([config.memory.enabled, config.snapshots.enabled, config.pi.enabled, config.coordination]).toEqual([true, true, false, "advisory"]);
  expect(p.json(cwd, "config.local.json").start.agents).toEqual([]);
  expect(p.text(cwd, "sdlc.toml")).toBe('mode = "advise"\n');
  // The table lists exactly the flags the CLI owns, so a row added later is reachable and tested through the same path.
  expect(INIT_SETTING_FLAGS.slice().sort()).toEqual(["--agents", "--autonomy", "--coordination", "--memory", "--no-memory", "--no-pi", "--no-snapshots", "--pi", "--sdlc", "--snapshots"].sort());
  expect(new Set(INIT_SETTINGS.map(row => row.id)).size).toBe(INIT_SETTINGS.length);
});

test("--dry-run --json shows the same rows as the write and writes nothing (#1065 AC1)", () => {
  const p = fixture(), cwd = p.repo("preview");
  const flags = ["--agents", "codex", "--sdlc", "advise", "--coordination", "turn-free", "--no-memory", "--pi"];
  const dry = p.run(cwd, ["init", ...flags, "--dry-run", "--json"]);
  expect(dry.exitCode, out(dry)).toBe(0);
  expect(existsSync(join(cwd, ".agenthub"))).toBe(false);
  expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
  const preview = JSON.parse(dry.stdout.toString()) as { changes: { path: string }[]; settings: { key: string; file: string; from?: unknown; to: unknown }[] };
  expect(preview.settings).toEqual([
    { key: "start.agents", file: "config.local.json", to: ["codex"] },
    { key: "sdlc.mode", file: "sdlc.toml", from: "off", to: "advise" },
    { key: "coordination", file: "config.json", to: "turn-free" },
    { key: "memory.enabled", file: "config.json", from: true, to: false },
    { key: "pi.enabled", file: "config.json", from: false, to: true },
  ]);
  expect(preview.changes.map(change => change.path.replace(cwd, ""))).toEqual(expect.arrayContaining(["/.agenthub/config.json", "/.agenthub/config.local.json", "/.agenthub/sdlc.toml"]));
  expect(p.run(cwd, ["init", ...flags]).exitCode).toBe(0);
  // The write did exactly what the preview said.
  const config = p.json(cwd, "config.json");
  expect([config.coordination, config.memory.enabled, config.pi.enabled]).toEqual(["turn-free", false, true]);
  expect(p.json(cwd, "config.local.json").start.agents).toEqual(["codex"]);
  expect(p.text(cwd, "sdlc.toml")).toBe('mode = "advise"\n');
});

test("without a settings flag the dry-run JSON is the bare list it always was, and the human preview lists old -> new (#1065 AC1)", () => {
  const p = fixture(), cwd = p.repo("plain");
  const plain = JSON.parse(p.run(cwd, ["init", "--dry-run", "--json"]).stdout.toString());
  expect(Array.isArray(plain)).toBe(true);
  const human = p.run(cwd, ["init", "--no-memory", "--dry-run"]).stdout.toString();
  expect(human).toContain('memory.enabled: true -> false (config.json)');
  expect(existsSync(join(cwd, ".agenthub"))).toBe(false);
});

test("--sdlc off on a new project writes no sdlc.toml, and nothing else changes (#1065 AC1)", () => {
  const p = fixture(), cwd = p.repo("off");
  expect(p.run(cwd, ["init", "--sdlc", "off"]).exitCode).toBe(0);
  expect(existsSync(join(cwd, ".agenthub/sdlc.toml"))).toBe(false);
  const preview = JSON.parse(p.run(p.repo("off2"), ["init", "--sdlc", "off", "--dry-run", "--json"]).stdout.toString());
  expect(preview.settings).toEqual([]);
});

// ---- AC2: an existing project changes only what a flag names, shows old and new, keeps formatting, and a flag equal to the value is a no-op ----

const formatted = '{\n  "watchdog_ms": 300000,\n  "memory": { "enabled": true, "inject_tokens": 2000 },\n  "pi": {"enabled":false,"auto_start":false},\n  "roles": {\n    "claude": ["planner", "reviewer"]\n  }\n}\n';

test("on an existing project an explicit flag shows a modify row with old and new values and writes only that key (#1065 AC2)", () => {
  const p = fixture(), cwd = p.repo("existing");
  expect(p.run(cwd, ["init"]).exitCode).toBe(0);
  writeFileSync(join(cwd, ".agenthub/config.json"), formatted);
  const before = p.tree(cwd);
  const dry = JSON.parse(p.run(cwd, ["init", "--no-memory", "--coordination", "turn-free", "--dry-run", "--json"]).stdout.toString());
  expect(dry.settings).toEqual([
    { key: "coordination", file: "config.json", to: "turn-free" },
    { key: "memory.enabled", file: "config.json", from: true, to: false },
  ]);
  expect(dry.changes.find((change: { path: string }) => change.path.endsWith("config.json"))).toMatchObject({ action: "modify" });
  expect(p.tree(cwd)).toEqual(before); // the preview wrote nothing
  expect(p.run(cwd, ["init", "--no-memory", "--coordination", "turn-free"]).exitCode).toBe(0);
  // Every byte outside the two changed keys is as the person wrote it, including the compact `pi` object and the one-line memory object.
  expect(p.text(cwd, "config.json")).toBe(formatted.replace('"enabled": true', '"enabled": false').replace('  }\n}\n', '  },\n  "coordination": "turn-free"\n}\n'));
  expect(p.tree(cwd)["config.local.json"]).toBeUndefined();
});

test("a flag equal to the current value is a no-op: no row, no write (#1065 AC2)", () => {
  const p = fixture(), cwd = p.repo("noop");
  expect(p.run(cwd, ["init"]).exitCode).toBe(0);
  writeFileSync(join(cwd, ".agenthub/config.json"), formatted);
  const before = p.tree(cwd);
  const dry = JSON.parse(p.run(cwd, ["init", "--memory", "--no-pi", "--coordination", "advisory", "--sdlc", "off", "--dry-run", "--json"]).stdout.toString());
  expect(dry.settings).toEqual([]);
  const run = p.run(cwd, ["init", "--memory", "--no-pi", "--coordination", "advisory", "--sdlc", "off"]);
  expect(run.exitCode, out(run)).toBe(0);
  expect(p.tree(cwd)).toEqual(before);
  expect(existsSync(join(cwd, ".agenthub/sdlc.toml"))).toBe(false);
});

test("without a flag an existing project keeps every setting: re-running init changes none of them (#1065 AC2)", () => {
  const p = fixture(), cwd = p.repo("keep");
  expect(p.run(cwd, ["init", "--coordination", "turn-free", "--no-memory", "--agents", "claude", "--sdlc", "enforce"]).exitCode).toBe(0);
  const before = p.tree(cwd);
  expect(p.run(cwd, ["init"]).exitCode).toBe(0);
  expect(p.tree(cwd)).toEqual(before);
});

test("an existing sdlc.toml keeps its other lines when the mode changes, and an existing config.local.json keeps its other keys (#1065 AC2)", () => {
  const p = fixture(), cwd = p.repo("keys");
  expect(p.run(cwd, ["init"]).exitCode).toBe(0);
  writeFileSync(join(cwd, ".agenthub/sdlc.toml"), '# the team gate\nmode = "advise"\nrequired_checks = ["unit"]\n');
  writeFileSync(join(cwd, ".agenthub/config.local.json"), '{\n  "codex_bin": "codex",\n  "start": { "agents": ["claude"] }\n}\n');
  const dry = JSON.parse(p.run(cwd, ["init", "--sdlc", "enforce", "--agents", "claude,codex", "--dry-run", "--json"]).stdout.toString());
  expect(dry.settings).toEqual([
    { key: "start.agents", file: "config.local.json", from: ["claude"], to: ["claude", "codex"] },
    { key: "sdlc.mode", file: "sdlc.toml", from: "advise", to: "enforce" },
  ]);
  expect(p.run(cwd, ["init", "--sdlc", "enforce", "--agents", "claude,codex"]).exitCode).toBe(0);
  expect(p.text(cwd, "sdlc.toml")).toBe('# the team gate\nmode = "enforce"\nrequired_checks = ["unit"]\n');
  expect(p.text(cwd, "config.local.json")).toBe('{\n  "codex_bin": "codex",\n  "start": { "agents": ["claude", "codex"] }\n}\n');
});

test("changing the profile on an existing project stays refused, with or without settings flags (#1065 AC2)", () => {
  const p = fixture(), cwd = p.repo("profile");
  expect(p.run(cwd, ["init"]).exitCode).toBe(0);
  const refused = p.run(cwd, ["init", "--profile", "research", "--no-memory"]);
  expect(refused.exitCode).not.toBe(0);
  expect(out(refused)).toContain("init profile differs from existing config");
  expect(p.json(cwd, "config.json").memory.enabled).toBe(true);
});

// ---- AC3: an invalid value is refused with the allowed values, and nothing is written ----

test("an invalid value is refused with the allowed values and nothing is written (#1065 AC3)", () => {
  const p = fixture();
  const cases: [string[], RegExp][] = [
    [["--agents", "ghost"], /ghost cannot be started by ahub up.*allowed: .*claude.* or none.*nothing was written/s],
    [["--agents", "claude,claude"], /distinct peer ids/],
    [["--sdlc", "loud"], /--sdlc: "loud" is not off, advise, enforce; nothing was written/],
    [["--coordination", "chaos"], /--coordination: "chaos" is not advisory, turn-free; nothing was written/],
    [["--autonomy", "maybe"], /--autonomy: "maybe" is not inherit, off; nothing was written/],
    [["--sdlc"], /--sdlc needs a value: off\|advise\|enforce; nothing was written/],
    [["--memory", "--no-memory"], /conflicts with another flag for memory\.enabled; give one/],
    [["--sdlc", "advise", "--sdlc", "enforce"], /conflicts with another flag for sdlc\.mode/],
  ];
  for (const [flags, message] of cases) {
    const cwd = p.repo(`bad-${flags.join("").replace(/\W/g, "")}`);
    const result = p.run(cwd, ["init", ...flags]);
    expect(result.exitCode, flags.join(" ")).not.toBe(0);
    expect(out(result), flags.join(" ")).toMatch(message);
    expect(existsSync(join(cwd, ".agenthub")), `${flags.join(" ")} wrote .agenthub`).toBe(false);
    expect(existsSync(join(cwd, "AGENTS.md")), `${flags.join(" ")} wrote AGENTS.md`).toBe(false);
  }
});

test("a refusal on an existing project leaves every file as it was (#1065 AC3)", () => {
  const p = fixture(), cwd = p.repo("refuse-existing");
  expect(p.run(cwd, ["init"]).exitCode).toBe(0);
  const before = p.tree(cwd);
  expect(p.run(cwd, ["init", "--no-memory", "--coordination", "chaos"]).exitCode).not.toBe(0);
  expect(p.tree(cwd)).toEqual(before);
});

test("a config file the editor cannot change safely is refused with the next step, and nothing is written (#1065 AC3)", () => {
  const p = fixture(), cwd = p.repo("hostile");
  expect(p.run(cwd, ["init"]).exitCode).toBe(0);
  writeFileSync(join(cwd, ".agenthub/config.local.json"), "{ not json");
  const before = p.tree(cwd);
  const result = p.run(cwd, ["init", "--agents", "claude"]);
  expect(result.exitCode).not.toBe(0);
  expect(out(result)).toMatch(/config\.local\.json is not valid JSON; fix it in your editor, then run ahub init again; nothing was written/);
  expect(p.tree(cwd)).toEqual(before);
  writeFileSync(join(cwd, ".agenthub/config.local.json"), "{}\n");
  writeFileSync(join(cwd, ".agenthub/config.json"), '{ "memory": 5 }\n');
  const scalar = p.run(cwd, ["init", "--no-memory"]);
  expect(scalar.exitCode).not.toBe(0);
  expect(out(scalar)).toMatch(/memory in the project config is not an object.*nothing was written/s);
});

test("the daemon's loader judges the files before any write: a request it would refuse writes nothing (#1065 AC3)", () => {
  const p = fixture(), cwd = p.repo("loader");
  expect(p.run(cwd, ["init"]).exitCode).toBe(0);
  // `coordination` passes the closed set; make the candidate invalid some other way so the loader's own check is what refuses it.
  writeFileSync(join(cwd, ".agenthub/config.json"), JSON.stringify({ ...p.json(cwd, "config.json"), budget: { gate: "not a number" } }, null, 2) + "\n");
  const before = p.tree(cwd);
  const result = p.run(cwd, ["init", "--coordination", "turn-free"]);
  expect(result.exitCode).not.toBe(0);
  expect(out(result)).toContain("do not pass the hub's config check");
  expect(out(result)).toContain("nothing was written");
  expect(p.tree(cwd)).toEqual(before);
});

// ---- AC6: --agents none overrides the machine default, --autonomy off skips inheritance ----

function machineDefaults(p: ReturnType<typeof fixture>, doc: object) {
  mkdirSync(p.home, { recursive: true, mode: 0o700 });
  writeFileSync(join(p.home, "defaults.json"), JSON.stringify(doc), { mode: 0o600 });
}

test("--agents none gives start.agents: [] and overrides the machine default; without it the machine default is inherited (#1065 AC6)", () => {
  const p = fixture();
  machineDefaults(p, { schema: 1, start: { agents: ["claude", "codex"] } });
  const inherited = p.repo("inherited");
  expect(p.run(inherited, ["init"]).exitCode).toBe(0);
  expect(p.json(inherited, "config.local.json").start.agents).toEqual(["claude", "codex"]);
  const none = p.repo("none");
  const result = p.run(none, ["init", "--agents", "none"]);
  expect(result.exitCode, out(result)).toBe(0);
  expect(p.json(none, "config.local.json")).toEqual({ start: { agents: [] } });
  const named = p.repo("named");
  expect(p.run(named, ["init", "--agents", "codex"]).exitCode).toBe(0);
  expect(p.json(named, "config.local.json").start.agents).toEqual(["codex"]);
});

test("--autonomy off skips the autonomy inheritance on a new project, and inherit keeps today's behaviour (#1065 AC6)", () => {
  const p = fixture();
  machineDefaults(p, { schema: 1, autonomy: true });
  const inherit = p.repo("inherit");
  const inherited = p.run(inherit, ["init"]);
  expect(inherited.exitCode, out(inherited)).toBe(0);
  expect(inherited.stdout.toString()).toContain("Inherited the trusted machine autonomy default");
  expect(p.json(inherit, "config.local.json").permission_modes).toBeDefined();
  const off = p.repo("off");
  const skipped = p.run(off, ["init", "--autonomy", "off"]);
  expect(skipped.exitCode, out(skipped)).toBe(0);
  expect(skipped.stdout.toString()).not.toContain("Inherited the trusted machine autonomy default");
  expect(existsSync(join(off, ".agenthub/config.local.json"))).toBe(false);
  const explicit = p.repo("explicit");
  expect(p.run(explicit, ["init", "--autonomy", "inherit"]).stdout.toString()).toContain("Inherited the trusted machine autonomy default");
  // The preview agrees with the write.
  const preview = JSON.parse(p.run(p.repo("preview"), ["init", "--autonomy", "off", "--dry-run", "--json"]).stdout.toString());
  expect(JSON.stringify(preview)).not.toContain("inherit the trusted machine autonomy preset");
  expect(JSON.stringify(JSON.parse(p.run(p.repo("preview2"), ["init", "--dry-run", "--json"]).stdout.toString()))).toContain("inherit the trusted machine autonomy preset");
});

test("--autonomy on an existing project changes nothing and says so (#1065 AC6)", () => {
  const p = fixture();
  machineDefaults(p, { schema: 1, autonomy: true });
  const cwd = p.repo("existing-auto");
  expect(p.run(cwd, ["init", "--autonomy", "off"]).exitCode).toBe(0);
  const before = p.tree(cwd);
  const again = p.run(cwd, ["init", "--autonomy", "off"]);
  expect(again.exitCode).toBe(0);
  expect(again.stderr.toString()).toContain("applies to a new project only");
  expect(p.tree(cwd)).toEqual(before);
});

// ---- AC7: help lists every flag ----

test("the ahub init help entry lists every settings flag and the old ones (#1065 AC7)", () => {
  const entry = HELP.find(row => row.usage.startsWith("ahub init "))!;
  expect(entry).toBeDefined();
  for (const flag of [...INIT_SETTING_FLAGS, "--profile", "--shadow", "--release-guard", "--dry-run", "--json"]) expect(entry.usage, flag).toContain(flag);
  expect(entry.description).toContain("old -> new");
  expect(entry.description).toContain("Executables, secrets, models and permissions stay file edits");
});

// ---- the pure parts ----

test("the planner reads only the files it is given and is the one place the table is applied (#1065)", () => {
  const request = parseInitSettings(["--coordination", "turn-free", "--no-pi", "--agents", "none"]).request;
  const plan = planInitSettings(request, { "config.json": formatted, "config.local.json": null, "sdlc.toml": null });
  expect(plan.rows.map(row => row.key)).toEqual(["start.agents", "coordination"]); // pi is already off: no row
  expect(plan.next["config.json"]).toBe(formatted.replace('  }\n}\n', '  },\n  "coordination": "turn-free"\n}\n'));
  expect(JSON.parse(plan.next["config.local.json"]!)).toEqual({ start: { agents: [] } });
  expect(plan.next["sdlc.toml"]).toBeUndefined();
});

test("editJsonText changes one key and keeps every other byte, including strings that hold braces and quotes and CRLF endings (#1065 AC2)", () => {
  const tricky = '{\r\n  "note": "a } \\" , {",\r\n  "pi": { "enabled": false },\r\n  "n": 1\r\n}\r\n';
  expect(editJsonText(tricky, ["pi", "enabled"], true)).toBe(tricky.replace("false", "true"));
  expect(editJsonText('{ "memory": { "enabled": true } }\n', ["memory", "extra"], 1)).toBe('{ "memory": { "enabled": true, "extra": 1 } }\n');
  expect(editJsonText('{\n  "a": 1\n}\n', ["start", "agents"], ["claude"])).toBe('{\n  "a": 1,\n  "start": {\n    "agents": ["claude"]\n  }\n}\n');
  expect(editJsonText("{}\n", ["coordination"], "turn-free")).toBe('{\n  "coordination": "turn-free"\n}\n');
  expect(() => editJsonText('{ "memory": 5 }', ["memory", "enabled"], true)).toThrow("not an object");
});

test("the table is the extension point: each row names its flag, file, key path and allowed values (#1065, for #1064 T3)", () => {
  for (const row of INIT_SETTINGS) {
    expect(row.flags.length).toBeGreaterThan(0);
    expect(["config.json", "config.local.json", "sdlc.toml"]).toContain(row.file);
    expect(row.path.length).toBeGreaterThan(0);
    expect(row.allowed.length).toBeGreaterThan(0);
  }
  expect(INIT_SETTINGS.map(row => row.id)).toEqual(["start.agents", "sdlc.mode", "coordination", "memory.enabled", "snapshots.enabled", "pi.enabled"]);
});

test("planInit and initSettingRows agree, and neither writes (#1065 AC1)", () => {
  const p = fixture(), cwd = p.repo("api");
  const request = parseInitSettings(["--no-snapshots", "--coordination", "turn-free"]).request;
  const rows = initSettingRows(cwd, undefined, false, false, request);
  expect(rows.map(row => row.key)).toEqual(["coordination", "snapshots.enabled"]);
  expect(planInit(cwd, undefined, false, false, request).some(change => change.path.endsWith("config.json"))).toBe(true);
  expect(existsSync(join(cwd, ".agenthub"))).toBe(false);
  init(cwd, undefined, false, false, request);
  expect(JSON.parse(readFileSync(join(cwd, ".agenthub/config.json"), "utf8")).snapshots.enabled).toBe(false);
});
