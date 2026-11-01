import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAutonomyDefaults, writeAutonomyDefaults, writeMachineStartAgents } from "../src/hub/autonomy-defaults.ts";
import { checkSettingValue, parseSettingText, settingDef, settingRefusal } from "../src/hub/settings.ts";
import { DEFAULT_CONFIG, loadConfig } from "../src/hub/daemon.ts";
import { configApply, validateRawConfig } from "../src/hub/config-apply.ts";
import { START_AGENTS_ALLOWED, START_AGENTS_DEFAULT, checkStartAgents, parseStartAgents, startAgentRefusal } from "../src/hub/start-agents.ts";
import { effectiveStartAgents, inheritMachineStart, setupStartAgents, startLine } from "../src/cli/start-agents-run.ts";
import { realPath } from "../src/hub/project.ts";

// #608 (agent-hub#1040): the start.agents setting, its machine default and the setup and init that carry it. The `ahub up`
// behavior against a running hub is in start-agents-up.test.ts.
const clean: (() => void)[] = [];
afterEach(() => { for (const fn of clean.splice(0).reverse()) fn(); });
const temp = (name: string) => { const dir = realPath(mkdtempSync(join(tmpdir(), `ahub-sa-${name}-`))); clean.push(() => rmSync(dir, { recursive: true, force: true })); return dir; };
/** A git repository with `.agenthub/`, where `committed` names the files git tracks. */
function repo(files: Record<string, unknown>, committed: string[] = []) {
  const dir = temp("repo"), git = (...args: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@localhost", ...args]);
  git("init", "-q"); mkdirSync(join(dir, ".agenthub"));
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, ".agenthub", name), JSON.stringify(value));
  for (const name of committed) git("add", "-f", `.agenthub/${name}`);
  return dir;
}

test("the set is claude and codex unless chosen, and only hub-startable peers may be listed", () => {
  expect([...START_AGENTS_DEFAULT]).toEqual(["claude", "codex"]);
  expect(DEFAULT_CONFIG.start).toEqual({ agents: ["claude", "codex"] });
  expect(checkStartAgents(["kimi", "codex"])).toEqual(["kimi", "codex"]);
  expect(checkStartAgents([])).toEqual([]);                                         // an empty list is a value: start none
  for (const id of ["claude", "codex", "kimi", "pi", "local", "jcode"]) expect(START_AGENTS_ALLOWED).toContain(id);
  expect(START_AGENTS_ALLOWED).not.toContain("qwen"); expect(START_AGENTS_ALLOWED).not.toContain("agy");
});

test("AC7: qwen, a channel extra, a declared instance, an unknown or malformed id and a duplicate are each refused with a named reason", () => {
  expect(startAgentRefusal("qwen")).toContain("never opens its TUI");
  expect(startAgentRefusal("agy")).toContain("run ahub agy in a terminal");
  expect(startAgentRefusal("claude-reviewer")).toContain("declared instance, a channel extra or unknown");
  expect(startAgentRefusal("Not A Peer")).toContain("not a peer id");
  expect(startAgentRefusal(7)).toContain("not a peer id");
  expect(() => checkStartAgents(["claude", "qwen"])).toThrow("start.agents: qwen cannot be started by ahub up");
  expect(() => checkStartAgents(["claude", "claude"])).toThrow("distinct");
  expect(() => checkStartAgents("claude")).toThrow("takes a list");
  expect(() => checkStartAgents(Array.from({ length: 9 }, () => "x"))).toThrow("up to 8");
  // the settings writer says the same thing when the value is saved
  const def = settingDef("start.agents"); if (typeof def === "string") throw new Error(def);
  expect(() => checkSettingValue(def, ["codex", "qwen"])).toThrow("qwen cannot be started by ahub up");
  expect(checkSettingValue(def, ["codex", "kimi"])).toEqual(["codex", "kimi"]);
  expect(checkSettingValue(def, null)).toBeNull();                                  // inherit
  expect(parseSettingText(def, "none")).toEqual([]); expect(parseSettingText(def, "claude, codex")).toEqual(["claude", "codex"]);
  expect(parseStartAgents("kimi codex")).toEqual(["kimi", "codex"]); expect(parseStartAgents("none")).toEqual([]);
  expect(() => parseStartAgents("claude qwen")).toThrow("qwen");
});

