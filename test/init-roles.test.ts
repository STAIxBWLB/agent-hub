import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubGitSync } from "../src/hub/git.ts";
import { initNextSteps, initSettingRows } from "../src/cli/init.ts";
import { HELP } from "../src/cli/help.ts";
import { initQuestions, questionLine } from "../src/cli/init-prompt.ts";
import { eligiblePeers, installedPeers, parseRoleFlag, planRoles, roleSummaryLines } from "../src/cli/init-roles.ts";
import { parseInitSettings } from "../src/cli/init-settings.ts";
import { loadConductorPolicy } from "../src/hub/daemon.ts";
import { rolesRow } from "../src/cli/role-doctor.ts";
import { loadConfig } from "../src/hub/daemon.ts";
import { readInstanceConfigLayers, readInstanceRoleConfig } from "../src/hub/instance-config.ts";
import { startModeOf } from "../src/hub/start-mode.ts";
import { rosterAllows } from "../src/hub/roster.ts";

// #1408 T2 (R3): `ahub init --conductor`, `--planner`, `--reviewer`. AC1, AC2, AC4, AC5, AC8.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ahub-init-roles-")); roots.push(root);
  const user = join(root, "user"), home = join(root, "hub"); mkdirSync(user);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("AGENTHUB_") || key.startsWith("CODEX_") || key === "CLAUDECODE" || key === "CLAUDE_CODE_SESSION_ID" || key.startsWith("ORCA_") || key === "CI") delete env[key];
  Object.assign(env, { HOME: user, AGENTHUB_HOME: home, CLAUDE_CONFIG_DIR: join(user, "claude"), AMEM_HOME: join(root, "memory"), GIT_CONFIG_GLOBAL: "/dev/null" });
  const repo = (name: string) => { const cwd = join(root, name); mkdirSync(cwd); expect(hubGitSync(["init", "-q"], { cwd, env, encoding: "utf8", timeout: 3000 }).status).toBe(0); return cwd; };
  const run = (cwd: string, args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli/main.ts"), ...args], { cwd, env, stdout: "pipe", stderr: "pipe", timeout: 20000 });
  const text = (cwd: string, name: string) => readFileSync(join(cwd, ".agenthub", name), "utf8");
  const json = (cwd: string, name: string) => JSON.parse(text(cwd, name));
  return { root, repo, run, text, json };
}
const out = (result: { stdout: Buffer; stderr: Buffer }) => `${result.stdout.toString()}${result.stderr.toString()}`;
const holders = (roles: Record<string, string[]>, role: string) => Object.keys(roles).filter(peer => roles[peer]!.includes(role)).sort();
/** The roles as the running hub's loader settles them, the same read `ahub doctor` makes. */
const settled = (cwd: string) => loadConductorPolicy(cwd).roles;

// ---- AC1: the three flags on a new project ----

test("AC1: --conductor codex --planner codex --reviewer claude writes exactly those roles, claude no longer plans, and the doctor row shows the three holders", () => {
  const p = fixture(), cwd = p.repo("new");
  const done = p.run(cwd, ["init", "--conductor", "codex", "--planner", "codex", "--reviewer", "claude", "--autonomy", "off"]);
  expect(done.exitCode, out(done)).toBe(0);
  const roles = p.json(cwd, "config.json").roles as Record<string, string[]>;
  expect(roles.claude).toEqual(["reviewer"]);                      // the peer that loses a role is written too: a missing entry would keep its default
  expect(roles.codex).toEqual(["implementer", "planner", "conductor"]);
  expect(roles.kimi).toEqual(["implementer", "verifier"]);        // untouched peers keep the template's lists
  expect(holders(settled(cwd), "conductor")).toEqual(["codex"]);
  expect(holders(settled(cwd), "planner")).toEqual(["codex"]);
  expect(holders(settled(cwd), "reviewer")).toEqual(["claude"]);
  // the doctor row, read the way `ahub doctor` reads it
  const config = loadConfig(cwd), scope = readInstanceRoleConfig(cwd), layers = readInstanceConfigLayers(cwd);
  const modes: Record<string, "tui" | "headless"> = {};
  for (const layer of layers) for (const [peer, block] of Object.entries((layer.raw.peers ?? {}) as Record<string, { start_mode?: "tui" | "headless" }>)) if (block.start_mode) modes[peer] = block.start_mode;
  const row = rolesRow({ roles: config.roles, startMode: peer => modes[peer] ?? startModeOf(config.peers, peer, scope.instances, scope.catalog), rostered: peer => rosterAllows(config.roster, peer, config.pi.enabled, scope.instances, scope.catalog) });
  expect(row.detail).toContain("conductor codex");
  expect(row.detail).toContain("planner codex");
  expect(row.detail).toContain("reviewer claude");
});

