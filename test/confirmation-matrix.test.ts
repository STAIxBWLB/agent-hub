import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ADAPTERS, START_MODE_PEERS } from "../src/adapters/registry.ts";
import { SETTINGS } from "../src/hub/settings.ts";
import { permissionDefaults } from "../src/hub/permission-mode.ts";
import {
  catalogKinds, confirmationMatrix, evidenceProblems, MATRIX_ENVIRONMENTS, missingCoverage, REQUIRED_POINTS, rowsFor, validateConfirmationMatrix,
  type CatalogKind, type ConfirmationMatrix,
} from "../src/hub/confirmation-matrix.ts";

// #999 T0: the matrix is data under templates/presets/. These tests make a new peer kind, a drifted catalog fact, a vanished
// evidence line or an unestablished fact written as a guess fail here. No behaviour is under test: nothing consults the matrix yet.
const root = join(import.meta.dir, "..");
const clone = (): ConfirmationMatrix => structuredClone(confirmationMatrix());
const read = (file: string): string | undefined => { const path = join(root, file); return existsSync(path) ? readFileSync(path, "utf8") : undefined; };

test("the committed matrix is sound against the adapter catalog", () => {
  expect(validateConfirmationMatrix(confirmationMatrix())).toEqual([]);
});

test("every peer kind in the adapter catalog has rows in every environment it can run in", () => {
  const kinds = ADAPTERS.map(definition => definition.kind);
  expect(kinds.length).toBeGreaterThanOrEqual(8);
  expect(missingCoverage(confirmationMatrix(), kinds)).toEqual([]);
  for (const kind of kinds) for (const environment of MATRIX_ENVIRONMENTS) {
    if (confirmationMatrix().unavailable.some(entry => entry.kind === kind && entry.environment === environment)) { expect(rowsFor(confirmationMatrix(), kind, environment).some(row => (REQUIRED_POINTS as readonly string[]).includes(row.point))).toBe(false); continue; }
    for (const point of REQUIRED_POINTS) expect(rowsFor(confirmationMatrix(), kind, environment).some(row => row.point === point)).toBe(true);
  }
});

test("a peer kind added to the catalog without a row fails, naming the kind", () => {
  const added: CatalogKind = { kind: "newpeer", forms: ["headless"], extraForms: [], conductorStartable: true, pullOnlyForms: [], hubMode: "mapped" };
  const problems = validateConfirmationMatrix(confirmationMatrix(), [...catalogKinds(), added]);
  expect(problems.some(problem => problem.startsWith("kinds.newpeer: missing"))).toBe(true);
  for (const environment of MATRIX_ENVIRONMENTS) expect(problems).toContain(`newpeer/${environment}: no tool-approval row`);
  expect(problems).toContain("newpeer/terminal: no classed-action row");
});

test("removing every row of a catalog kind fails", () => {
  const matrix = clone();
  matrix.rows = matrix.rows.filter(row => !row.kinds.includes("kimi"));
  const problems = validateConfirmationMatrix(matrix);
  expect(problems).toContain("kimi/terminal: no tool-approval row");
  expect(problems).toContain("kimi/headless: no classed-action row");
});

test("a kind the catalog no longer has is refused", () => {
  const matrix = clone();
  matrix.kinds.ghost = { ...matrix.kinds.codex! };
  expect(validateConfirmationMatrix(matrix)).toContain("kinds.ghost: not a kind of the adapter catalog");
});

test("the kinds block equals what the registry declares", () => {
  const matrix = clone();
  matrix.kinds.codex!.forms = ["tui"];
  matrix.kinds.agy!.conductorStartable = true;
  matrix.kinds.jcode!.hubMode = "mapped";
  const problems = validateConfirmationMatrix(matrix);
  expect(problems.some(problem => problem.startsWith("kinds.codex.forms"))).toBe(true);
  expect(problems).toContain("kinds.agy.conductorStartable differs from the catalog");
  expect(problems.some(problem => problem.startsWith("kinds.jcode.hubMode"))).toBe(true);
});

test("an unavailable pair must really have no rows, and a row in it fails", () => {
  const matrix = clone();
  matrix.rows.push({ ...matrix.rows.find(row => row.id === "agy.tool-approval.tui")!, id: "agy.tool-approval.headless", environments: ["headless"] });
  expect(validateConfirmationMatrix(matrix).some(problem => problem.includes("agy has rows in headless"))).toBe(true);
});

