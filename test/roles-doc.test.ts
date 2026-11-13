import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUPPORTED_PEERS, definitionOf } from "../src/adapters/registry.ts";
import { eligibilityRows, renderEligibilityTable, roleEligibility } from "../src/adapters/role-eligibility.ts";
import { rolesRow } from "../src/cli/role-doctor.ts";
import { loadConfig } from "../src/hub/daemon.ts";
import { readInstanceRoleConfig } from "../src/hub/instance-config.ts";
import { rosterAllows } from "../src/hub/roster.ts";
import { resolveSettledRoles } from "../src/hub/settled-roles.ts";

// #1408 T3 (R4, AC7): docs/roles.md "Choosing who conducts, plans and reviews". Its eligibility table is the output of `roleEligibility`, and each combination it documents is what the real loader keeps.
const DOC = readFileSync(join(import.meta.dir, "../docs/roles.md"), "utf8");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const tableOf = (text: string) => text.split("<!-- eligibility-table:begin -->\n")[1]?.split("\n<!-- eligibility-table:end -->")[0];

test("AC7: the eligibility table in docs/roles.md equals roleEligibility's output, byte for byte", () => {
  expect(tableOf(DOC)).toBe(renderEligibilityTable());
});

test("AC7: the table has one row per builtin kind, and each cell is what roleEligibility says for that kind and form", () => {
  const rows = eligibilityRows();
  expect(rows.map(row => row.peer)).toEqual([...SUPPORTED_PEERS]);
  for (const row of rows) {
    const forms = definitionOf(row.peer)!.start.forms;
    expect(row.forms).toEqual([...forms]);
    expect(row.conductor).toEqual(forms.filter(form => roleEligibility(row.peer, "conductor", form).eligible));
    expect(row.planner, `${row.peer} planner`).toBe(roleEligibility(row.peer, "planner").eligible);
    expect(row.reviewer, `${row.peer} reviewer`).toBe(roleEligibility(row.peer, "reviewer").eligible);
    // a kind never conducts in a headless form
    expect(row.conductor.includes("headless"), `${row.peer} headless conductor`).toBe(false);
  }
  // the lines the document renders are those rows
  for (const row of rows) expect(DOC).toContain(`| ${row.peer} | ${row.forms.join(", ")} | ${row.conductor.length ? row.conductor.join(", ") : "no"} | ${row.planner ? "yes" : "no"} | ${row.reviewer ? "yes" : "no"} |`);
});

test("AC7: a changed eligibility fails the document comparison (a flipped planner cell is not the generated table)", () => {
  const generated = renderEligibilityTable();
  const flipped = generated.replace("| pi | tui, headless | tui | no |", "| pi | tui, headless | tui | yes |");
  expect(flipped).not.toBe(generated);
  expect(tableOf(DOC)).not.toBe(flipped);
});

const NONE = { claude: [], codex: [], kimi: [], qwen: [], jcode: [], pi: [], local: [] };
const roster = (...on: string[]) => Object.fromEntries(["claude", "codex", "kimi", "qwen", "jcode", "pi", "local"].map(peer => [peer, on.includes(peer)]));
const COMBINATIONS = {
  "open, agent-led": { config: { roster: roster("qwen", "jcode", "pi", "local"), roles: { ...NONE, jcode: ["planner", "conductor"], qwen: ["reviewer"], pi: ["implementer", "verifier"], local: ["implementer", "verifier", "reviewer"] } },
    conductor: ["jcode"], planner: ["jcode"], reviewer: ["local", "qwen"], row: "| open, agent-led |", grade: "fixture-proven" },
  "open, qwen-led": { config: { roster: roster("qwen", "jcode", "pi", "local"), roles: { ...NONE, qwen: ["planner", "conductor"], jcode: ["reviewer"], pi: ["implementer", "verifier"], local: ["implementer", "verifier", "reviewer"] } },
    conductor: [], planner: ["qwen"], reviewer: ["jcode", "local"], row: "| open, qwen-led |", grade: "fixture-proven" },
  "person-led": { config: { roster: roster("pi", "local"), roles: { ...NONE, pi: ["implementer", "verifier"], local: ["implementer", "verifier"] } },
    conductor: [], planner: [], reviewer: [], row: "| person-led |", grade: "fixture-proven" },
} as const;