// ---- AC2: each flag alone changes only its role; no flag changes nothing ----

test("AC2: each flag alone changes only its own role, and a flagless init writes the shipped roles", () => {
  const shipped = JSON.parse(readFileSync(join(import.meta.dir, "../templates/config.json"), "utf8")).roles as Record<string, string[]>;
  const p = fixture();
  const plain = p.repo("plain");
  expect(p.run(plain, ["init", "--autonomy", "off"]).exitCode).toBe(0);
  expect(p.json(plain, "config.json").roles).toEqual(shipped);
  const cases: [string[], Record<string, string[]>][] = [
    [["--conductor", "codex"], { codex: ["implementer", "conductor"] }],
    [["--planner", "codex"], { claude: ["reviewer"], codex: ["implementer", "planner"] }],
    [["--reviewer", "codex"], { claude: ["planner"], codex: ["implementer", "reviewer"] }],
  ];
  for (const [flags, changed] of cases) {
    const cwd = p.repo(flags[0]!.slice(2));
    const done = p.run(cwd, ["init", ...flags, "--autonomy", "off"]);
    expect(done.exitCode, out(done)).toBe(0);
    expect(p.json(cwd, "config.json").roles, flags.join(" ")).toEqual({ ...shipped, ...changed });
  }
});

test("AC2/AC8: on an existing project a flag changes only its role, the other lists and every other file stay byte for byte, and an init with no flag changes nothing", () => {
  const p = fixture(), cwd = p.repo("existing");
  expect(p.run(cwd, ["init", "--autonomy", "off"]).exitCode).toBe(0);
  const before = { config: p.text(cwd, "config.json"), routing: p.text(cwd, "routing.toml"), agents: readFileSync(join(cwd, "AGENTS.md"), "utf8") };
  const again = p.run(cwd, ["init"]);
  expect(out(again)).toContain("already up to date");
  expect(p.text(cwd, "config.json")).toBe(before.config);
  expect(p.run(cwd, ["init", "--reviewer", "person"]).exitCode).toBe(0);
  const after = p.json(cwd, "config.json");
  expect(after.roles).toEqual({ ...JSON.parse(before.config).roles, claude: ["planner"] });
  expect(p.text(cwd, "routing.toml")).toBe(before.routing);
  expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toBe(before.agents);
  // everything outside `roles` is the template's bytes
  const strip = (text: string) => text.replace(/"roles": \{[\s\S]*?\n  \},?\n/, "");
  expect(strip(p.text(cwd, "config.json"))).toBe(strip(before.config));
  // a second run with the same flag has nothing left to do
  expect(out(p.run(cwd, ["init", "--reviewer", "person"]))).toContain("already up to date");
});

test("AC8: an existing project's hand-written roles are untouched by a flagless init, and a choice rewrites only the peers whose roles change", () => {
  const p = fixture(), cwd = p.repo("hand");
  mkdirSync(join(cwd, ".agenthub"));
  const hand = { roles: { claude: ["planner", "reviewer"], codex: ["conductor", "implementer"], kimi: ["verifier"] }, memory: { enabled: false } };
  writeFileSync(join(cwd, ".agenthub", "config.json"), `${JSON.stringify(hand, null, 2)}\n`);
  expect(p.run(cwd, ["init", "--autonomy", "off"]).exitCode).toBe(0);
  expect(p.json(cwd, "config.json").roles).toEqual(hand.roles);
  expect(p.run(cwd, ["init", "--conductor", "claude"]).exitCode).toBe(0);
  expect(p.json(cwd, "config.json").roles).toEqual({ claude: ["planner", "reviewer", "conductor"], codex: ["implementer"], kimi: ["verifier"] });
});