test("a row names only keys that exist, and an asking row names a controlling key", () => {
  const matrix = clone();
  const row = matrix.rows.find(entry => entry.id === "pi.tool-approval.any")!;
  row.controlledBy = ["no.such.key"];
  expect(validateConfirmationMatrix(matrix)).toContain("rows[pi.tool-approval.any]: controlledBy names no.such.key, which is not in keys");
  row.controlledBy = [];
  expect(validateConfirmationMatrix(matrix)).toContain("rows[pi.tool-approval.any]: a row that asks needs at least one controlling key");
});

test("a fact that was not established is a structured unknowns entry, and a note cannot stand in for a concrete value", () => {
  const matrix = clone();
  const unknown = matrix.rows.filter(row => row.hubSeesBeforeRun === "unknown" || row.askedBy === "unknown" || /\bunknown\b/.test(row.note ?? ""));
  expect(unknown.length).toBeGreaterThan(0);
  for (const row of unknown) expect(row.unknowns?.length, row.id).toBeGreaterThan(0);
  // prose alone: a note that says unknown with no structured entry fails
  const prose = clone().rows.find(row => row.id === "qwen.hub-tools.personal-turn")!;
  delete prose.unknowns;
  expect(validateConfirmationMatrix({ ...clone(), rows: clone().rows.map(row => row.id === prose.id ? prose : row) }).some(problem => problem.includes("structured unknowns list"))).toBe(true);
  // an unknowns list on a row that claims everything is established
  const claimed = clone();
  claimed.rows.find(row => row.id === "pi.tool-approval.any")!.unknowns = ["something"];
  expect(validateConfirmationMatrix(claimed).some(problem => problem.includes("unknowns is listed"))).toBe(true);
});

test("a native TUI asker is only claimed on a TUI-only row, never on one that covers headless", () => {
  for (const row of confirmationMatrix().rows) if (row.askedBy === "native-tui" || row.askedBy === "native-and-hub") {
    expect(row.form, row.id).toBe("tui");
    expect(row.environments.includes("headless"), row.id).toBe(false);
  }
  const matrix = clone();
  const jcode = matrix.rows.find(row => row.id === "jcode.tool-approval.any")!;
  jcode.askedBy = "native-tui";
  expect(validateConfirmationMatrix(matrix).some(problem => problem.includes("rows[jcode.tool-approval.any]: askedBy native-tui needs form tui"))).toBe(true);
  // Jcode's asker is not established by the source, so it is unknown in both rows
  for (const id of ["jcode.tool-approval.any", "jcode.classed-action.any"]) expect(confirmationMatrix().rows.find(row => row.id === id)!.askedBy).toBe("unknown");
});

test("Qwen's TUI rows separate a hub-owned turn from a personal turn, as the adapter does", () => {
  const rows = confirmationMatrix().rows;
  for (const point of ["tool-approval", "classed-action", "hub-tools"] as const) {
    const tui = rows.filter(row => row.kinds.includes("qwen") && row.point === point && row.environments.includes("terminal"));
    const hub = tui.find(row => row.id.endsWith("hub-turn")), personal = tui.find(row => row.id.endsWith("personal-turn"));
    expect(hub, point).toBeDefined();
    expect(personal, point).toBeDefined();
    expect(personal!.hubSeesBeforeRun, personal!.id).toBe("no");
    expect(personal!.askedBy, personal!.id).toBe("native-tui");
    expect(hub!.hubSeesBeforeRun, hub!.id).not.toBe("no");
  }
  // no Qwen TUI row claims hub visibility without a turn-owner qualifier
  for (const row of rows.filter(entry => entry.kinds.includes("qwen") && entry.form === "tui")) expect(/hub-turn$|personal-turn$/.test(row.id), row.id).toBe(true);
  // the adapter source is what makes the split true
  const source = read("src/adapters/qwen-dual.ts")!;
  expect(source).toContain('if (!turn?.started || this.owner !== "hub"');
});

test("every row cites evidence that still exists in the repository", () => {
  expect(evidenceProblems(confirmationMatrix(), read)).toEqual([]);
});