for (const [name, combination] of Object.entries(COMBINATIONS)) {
  test(`AC7: the documented combination "${name}" is what the real loader keeps, and the document grades it`, () => {
    const dir = mkdtempSync(join(tmpdir(), "ahub-roles-doc-")); dirs.push(dir);
    mkdirSync(join(dir, ".agenthub"));
    writeFileSync(join(dir, ".agenthub", "config.json"), JSON.stringify({ ...combination.config, pi: { enabled: true }, memory: { enabled: false } }));
    const config = loadConfig(dir), scope = readInstanceRoleConfig(dir);
    const rostered = (peer: string) => rosterAllows(config.roster, peer, config.pi.enabled, scope.instances, scope.catalog);
    const settled = resolveSettledRoles(config.roles, config.planner, rostered, undefined);
    const holders = (role: string) => Object.keys(settled.roles).filter(peer => settled.roles[peer]!.includes(role)).sort();
    expect(holders("conductor"), "conductor").toEqual([...combination.conductor]);
    expect(holders("planner"), "planner").toEqual([...combination.planner]);
    expect(holders("reviewer"), "reviewer").toEqual([...combination.reviewer]);
    // no commercial service: none of claude, codex or kimi holds anything, and none is on the roster
    for (const commercial of ["claude", "codex", "kimi"]) expect(rostered(commercial), commercial).toBe(false);
    // the doctor row reads the same settled roles
    const row = rolesRow({ roles: config.roles, startMode: () => undefined, rostered });
    for (const role of ["conductor", "planner", "reviewer"] as const) {
      const names = holders(role);
      if (names.length) expect(row.detail, role).toContain(`${role} ${names.join(", ")}`);
    }
    // the document carries the combination with an evidence grade, and no row claims more than fixture-proven
    const line = DOC.split("\n").find(entry => entry.startsWith(combination.row));
    expect(line, `${name} row`).toBeDefined();
    expect(line).toContain(combination.grade);
    expect(line).not.toMatch(/live-proven(?!\s*(yet|:))/i);
  });
}

test("AC7: the qwen-led row says out loud that no agent conducts, and the loader says why it ignored the role", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-roles-doc-qwen-")); dirs.push(dir);
  mkdirSync(join(dir, ".agenthub"));
  writeFileSync(join(dir, ".agenthub", "config.json"), JSON.stringify({ ...COMBINATIONS["open, qwen-led"].config, pi: { enabled: true }, memory: { enabled: false } }));
  const config = loadConfig(dir);
  expect(config.retired?.join("\n")).toContain("roles.qwen: conductor ignored: qwen cannot conduct");
  expect(DOC).toContain("**no agent conducts**");
});

test("AC7: the person-led combination warns on purpose: no planner is rostered and reviews go to the person", () => {
  const dir = mkdtempSync(join(tmpdir(), "ahub-roles-doc-person-")); dirs.push(dir);
  mkdirSync(join(dir, ".agenthub"));
  writeFileSync(join(dir, ".agenthub", "config.json"), JSON.stringify({ ...COMBINATIONS["person-led"].config, pi: { enabled: true }, memory: { enabled: false } }));
  const config = loadConfig(dir), scope = readInstanceRoleConfig(dir);
  const row = rolesRow({ roles: config.roles, startMode: () => undefined, rostered: peer => rosterAllows(config.roster, peer, config.pi.enabled, scope.instances, scope.catalog) });
  expect(row.ok).toBeUndefined();
  expect(row.detail).toContain("no rostered planner is eligible");
  expect(row.detail).toContain("reviews go to the person");
  expect(DOC).toContain("which is this combination's intent");
});

test("the section names its sources and the quickstart links to it", () => {
  expect(DOC).toContain("# Choosing who conducts, plans and reviews");
  for (const word of ["fixture-proven", "live-proven", "pi stays implementer-only", "test/conformance/conductor.test.ts"]) expect(DOC, word).toContain(word);
  expect(readFileSync(join(import.meta.dir, "../docs/quickstart.md"), "utf8")).toContain("roles.md#choosing-who-conducts-plans-and-reviews");
});