// ---- AC4: an ineligible choice is refused before any write, with the reason and the eligible choices ----

test("AC4: an ineligible conductor, planner or reviewer is refused before any write with the reason and the eligible peers", () => {
  const p = fixture(), cwd = p.repo("refused");
  for (const [flags, reason, eligible] of [
    [["--conductor", "local"], "local cannot conduct", "eligible: claude, codex, pi, jcode"],
    [["--conductor", "kimi"], "kimi cannot conduct", "eligible: claude, codex, pi, jcode"],
    [["--conductor", "qwen"], "qwen cannot conduct", "eligible: claude, codex, pi, jcode"],
    [["--planner", "pi"], "pi cannot plan", "eligible: claude, codex, kimi, qwen, jcode"],
    [["--planner", "claude,local"], "local cannot plan", "eligible: claude, codex, kimi, qwen, jcode"],
    [["--reviewer", "agy"], "agy cannot receive hub_review", "eligible: claude, codex, kimi, pi, local, qwen, jcode"],
  ] as const) {
    const refused = p.run(cwd, ["init", ...flags]);
    const text = out(refused);
    expect(refused.exitCode, flags.join(" ")).toBe(1);
    expect(text, flags.join(" ")).toContain(reason);
    expect(text, flags.join(" ")).toContain(eligible);
    expect(text, flags.join(" ")).toContain("nothing was written");
    expect(existsSync(join(cwd, ".agenthub")), flags.join(" ")).toBe(false);
    expect(existsSync(join(cwd, "AGENTS.md")), flags.join(" ")).toBe(false);
  }
});

test("AC3/AC4: a conductor that starts headless here is refused naming the start-mode setting, and the same peer is accepted once it starts interactively", () => {
  const p = fixture(), cwd = p.repo("headless");
  mkdirSync(join(cwd, ".agenthub"));
  writeFileSync(join(cwd, ".agenthub", "config.json"), `${JSON.stringify({ peers: { codex: { start_mode: "headless" } } }, null, 2)}\n`);
  const refused = p.run(cwd, ["init", "--conductor", "codex"]);
  expect(refused.exitCode).toBe(1);
  expect(out(refused)).toContain("codex starts headless");
  expect(out(refused)).toContain("ahub settings set peers.codex.start_mode tui");
  // config.local.json wins over the shared file, as the loader reads it
  writeFileSync(join(cwd, ".agenthub", "config.local.json"), `${JSON.stringify({ peers: { codex: { start_mode: "tui" } } }, null, 2)}\n`);
  expect(p.run(cwd, ["init", "--conductor", "codex"]).exitCode, out(p.run(cwd, ["init", "--conductor", "codex", "--dry-run"]))).toBe(0);
  expect(holders(settled(cwd), "conductor")).toEqual(["codex"]);
});

test("a choice refused for config.local.json or a planner setting that would outrank it is refused before any write", () => {
  const p = fixture(), cwd = p.repo("outranked");
  mkdirSync(join(cwd, ".agenthub"));
  writeFileSync(join(cwd, ".agenthub", "config.json"), `${JSON.stringify({ planner: "claude" }, null, 2)}\n`);
  const planner = p.run(cwd, ["init", "--planner", "codex"]);
  expect(planner.exitCode).toBe(1);
  expect(out(planner)).toContain("outranks roles");
  writeFileSync(join(cwd, ".agenthub", "config.json"), `${JSON.stringify({ roles: { claude: ["planner", "reviewer"] } }, null, 2)}\n`);
  writeFileSync(join(cwd, ".agenthub", "config.local.json"), `${JSON.stringify({ roles: { claude: ["planner"] } }, null, 2)}\n`);
  const local = p.run(cwd, ["init", "--reviewer", "person"]);
  expect(local.exitCode).toBe(1);
  expect(out(local)).toContain("config.local.json roles.claude overrides");
  expect(JSON.parse(readFileSync(join(cwd, ".agenthub", "config.json"), "utf8")).roles).toEqual({ claude: ["planner", "reviewer"] });
});

// ---- AC5: --reviewer person and --conductor none are accepted and described ----