test("start.agents is a Start-group settings row that raising needs a settings session for, and it applies at the next ahub up", () => {
  const def = settingDef("start.agents"); if (typeof def === "string") throw new Error(def);
  expect(def).toMatchObject({ group: "Start", type: "peers", store: "config", risk: "raises", path: ["start", "agents"] });
  expect(settingRefusal(def, ["claude", "codex"], "ordinary")).toContain("settings session");
  expect(settingRefusal(def, ["claude", "codex"], "settings")).toBeUndefined();
  expect(settingRefusal(def, ["claude", "codex"], "terminal")).toBeUndefined();
  expect(configApply("start.agents")).toMatchObject({ applies: "restart" });        // the running hub never reads it; a reload changes nothing live
});

test("AC3: a committed config.json cannot set the set; config.local.json can, and an empty list is kept as a value", () => {
  const committed = repo({ "config.json": { start: { agents: ["kimi"] } } }, ["config.json"]);
  const loaded = loadConfig(committed);
  expect(loaded.start.agents).toEqual(["claude", "codex"]);                           // dropped, the default applies
  expect(loaded.ignored?.join("\n")).toContain("start.agents in .agenthub/config.json ignored");
  const local = repo({ "config.json": {}, "config.local.json": { start: { agents: ["kimi", "codex"] } } }, ["config.json"]);
  expect(loadConfig(local).start.agents).toEqual(["kimi", "codex"]);
  const none = repo({ "config.json": {}, "config.local.json": { start: { agents: [] } } }, ["config.json"]);
  expect(loadConfig(none).start.agents).toEqual([]);                                   // not "the default": the person chose no agent
  // a bad list is refused by the loader and by the schema, with the reason
  const bad = repo({ "config.json": {}, "config.local.json": { start: { agents: ["qwen"] } } }, ["config.json"]);
  expect(() => loadConfig(bad)).toThrow("qwen cannot be started by ahub up");
  expect(() => validateRawConfig({ start: { agents: ["claude", "qwen"] } })).toThrow("start.agents");
  expect(() => validateRawConfig({ start: { agents: ["claude"], other: 1 } })).toThrow("unknown key");
  expect(() => validateRawConfig({ start: { agents: ["claude", "codex"] } })).not.toThrow();
});

test("the machine default lives in defaults.json next to the autonomy answer, each writer keeps the other half, and unsafe content is refused as before", () => {
  const home = join(temp("home"), "hub"), roots: string[] = [];
  expect(readAutonomyDefaults(home).startAgents).toBeUndefined();
  writeMachineStartAgents(home, ["kimi", "codex"], "absent", roots);
  const file = join(home, "defaults.json");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ schema: 1, start: { agents: ["kimi", "codex"] } });   // autonomy stays absent
  let held = readAutonomyDefaults(home, roots);
  expect(held).toMatchObject({ enabled: false, startAgents: ["kimi", "codex"] });
  writeAutonomyDefaults(home, true, held.fingerprint, roots);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ schema: 1, autonomy: true, start: { agents: ["kimi", "codex"] } });
  held = readAutonomyDefaults(home, roots);
  writeMachineStartAgents(home, [], held.fingerprint, roots);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ schema: 1, autonomy: true, start: { agents: [] } });
  expect(readAutonomyDefaults(home, roots)).toMatchObject({ enabled: true, startAgents: [] });
  // a stale preview, a bad list, a wider mode and an unknown key each leave the file alone and the default in force
  expect(() => writeMachineStartAgents(home, ["claude"], "absent", roots)).toThrow("unsafe or changed");
  expect(() => writeMachineStartAgents(home, ["qwen"], readAutonomyDefaults(home, roots).fingerprint, roots)).toThrow("qwen");
  chmodSync(file, 0o644);
  expect(readAutonomyDefaults(home, roots)).toMatchObject({ enabled: false, notice: expect.any(String) });
  expect(readAutonomyDefaults(home, roots).startAgents).toBeUndefined();
  chmodSync(file, 0o600);
  writeFileSync(file, JSON.stringify({ schema: 1, start: { agents: ["qwen"] } }), { mode: 0o600 });
  expect(readAutonomyDefaults(home, roots).notice).toBeDefined();
  writeFileSync(file, JSON.stringify({ schema: 1, start: { agents: ["claude"], extra: 1 } }), { mode: 0o600 });
  expect(readAutonomyDefaults(home, roots).notice).toBeDefined();
  writeFileSync(file, JSON.stringify({ schema: 1 }), { mode: 0o600 });                // a document that says nothing is not a document
  expect(readAutonomyDefaults(home, roots).notice).toBeDefined();
});

