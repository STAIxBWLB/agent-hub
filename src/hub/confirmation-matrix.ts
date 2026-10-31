import matrixJson from "../../templates/presets/confirmation-matrix.json";
import { ADAPTERS } from "../adapters/registry.ts";

/**
 * #999 T0: the model-free inventory of every place a person is asked to confirm during a standard task, per agent kind and
 * environment (`templates/presets/confirmation-matrix.json`). This module only reads and checks that data. It changes no
 * behaviour: nothing in the daemon, the settings registry or an adapter consults it yet. T1's preset and `ahub autonomy status`
 * are its first readers. A new peer kind adds one row set to the JSON, never a branch here (this file names no peer).
 */
export const MATRIX_ENVIRONMENTS = ["terminal", "orca", "headless"] as const;
export type MatrixEnvironment = typeof MATRIX_ENVIRONMENTS[number];
export const MATRIX_POINTS = ["tool-approval", "classed-action", "hub-tools", "session-start", "tui-open", "mode-confirmation", "approval-expiry", "unattended", "settings-raise", "task-flow", "merge", "release"] as const;
/** The two points every peer kind needs a row for in every environment it can run in. */
export const REQUIRED_POINTS = ["tool-approval", "classed-action"] as const;
export const HUB_SEES = ["yes", "partial", "no", "unknown", "not-applicable"] as const;
export const ASKED_BY = ["hub-console", "native-tui", "native-and-hub", "none", "unknown"] as const;
export const KEY_KINDS = ["setting", "file", "launch-flag", "command", "native"] as const;
export const HUB_MODES = ["mapped", "unmanaged", "unmanaged-in-tui"] as const;
const FORMS = ["tui", "headless"] as const;
/** Rows that belong to the hub itself, not to one agent kind. */
export const HUB_ROW_KIND = "hub";

export interface MatrixEvidence { file: string; needle: string }
export interface ConfirmationRow {
  id: string;
  kinds: string[];
  environments: MatrixEnvironment[];
  form: "tui" | "headless" | "any";
  point: typeof MATRIX_POINTS[number];
  asks: string;
  controlledBy: string[];
  hubSeesBeforeRun: typeof HUB_SEES[number];
  askedBy: typeof ASKED_BY[number];
  note?: string;
  /** What was not established, one entry each. Required, and only allowed, when the note says `unknown` or hubSeesBeforeRun or askedBy is `unknown`. */
  unknowns?: string[];
  evidence: MatrixEvidence[];
}
export interface MatrixKey {
  kind: typeof KEY_KINDS[number];
  setting: string | null;
  appliesTo?: string[];
  where: string;
  applies: string;
  default: string;
  setBy: string;
  doc: string;
}
export interface MatrixKind {
  forms: string[];
  /** A form the kind has only as a declared instance or an explicit start, never as its default start forms. */
  extraForms: string[];
  conductorStartable: boolean;
  pullOnlyForms: string[];
  hubMode: typeof HUB_MODES[number];
  formNote?: string;
}
export interface ConfirmationMatrix {
  schema: 1;
  issue: string;
  phase: string;
  about: string;
  environments: Record<MatrixEnvironment, { detect: string; opens: string }>;
  kinds: Record<string, MatrixKind>;
  keys: Record<string, MatrixKey>;
  unavailable: { kind: string; environment: MatrixEnvironment; reason: string }[];
  rows: ConfirmationRow[];
}
/** What the registry says about one kind, the facts the matrix's `kinds` block must equal. */
export interface CatalogKind { kind: string; forms: string[]; extraForms: string[]; conductorStartable: boolean; pullOnlyForms: string[]; hubMode: typeof HUB_MODES[number] }

export const confirmationMatrix = (): ConfirmationMatrix => matrixJson as unknown as ConfirmationMatrix;