test("AC5: --reviewer person and --conductor none are accepted, write no reviewer or conductor peer, and the init summary describes them", () => {
  const p = fixture(), cwd = p.repo("person");
  const done = p.run(cwd, ["init", "--reviewer", "person", "--conductor", "none", "--autonomy", "off"]);
  expect(done.exitCode, out(done)).toBe(0);
  expect(out(done)).toContain("Reviewer: person. No peer holds the reviewer role, so reviews go to you.");
  expect(out(done)).toContain("Conductor: none. You conduct from ahub console.");
  const roles = settled(cwd);
  expect(holders(roles, "reviewer")).toEqual([]);
  expect(holders(roles, "conductor")).toEqual([]);
  // moving the conductor in one init writes both peers together, so the single-holder rule is never tripped
  const moved = p.repo("moved");
  expect(p.run(moved, ["init", "--conductor", "codex", "--autonomy", "off"]).exitCode).toBe(0);
  const swap = p.run(moved, ["init", "--conductor", "claude"]);
  expect(swap.exitCode, out(swap)).toBe(0);
  expect(p.json(moved, "config.json").roles).toMatchObject({ codex: ["implementer"], claude: ["planner", "reviewer", "conductor"] });
  expect(holders(settled(moved), "conductor")).toEqual(["claude"]);
});

// ---- dry-run rows, parser, helpers ----

test("--dry-run --json shows the role rows like the other settings, and writes nothing", () => {
  const p = fixture(), cwd = p.repo("dry");
  const dry = p.run(cwd, ["init", "--conductor", "codex", "--reviewer", "person", "--dry-run", "--json", "--autonomy", "off"]);
  expect(dry.exitCode, out(dry)).toBe(0);
  const shown = JSON.parse(dry.stdout.toString());
  expect(shown.settings).toEqual([
    { key: "roles.claude", file: "config.json", from: ["planner", "reviewer"], to: ["planner"] },
    { key: "roles.codex", file: "config.json", from: ["implementer"], to: ["implementer", "conductor"] },
  ]);
  expect(existsSync(join(cwd, ".agenthub"))).toBe(false);
  const rows = initSettingRows(cwd, undefined, false, false, parseInitSettings(["--planner", "codex,qwen"]).request);
  expect(rows.map(row => row.key)).toEqual(["roles.claude", "roles.codex", "roles.qwen"]);
});

test("parseRoleFlag reads each shape and refuses the rest naming what is accepted", () => {
  expect(parseRoleFlag("--conductor", "codex")).toBe("codex");
  expect(parseRoleFlag("--conductor", "none")).toBe("none");
  expect(parseRoleFlag("--planner", "codex, claude")).toEqual(["codex", "claude"]);
  expect(parseRoleFlag("--reviewer", "person")).toBe("person");
  expect(parseRoleFlag("--reviewer", "kimi,codex")).toEqual(["kimi", "codex"]);
  for (const [flag, text, reason] of [
    ["--conductor", "codex,claude", "at most one conductor"], ["--conductor", "nobody", "is not a peer or none"], ["--planner", "codex,codex", "named twice"],
    ["--planner", "none", "is not a peer"], ["--reviewer", "person,claude", "stands alone"], ["--planner", "", "needs a value"],
  ] as const) expect(() => parseRoleFlag(flag, text), `${flag} ${text}`).toThrow(reason);
  expect(() => parseInitSettings(["--conductor"])).toThrow("--conductor needs a value");
  expect(() => parseInitSettings(["--conductor", "codex", "--conductor", "claude"])).toThrow("conflicts with another flag");
  expect(parseInitSettings(["--conductor", "codex", "--agents", "claude"]).request.values).toEqual({ "roles.conductor": "codex", "start.agents": ["claude"] });
});