test("the project's own value wins over the machine's choice, which wins over claude and codex", () => {
  const home = join(temp("home"), "hub"), dir = repo({ "config.json": {} }, ["config.json"]);
  expect(effectiveStartAgents(dir, loadConfig(dir).start.agents, home, [dir])).toEqual({ agents: ["claude", "codex"], source: "default" });
  writeMachineStartAgents(home, ["kimi"], "absent", [dir]);
  expect(effectiveStartAgents(dir, loadConfig(dir).start.agents, home, [dir])).toEqual({ agents: ["kimi"], source: "machine" });
  writeFileSync(join(dir, ".agenthub", "config.local.json"), JSON.stringify({ start: { agents: [] } }));
  expect(effectiveStartAgents(dir, loadConfig(dir).start.agents, home, [dir])).toEqual({ agents: [], source: "project" });   // an empty project list starts none
});

test("AC4: setup --agents writes the machine default, an interactive answer writes the same, --yes and a run with no terminal keep the default and say so", async () => {
  const lines: string[] = [], roots: string[] = [];
  const run = async (opts: { flag?: string; yes?: boolean; ask?: (prompt: string) => Promise<string | null> }, home: string) =>
    setupStartAgents({ home, roots, yes: opts.yes === true, ...(opts.flag !== undefined ? { flag: opts.flag } : {}), ...(opts.ask ? { ask: opts.ask } : {}), print: line => lines.push(line) });
  const stored = (home: string) => readAutonomyDefaults(home, roots).startAgents;
  let home = join(temp("h1"), "hub");
  expect(await run({ flag: "kimi,codex" }, home)).toBeUndefined();
  expect(stored(home)).toEqual(["kimi", "codex"]);
  expect(lines.at(-1)).toContain("kimi, codex");
  // a bad --agents is refused with the reason and nothing is written
  home = join(temp("h2"), "hub");
  expect(await run({ flag: "claude,qwen" }, home)).toContain("qwen cannot be started by ahub up");
  expect(stored(home)).toBeUndefined();
  // --yes takes the default and writes it once; a later --yes keeps what is there
  home = join(temp("h3"), "hub");
  await run({ yes: true }, home); expect(stored(home)).toEqual(["claude", "codex"]);
  writeMachineStartAgents(home, ["pi"], readAutonomyDefaults(home, roots).fingerprint, roots);
  await run({ yes: true }, home); expect(stored(home)).toEqual(["pi"]);
  // no terminal and no flag: the default stays, nothing is written, and the line says how to choose
  home = join(temp("h4"), "hub"); lines.length = 0;
  await run({}, home); expect(stored(home)).toBeUndefined(); expect(lines.join("\n")).toContain("pass --agents <a,b> to choose");
  // a terminal is asked once: an answer is saved, an empty answer takes the default, a bad one asks again, an answer already saved is shown and not asked again
  home = join(temp("h5"), "hub");
  const prompts: string[] = [];
  await run({ ask: async prompt => { prompts.push(prompt); return prompts.length === 1 ? "claude qwen" : "codex, kimi"; } }, home);
  expect(prompts).toHaveLength(2); expect(prompts[0]).toContain("[claude, codex]"); expect(stored(home)).toEqual(["codex", "kimi"]);
  await run({ ask: async prompt => { prompts.push(prompt); return "claude"; } }, home);
  expect(prompts).toHaveLength(2); expect(stored(home)).toEqual(["codex", "kimi"]);
  home = join(temp("h6"), "hub");
  await run({ ask: async () => "" }, home); expect(stored(home)).toEqual(["claude", "codex"]);
  home = join(temp("h7"), "hub");
  await run({ ask: async () => "none" }, home); expect(stored(home)).toEqual([]);
});