/** The catalog's kinds as the registry declares them now. A form a kind only has as a declared instance or an explicit start is `extraForms`. */
export function catalogKinds(): CatalogKind[] {
  return ADAPTERS.map((definition): CatalogKind => ({
    kind: definition.kind,
    forms: [...definition.start.forms],
    extraForms: [...(definition.headlessVariant ? ["headless"] : []), ...(definition.start.createTui ? ["tui"] : [])].filter(form => !definition.start.forms.includes(form as "tui" | "headless")),
    conductorStartable: definition.start.conductorStartable,
    pullOnlyForms: [...(definition.attach?.pullOnlyForms ?? [])],
    hubMode: definition.permission.unmanaged ? "unmanaged" : definition.permission.unmanagedForms?.includes("tui") ? "unmanaged-in-tui" : "mapped",
  }));
}

const same = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && [...left].sort().join("\0") === [...right].sort().join("\0");
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);

/** Every kind and environment the rows cover, or name: a pair with neither the two required points nor an `unavailable` entry is a gap. */
export function missingCoverage(matrix: ConfirmationMatrix, kinds: readonly string[]): string[] {
  const missing: string[] = [];
  for (const kind of kinds) {
    if (!matrix.kinds[kind]) missing.push(`${kind}: no entry in kinds`);
    for (const environment of MATRIX_ENVIRONMENTS) {
      if (matrix.unavailable.some(entry => entry.kind === kind && entry.environment === environment)) continue;
      for (const point of REQUIRED_POINTS) {
        if (!matrix.rows.some(row => row.kinds.includes(kind) && row.environments.includes(environment) && row.point === point)) missing.push(`${kind}/${environment}: no ${point} row`);
      }
    }
  }
  return missing;
}

/** The rows that apply to `kind` in `environment`, in file order. Hub rows (`kind: hub`) answer for the hub itself. */
export function rowsFor(matrix: ConfirmationMatrix, kind: string, environment: MatrixEnvironment): ConfirmationRow[] {
  return matrix.rows.filter(row => row.kinds.includes(kind) && row.environments.includes(environment));
}

/**
 * Structural problems of the matrix against the registry's catalog, empty when sound. Pure: no file or process access.
 * `evidence` needles are checked by `evidenceProblems` (it reads files).
 */