test("planRoles changes only what the choices change and never touches implementer, verifier or another peer", () => {
  expect(planRoles({}, {}, {})).toEqual([]);
  expect(planRoles({ "roles.reviewer": ["claude"] }, {}, {})).toEqual([]);                                   // already holds: no change
  expect(planRoles({ "roles.conductor": "none" }, {}, {})).toEqual([]);
  const changes = planRoles({ "roles.planner": ["jcode", "qwen"], "roles.reviewer": ["kimi"] }, {}, {});
  expect(changes.map(change => change.peer).sort()).toEqual(["claude", "jcode", "kimi", "qwen"]);
  for (const change of changes) {
    for (const kept of ["implementer", "verifier"]) expect(change.to.includes(kept), `${change.peer} ${kept}`).toBe(change.from.includes(kept));
  }
  expect(changes.find(change => change.peer === "claude")).toEqual({ peer: "claude", from: ["planner", "reviewer"], to: [] });
  // a peer the project added to roles keeps its other roles and loses only the moved one
  expect(planRoles({ "roles.conductor": "codex" }, { roles: { claude: ["conductor", "planner"], codex: ["implementer"], extra: ["implementer"] } }, {}))
    .toEqual([{ peer: "claude", from: ["conductor", "planner"], to: ["planner"] }, { peer: "codex", from: ["implementer"], to: ["implementer", "conductor"] }]);
});

test("the guided questions offer only the peers that can hold each role, installed agents first, with the shipped holders as the default", () => {
  const questions = initQuestions({ installedPeers: ["pi", "codex"] });
  const by = (id: string) => questionLine(questions.find(question => question.id === id)!);
  expect(by("roles.conductor")).toContain("(codex|pi|claude|jcode|none)");
  expect(by("roles.conductor")).toContain("[none]");
  expect(by("roles.planner")).toContain("codex,claude,kimi,qwen,jcode as a comma list");
  expect(by("roles.planner")).toContain("[claude]");
  expect(by("roles.reviewer")).toContain("or person");
  expect(by("roles.reviewer")).toContain("[claude]");
  expect(by("roles.conductor")).not.toMatch(/local|kimi|qwen|agy/);
  const ask = questions.find(question => question.id === "roles.conductor")!;
  expect(() => ask.read("local")).toThrow("local cannot be conductor here");
  expect(ask.read("none")).toBe("none");
  expect(ask.read("Codex")).toBe("codex");
  expect(() => questions.find(question => question.id === "roles.planner")!.read("pi")).toThrow("pi cannot be planner here");
  expect(eligiblePeers("conductor")).toEqual(["claude", "codex", "pi", "jcode"]);
  expect(eligiblePeers("conductor", () => undefined, ["jcode"])).toEqual(["jcode", "claude", "codex", "pi"]);
  expect(eligiblePeers("conductor", peer => peer === "codex" ? "headless" : undefined)).toEqual(["claude", "pi", "jcode"]);
});

test("installedPeers reads PATH through the inventory's binaries, and the local worker needs none", () => {
  expect(installedPeers(binary => binary === "codex" ? "/usr/bin/codex" : undefined)).toEqual(["codex", "local"]);
  expect(installedPeers(() => undefined)).toEqual(["local"]);
});

test("the init summary and help name the three flags", () => {
  expect(roleSummaryLines({ "roles.conductor": "codex", "roles.planner": ["codex", "claude"], "roles.reviewer": ["kimi"] })).toEqual([
    "- Conductor: codex. It must run interactively; ahub doctor shows who holds each role.", "- Planner: codex, claude.", "- Reviewer: kimi.",
  ]);
  expect(roleSummaryLines({})).toEqual([]);
  const entry = HELP.find(row => row.usage.startsWith("ahub init "))!;
  for (const flag of ["--conductor <peer>|none", "--planner <a,b,...>", "--reviewer <a,b,...>|person"]) expect(entry.usage).toContain(flag);
  expect(entry.description).toContain("--conductor none leaves the person conducting from ahub console");
  const cwd = mkdtempSync(join(tmpdir(), "ahub-init-roles-steps-")); roots.push(cwd);
  expect(initNextSteps(cwd, parseInitSettings(["--reviewer", "person"]).request).join("\n")).toContain("Reviewer: person");
});

test("the same module judges the init choice and the loader: a conductor init accepts is a conductor the loader keeps", () => {
  const p = fixture();
  for (const peer of ["claude", "codex", "jcode", "pi"]) {
    const cwd = p.repo(`keeps-${peer}`);
    expect(p.run(cwd, ["init", "--conductor", peer, "--autonomy", "off"]).exitCode, peer).toBe(0);
    expect(holders(settled(cwd), "conductor"), peer).toEqual([peer]);
  }
  for (const peer of ["kimi", "local", "qwen"]) expect(p.run(p.repo(`drops-${peer}`), ["init", "--conductor", peer]).exitCode, peer).toBe(1);
});