test("AC4: init of a new project copies the machine default into config.local.json, keeps the project's own value, and never writes into a tracked file", () => {
  const home = join(temp("home"), "hub"), roots: string[] = [];
  expect(inheritMachineStart(repo({ "config.json": {} }, ["config.json"]), home, roots)).toEqual([]);                // no machine choice: nothing is written
  writeMachineStartAgents(home, ["kimi", "codex"], "absent", roots);
  const dir = repo({ "config.json": {} }, ["config.json"]);
  const lines = inheritMachineStart(dir, home, roots);
  expect(lines.join("\n")).toContain("kimi, codex");
  const file = join(dir, ".agenthub", "config.local.json");
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ start: { agents: ["kimi", "codex"] } });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(loadConfig(dir).start.agents).toEqual(["kimi", "codex"]);
  // an existing value is never replaced, and the other keys of the file are kept
  writeFileSync(file, JSON.stringify({ tasks: { auto_pull: false }, start: { agents: ["pi"] } }));
  expect(inheritMachineStart(dir, home, roots)).toEqual([]);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ tasks: { auto_pull: false }, start: { agents: ["pi"] } });
  writeFileSync(file, JSON.stringify({ tasks: { auto_pull: false } }));
  inheritMachineStart(dir, home, roots);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ tasks: { auto_pull: false }, start: { agents: ["kimi", "codex"] } });
  // a config.local.json that git tracks, or that is not an object, is left alone with a reason
  const tracked = repo({ "config.json": {}, "config.local.json": {} }, ["config.json", "config.local.json"]);
  expect(inheritMachineStart(tracked, home, roots).join("\n")).toContain("start.agents not copied");
  expect(JSON.parse(readFileSync(join(tracked, ".agenthub", "config.local.json"), "utf8"))).toEqual({});
  const odd = repo({ "config.json": {}, "config.local.json": [1] }, ["config.json"]);
  expect(inheritMachineStart(odd, home, roots).join("\n")).toContain("not a JSON object");
  expect(existsSync(join(odd, ".agenthub", "config.local.json"))).toBe(true);
});

test("each agent prints one line: started, already attached, or refused with the hub's own reason", () => {
  expect(startLine("claude", { ok: true, mode: "tui", opened: "terminal.open" })).toBe("claude: started tui (terminal.open), it attaches when its TUI is ready");
  expect(startLine("codex", { ok: true, already: true, mode: "tui" })).toBe("codex: already attached");
  expect(startLine("kimi", { ok: true, mode: "headless" })).toBe("kimi: started headless");
  expect(startLine("claude", { ok: false, error: "claude starts in its TUI and the hub could not open a terminal for it (no terminal.open command is configured). Run ahub claude in a terminal" }))
    .toBe("claude: not started: claude starts in its TUI and the hub could not open a terminal for it (no terminal.open command is configured). Run ahub claude in a terminal");
  expect(startLine("pi", { ok: false })).toBe("pi: not started: the hub refused");
});