export function validateConfirmationMatrix(value: unknown, catalog: readonly CatalogKind[] = catalogKinds()): string[] {
  if (!isObject(value)) return ["the matrix must be an object"];
  const problems: string[] = [];
  const matrix = value as unknown as ConfirmationMatrix;
  if (matrix.schema !== 1) problems.push("schema must be 1");
  for (const field of ["issue", "phase", "about"] as const) if (typeof matrix[field] !== "string" || !matrix[field]) problems.push(`${field} must be a non-empty string`);
  if (!isObject(matrix.environments) || !same(Object.keys(matrix.environments), MATRIX_ENVIRONMENTS)) problems.push(`environments must be exactly ${MATRIX_ENVIRONMENTS.join(", ")}`);
  else for (const environment of MATRIX_ENVIRONMENTS) { const entry = matrix.environments[environment]; if (!isObject(entry) || typeof entry.detect !== "string" || typeof entry.opens !== "string" || !entry.detect || !entry.opens) problems.push(`environments.${environment} needs detect and opens text`); }
  if (!isObject(matrix.kinds) || !isObject(matrix.keys) || !Array.isArray(matrix.rows) || !Array.isArray(matrix.unavailable)) return [...problems, "kinds, keys, unavailable and rows must be present"];

  // kinds: one entry per catalog kind, equal to what the registry declares now.
  const known = new Set(catalog.map(entry => entry.kind));
  for (const entry of catalog) {
    const kind = matrix.kinds[entry.kind];
    if (!kind) { problems.push(`kinds.${entry.kind}: missing (the adapter catalog has this kind)`); continue; }
    if (!same(kind.forms ?? [], entry.forms)) problems.push(`kinds.${entry.kind}.forms: ${JSON.stringify(kind.forms)} but the catalog declares ${JSON.stringify(entry.forms)}`);
    if (!same(kind.extraForms ?? [], entry.extraForms)) problems.push(`kinds.${entry.kind}.extraForms: ${JSON.stringify(kind.extraForms ?? [])} but the catalog gives ${JSON.stringify(entry.extraForms)}`);
    if (kind.conductorStartable !== entry.conductorStartable) problems.push(`kinds.${entry.kind}.conductorStartable differs from the catalog`);
    if (!same(kind.pullOnlyForms ?? [], entry.pullOnlyForms)) problems.push(`kinds.${entry.kind}.pullOnlyForms differs from the catalog`);
    if (kind.hubMode !== entry.hubMode) problems.push(`kinds.${entry.kind}.hubMode is ${String(kind.hubMode)} but the catalog gives ${entry.hubMode}`);
  }
  for (const name of Object.keys(matrix.kinds)) if (!known.has(name)) problems.push(`kinds.${name}: not a kind of the adapter catalog`);

  // keys
  for (const [name, key] of Object.entries(matrix.keys)) {
    if (!isObject(key)) { problems.push(`keys.${name} must be an object`); continue; }
    if (!oneOf(KEY_KINDS, key.kind)) problems.push(`keys.${name}.kind must be one of ${KEY_KINDS.join(", ")}`);
    if (key.kind === "setting" ? typeof key.setting !== "string" || !key.setting : key.setting !== null) problems.push(`keys.${name}.setting must be a registered setting name for a setting and null otherwise`);
    for (const field of ["where", "applies", "default", "setBy", "doc"] as const) if (typeof key[field] !== "string" || !key[field]) problems.push(`keys.${name}.${field} must be non-empty text`);
    for (const kind of key.appliesTo ?? []) if (!known.has(kind)) problems.push(`keys.${name}.appliesTo names ${kind}, which is not a catalog kind`);
  }

  // rows
  const seen = new Set<string>();
  for (const [index, row] of matrix.rows.entries()) {
    const at = isObject(row) && typeof row.id === "string" ? `rows[${row.id}]` : `rows[${index}]`;
    if (!isObject(row)) { problems.push(`${at} must be an object`); continue; }
    if (typeof row.id !== "string" || !/^[a-z][a-z0-9.-]*$/.test(row.id)) problems.push(`${at}: id must be lowercase words joined by dots`);
    else if (seen.has(row.id)) problems.push(`${at}: duplicate id`);
    else seen.add(row.id);
    if (!Array.isArray(row.kinds) || !row.kinds.length) problems.push(`${at}: kinds must be a non-empty list`);
    for (const kind of Array.isArray(row.kinds) ? row.kinds : []) {
      if (kind !== HUB_ROW_KIND && !known.has(kind)) { problems.push(`${at}: ${String(kind)} is not a catalog kind`); continue; }
      const facts = matrix.kinds[kind];
      if (kind !== HUB_ROW_KIND && row.form !== "any" && facts && !facts.forms.includes(row.form) && !(facts.extraForms ?? []).includes(row.form)) problems.push(`${at}: ${kind} has no ${String(row.form)} form`);
    }
    if (!Array.isArray(row.environments) || !row.environments.length || row.environments.some(environment => !oneOf(MATRIX_ENVIRONMENTS, environment))) problems.push(`${at}: environments must be a non-empty subset of ${MATRIX_ENVIRONMENTS.join(", ")}`);
    if (row.form !== "any" && !oneOf(FORMS, row.form)) problems.push(`${at}: form must be tui, headless or any`);
    if (!oneOf(MATRIX_POINTS, row.point)) problems.push(`${at}: point must be one of ${MATRIX_POINTS.join(", ")}`);
    if (typeof row.asks !== "string" || !row.asks) problems.push(`${at}: asks must say what is asked`);
    if (!Array.isArray(row.controlledBy)) problems.push(`${at}: controlledBy must be a list`);
    for (const key of Array.isArray(row.controlledBy) ? row.controlledBy : []) if (!Object.hasOwn(matrix.keys, key)) problems.push(`${at}: controlledBy names ${String(key)}, which is not in keys`);
    if (!oneOf(HUB_SEES, row.hubSeesBeforeRun)) problems.push(`${at}: hubSeesBeforeRun must be one of ${HUB_SEES.join(", ")}`);
    if (!oneOf(ASKED_BY, row.askedBy)) problems.push(`${at}: askedBy must be one of ${ASKED_BY.join(", ")}`);
    // A fact that was not established is the word unknown in a structured field, never prose alone: a note cannot override a concrete value.
    const saysUnknown = row.hubSeesBeforeRun === "unknown" || row.askedBy === "unknown" || /\bunknown\b/.test(row.note ?? "");
    const listed = Array.isArray(row.unknowns) ? row.unknowns : undefined;
    if (row.unknowns !== undefined && (!listed || !listed.length || listed.some(item => typeof item !== "string" || !item.trim()))) problems.push(`${at}: unknowns must be a non-empty list of text`);
    if (saysUnknown && !listed?.length) problems.push(`${at}: an unknown value needs a structured unknowns list that says what is unknown`);
    if (!saysUnknown && row.unknowns !== undefined) problems.push(`${at}: unknowns is listed but neither the note nor a field says unknown`);
    if ((row.hubSeesBeforeRun === "unknown") !== (row.askedBy === "unknown") && row.askedBy !== "none" && row.hubSeesBeforeRun !== "no") problems.push(`${at}: hubSeesBeforeRun and askedBy are unknown together`);
    // A native TUI prompt exists only in a TUI form: a row that covers headless, or any form, cannot name one as the asker.
    if ((row.askedBy === "native-tui" || row.askedBy === "native-and-hub") && (row.form !== "tui" || (Array.isArray(row.environments) && row.environments.includes("headless")))) problems.push(`${at}: askedBy ${row.askedBy} needs form tui and no headless environment; split the row or mark the asker unknown`);
    // A prompt that costs a person's turn must name a key that controls it. A row whose asker is unknown names none: that is the gap it records.
    if (row.askedBy !== "none" && row.askedBy !== "unknown" && Array.isArray(row.controlledBy) && !row.controlledBy.length) problems.push(`${at}: a row that asks needs at least one controlling key`);
    if (!Array.isArray(row.evidence) || !row.evidence.length) problems.push(`${at}: evidence must name at least one file and needle`);
    for (const item of Array.isArray(row.evidence) ? row.evidence : []) if (!isObject(item) || typeof item.file !== "string" || typeof item.needle !== "string" || !item.file || item.needle.length < 8 || item.file.startsWith("/") || item.file.includes("..")) problems.push(`${at}: an evidence item needs a project-relative file and a needle of at least 8 characters`);
  }
  for (const [index, entry] of matrix.unavailable.entries()) {
    const at = `unavailable[${index}]`;
    if (!isObject(entry) || !known.has(entry.kind) || !oneOf(MATRIX_ENVIRONMENTS, entry.environment) || typeof entry.reason !== "string" || !entry.reason) { problems.push(`${at} needs a catalog kind, an environment and a reason`); continue; }
    if (matrix.rows.some(row => row.kinds.includes(entry.kind) && row.environments.includes(entry.environment) && (REQUIRED_POINTS as readonly string[]).includes(row.point))) problems.push(`${at}: ${entry.kind} has rows in ${entry.environment}, so it is not unavailable there`);
  }
  problems.push(...missingCoverage(matrix, catalog.map(entry => entry.kind)));
  return problems;
}

/** Evidence items whose file or needle no longer exists. `read` returns a file's text, or undefined when there is none. */
export function evidenceProblems(matrix: ConfirmationMatrix, read: (file: string) => string | undefined): string[] {
  const problems: string[] = [];
  const cache = new Map<string, string | undefined>();
  for (const row of matrix.rows) for (const { file, needle } of row.evidence) {
    if (!cache.has(file)) cache.set(file, read(file));
    const text = cache.get(file);
    if (text === undefined) problems.push(`rows[${row.id}]: evidence file ${file} does not exist`);
    else if (!text.includes(needle)) problems.push(`rows[${row.id}]: ${file} no longer contains "${needle}"`);
  }
  return problems;
}