test("a vanished evidence needle or file is reported", () => {
  const matrix = clone();
  matrix.rows[0]!.evidence = [{ file: "src/hub/terminal-open.ts", needle: "text that is not in this file at all" }, { file: "src/hub/not-a-file.ts", needle: "anything long enough" }];
  expect(evidenceProblems(matrix, read)).toEqual([
    `rows[${matrix.rows[0]!.id}]: src/hub/terminal-open.ts no longer contains "text that is not in this file at all"`,
    `rows[${matrix.rows[0]!.id}]: evidence file src/hub/not-a-file.ts does not exist`,
  ]);
});

test("a key that claims to be a setting names a setting the registry has", () => {
  const registered = new Set(SETTINGS.map(setting => setting.key));
  const patternOf = (name: string): RegExp => new RegExp(`^${name.replace(/[.]/g, "\\.").replace(/<peer>/g, "[A-Za-z0-9_-]+")}$`);
  for (const [name, key] of Object.entries(confirmationMatrix().keys)) {
    if (key.kind !== "setting") { expect(key.setting).toBeNull(); continue; }
    const pattern = patternOf(key.setting!);
    expect([...registered].some(setting => pattern.test(setting)), `${name} is not a registered setting`).toBe(true);
  }
});

test("permission_modes.<peer> applies to exactly the kinds the real loader accepts", () => {
  const accepted = ADAPTERS.map(definition => definition.kind).filter(kind => { try { permissionDefaults({ [kind]: "ask-when-needed" }); return true; } catch { return false; } });
  const keys = confirmationMatrix().keys;
  expect([...keys["permission_modes.<peer>"]!.appliesTo!].sort()).toEqual([...accepted].sort());
  expect([...keys["permission.<peer>"]!.appliesTo!].sort()).toEqual([...accepted].sort());
  // The same fact, from the matrix's own kinds block: a kind the loader refuses is not hub-mapped, and the reverse.
  for (const [kind, facts] of Object.entries(confirmationMatrix().kinds)) expect(facts.hubMode === "unmanaged", kind).toBe(!accepted.includes(kind));
});

test("peers.<peer>.start_mode applies to exactly the registry's start-mode kinds, and the registered settings agree", () => {
  const keys = confirmationMatrix().keys;
  expect([...keys["peers.<peer>.start_mode"]!.appliesTo!].sort()).toEqual([...START_MODE_PEERS].sort());
  for (const kind of START_MODE_PEERS) expect(SETTINGS.some(setting => setting.key === `peers.${kind}.start_mode`), kind).toBe(true);
  for (const kind of Object.keys(confirmationMatrix().kinds)) if (!START_MODE_PEERS.includes(kind)) expect(SETTINGS.some(setting => setting.key === `peers.${kind}.start_mode`), kind).toBe(false);
});

test("a kind with no TUI form never has a tui-open row, and a kind the hub maps no mode for is never marked hub-seen on classed actions", () => {
  for (const row of confirmationMatrix().rows.filter(entry => entry.point === "tui-open")) for (const kind of row.kinds) expect(confirmationMatrix().kinds[kind]!.forms.includes("tui"), `${row.id}: ${kind}`).toBe(true);
  for (const row of confirmationMatrix().rows) for (const kind of row.kinds) {
    const facts = confirmationMatrix().kinds[kind];
    if (facts?.hubMode === "unmanaged" && row.point === "classed-action") expect(row.hubSeesBeforeRun, row.id).toBe("no");
  }
});

test("the registered switches the issue names carry the risk the matrix claims", () => {
  const byKey = new Map(SETTINGS.map(setting => [setting.key, setting]));
  for (const key of ["tasks.auto_pull", "task_sweep.auto_reassign", "task_sweep.enabled"]) expect(byKey.get(key)?.risk, key).toBe("raises");
  expect(byKey.get("tasks.auto_pull")?.applies).toBe("live");
  expect(byKey.get("tasks.auto_pull")?.floor).toBe(false);
});

test("every key the preset will write is described: the hub keys of the issue appear", () => {
  const keys = Object.keys(confirmationMatrix().keys);
  for (const key of ["permission_modes.<peer>", "permission.<peer>", "action_policy", "tasks.auto_pull", "task_sweep.auto_reassign", "peers.<peer>.start_mode", "terminal.open"]) expect(keys).toContain(key);
});

test("the matrix ships with the package and holds no private address or absolute path", () => {
  const text = readFileSync(join(import.meta.dir, "../templates/presets/confirmation-matrix.json"), "utf8");
  expect(text).not.toMatch(/(?:^|[^\d.])(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}/);
  expect(text).not.toMatch(/\/Users\/|\/home\//);
});
