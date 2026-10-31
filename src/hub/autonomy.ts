import presetJson from "../../templates/presets/autonomous.json";
import { checkSettingValue, settingDef } from "./settings.ts";
import { confirmationMatrix, MATRIX_ENVIRONMENTS, type ConfirmationMatrix, type ConfirmationRow, type MatrixEnvironment } from "./confirmation-matrix.ts";
import { PERMISSION_MODES, type PermissionMode } from "./permission-mode.ts";

export type AutonomyEnvironment = string;
export type AutonomyForm = "tui" | "headless";
export interface AutonomyOperation { key: string; value: unknown; store: "config" | "runtime" }
export interface AutonomySetting { store: "config" | "runtime"; values?: readonly string[]; locked?: string }
export type AutonomySettingLookup = (key: string) => AutonomySetting | undefined;
export interface AutonomyKindPreset {
  permission: Record<AutonomyForm, PermissionMode | null>;
  start: Record<MatrixEnvironment, AutonomyForm | null> & Record<string, AutonomyForm | null>;
}
export interface AutonomyEnvironmentPreset { matrixEnvironment: MatrixEnvironment; aliases: string[]; terminalOpen: string[] | null; instruction: string; detect: { priority: number; variable?: string; terminal?: boolean } }
export interface AutonomyPreset {
  schema: 1;
  issue: string;
  about: string;
  hub: Record<string, unknown>;
  floorClasses: string[];
  environments: Record<MatrixEnvironment, AutonomyEnvironmentPreset> & Record<string, AutonomyEnvironmentPreset>;
  kinds: Record<string, AutonomyKindPreset>;
}
export interface AutonomyStructuralGuard { verified: boolean; reason: string }
export interface AutonomyPeer {
  id: string;
  kind: string;
  form?: AutonomyForm;
  permissionMode?: string;
  lockedMode?: string;
  actionEnforcement?: { enforced: boolean; reason?: string };
  structuralGuards?: Partial<Record<string, AutonomyStructuralGuard>>;
}
export interface AutonomyFloorStatus { class: string; status: "hub-enforced" | "structural-guard" | "not-enforced"; reason: string }
export interface AutonomyPeerStatus {
  id: string;
  kind: string;
  form: AutonomyForm | null;
  effectiveMode: string;
  /** Preset intent, not proof that a config transaction has applied it. */
  nextForm: AutonomyForm | null;
  nextMode: string | null;
  applies: "next peer start";
  floor: AutonomyFloorStatus[];
  missing: string[];
}
export interface AutonomyStatusInput {
  environment: AutonomyEnvironment;
  peers: readonly AutonomyPeer[];
  rows?: readonly ConfirmationRow[];
  terminalOpener?: { available: boolean; reason?: string; via?: string };
  /** Host floor-verdict seam for T3; a coarse action policy alone proves no floor enforcement. */
  floorEnforcement?: Readonly<Record<string, Readonly<Record<string, AutonomyFloorStatus>>>>;
  preset?: AutonomyPreset;
  matrix?: ConfirmationMatrix;
}
const FORMS: readonly AutonomyForm[] = ["tui", "headless"];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const same = (left: readonly string[], right: readonly string[]) => left.length === right.length && [...left].sort().join("\0") === [...right].sort().join("\0");
const form = (value: unknown): value is AutonomyForm => value === "tui" || value === "headless";
const peerId = (value: string) => /^[a-z][a-z0-9_-]{0,63}$/.test(value);
export const autonomyPreset = (): AutonomyPreset => presetJson as unknown as AutonomyPreset;

/** Pure, closed-data validation. A new catalog kind needs preset data, never a new kind branch. */
export function validateAutonomyPreset(value: unknown, matrix: ConfirmationMatrix = confirmationMatrix()): string[] {
  if (!object(value)) return ["autonomy preset must be an object"];
  const problems: string[] = [];
  if (value.schema !== 1) problems.push("autonomy preset needs schema 1");
  for (const field of ["issue", "about"] as const) if (typeof value[field] !== "string" || !value[field]) problems.push(`${field} must be non-empty text`);
  if (!object(value.hub)) problems.push("hub must be an object");
  else {
    for (const key of ["tasks.auto_pull", "task_sweep.enabled", "task_sweep.auto_reassign"]) if (value.hub[key] !== true) problems.push(`hub.${key} must be true`);
    for (const [key, raw] of Object.entries(value.hub)) {
      const definition = settingDef(key);
      if (typeof definition === "string" || definition.store !== "config") { problems.push(`hub.${key}: not a config setting`); continue; }
      try { checkSettingValue(definition, raw); } catch { problems.push(`hub.${key}: invalid registered value`); }
    }
  }
  if (!Array.isArray(value.floorClasses) || !value.floorClasses.length || value.floorClasses.length > 32 || new Set(value.floorClasses).size !== value.floorClasses.length || value.floorClasses.some(item => typeof item !== "string" || !/^[a-z][a-z-]{0,63}$/.test(item))) problems.push("floorClasses must name distinct floor classes");
  const environments = object(value.environments) ? Object.keys(value.environments) : [];
  if (!object(value.environments) || !MATRIX_ENVIRONMENTS.every(environment => environments.includes(environment)) || environments.some(environment => !peerId(environment))) problems.push("environments must include terminal, orca and headless with plain ids");
  else {
    const aliases = new Set<string>(environments);
    for (const environment of environments) {
      const entry = value.environments[environment];
      if (!object(entry) || !(MATRIX_ENVIRONMENTS as readonly unknown[]).includes(entry.matrixEnvironment) || !Array.isArray(entry.aliases) || entry.aliases.some(alias => typeof alias !== "string" || !/^[a-z][a-z0-9-]*$/.test(alias)) || typeof entry.instruction !== "string" || !entry.instruction.trim()) { problems.push(`environments.${environment}: aliases and instruction required`); continue; }
      for (const alias of entry.aliases as string[]) { if (aliases.has(alias)) problems.push(`environment alias ${alias} is ambiguous`); aliases.add(alias); }
      const detect = entry.detect;
      if (!object(detect) || !Number.isSafeInteger(detect.priority) || (detect.priority as number) < 0 || (detect.priority as number) > 100 || Object.keys(detect).some(key => !["priority", "variable", "terminal"].includes(key)) || detect.variable === undefined && detect.terminal === undefined || detect.variable !== undefined && (typeof detect.variable !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(detect.variable)) || detect.terminal !== undefined && typeof detect.terminal !== "boolean") problems.push(`environments.${environment}.detect: bounded priority and environment-variable or terminal predicate required`);
      if (entry.terminalOpen !== null && (!Array.isArray(entry.terminalOpen) || !entry.terminalOpen.length || entry.terminalOpen.some(word => typeof word !== "string") || entry.terminalOpen.filter(word => word === "{command}").length !== 1)) problems.push(`environments.${environment}.terminalOpen must be null or an argv template with one {command}`);
    }
  }
  if (!object(value.kinds)) return [...problems, "kinds must be an object"];
  for (const kind of Object.keys(matrix.kinds)) if (!Object.hasOwn(value.kinds, kind)) problems.push(`kinds.${kind}: missing`);
  for (const [kind, raw] of Object.entries(value.kinds)) {
    const facts = matrix.kinds[kind];
    if (!facts) { problems.push(`kinds.${kind}: not in the confirmation matrix`); continue; }
    if (!object(raw) || !object(raw.permission) || !object(raw.start)) { problems.push(`kinds.${kind}: permission and start required`); continue; }
    if (!same(Object.keys(raw.permission), FORMS)) problems.push(`kinds.${kind}.permission must name tui and headless`);
    if (!same(Object.keys(raw.start), environments)) problems.push(`kinds.${kind}.start must name every environment`);
    for (const modeForm of FORMS) {
      const mode = raw.permission[modeForm], supported = [...facts.forms, ...facts.extraForms].includes(modeForm);
      if (mode !== null && (!(PERMISSION_MODES as readonly unknown[]).includes(mode) || !supported || facts.hubMode === "unmanaged" || facts.hubMode === "unmanaged-in-tui" && modeForm === "tui")) problems.push(`kinds.${kind}.permission.${modeForm}: unsupported hub mode`);
    }
    for (const environment of environments) {
      const selected = raw.start[environment];
      if (selected !== null && (!form(selected) || !facts.forms.includes(selected))) problems.push(`kinds.${kind}.start.${environment}: not a base start form`);
    }
  }
  return problems;
}

function environmentOf(value: AutonomyEnvironment, preset: AutonomyPreset): string {
  if (Object.hasOwn(preset.environments, value)) return value;
  const match = Object.keys(preset.environments).filter(environment => preset.environments[environment]!.aliases.includes(value));
  if (match.length !== 1) throw new Error(`autonomy: unsupported environment ${value}`);
  return match[0]!;
}
function checkedPreset(preset: AutonomyPreset, matrix: ConfirmationMatrix): void {
  const problems = validateAutonomyPreset(preset, matrix);
  if (problems.length) throw new Error(`autonomy: invalid preset: ${problems.join("; ")}`);
}
function nextForm(peer: Pick<AutonomyPeer, "id" | "kind" | "form">, environment: string, preset: AutonomyPreset, matrix: ConfirmationMatrix, lookup?: AutonomySettingLookup): AutonomyForm | null {
  const entry = preset.kinds[peer.kind], facts = matrix.kinds[peer.kind];
  if (!entry || !facts) return null;
  // Declared variants are explicit; a runtime TUI observation must not defeat a requested headless default.
  if (peer.form && facts.extraForms.includes(peer.form)) return peer.form;
  const values = lookup?.(`peers.${peer.id}.start_mode`)?.values;
  if (values?.length === 1 && form(values[0]) && [...facts.forms, ...facts.extraForms].includes(values[0])) return values[0];
  return entry.start[environment] ?? null;
}

/** Desired CONFIG leaf writes only. The daemon supplies its current setting definitions and owns the transaction/undo. */
export function planAutonomy(environment: AutonomyEnvironment, lookup?: AutonomySettingLookup, peers?: readonly Pick<AutonomyPeer, "id" | "kind" | "form">[], preset: AutonomyPreset = autonomyPreset(), matrix: ConfirmationMatrix = confirmationMatrix()): AutonomyOperation[] {
  checkedPreset(preset, matrix);
  const selected = environmentOf(environment, preset), operations: AutonomyOperation[] = [];
  const add = (key: string, value: unknown, optionalLocked = false) => {
    const definition = lookup?.(key);
    if (lookup && !definition) throw new Error(`autonomy: no safe writer for ${key}`);
    if (definition?.locked) { if (optionalLocked) return; throw new Error(`autonomy: locked required setting ${key}: ${definition.locked}`); }
    if (definition && (definition.store !== "config" || definition.values && !definition.values.includes(String(value)))) throw new Error(`autonomy: unsupported preset value for ${key}`);
    operations.push({ key, value: structuredClone(value), store: "config" });
  };
  for (const [key, value] of Object.entries(preset.hub)) add(key, value);
  const terminal = preset.environments[selected]!.terminalOpen;
  if (terminal !== null) add("terminal.open", terminal);
  const targets = peers ?? Object.keys(preset.kinds).map(kind => ({ id: kind, kind }));
  const seen = new Set<string>();
  for (const peer of targets) {
    if (!peerId(peer.id) || seen.has(peer.id)) throw new Error(`autonomy: invalid or duplicate peer id ${peer.id}`);
    seen.add(peer.id);
    const entry = preset.kinds[peer.kind], facts = matrix.kinds[peer.kind];
    if (!entry || !facts) throw new Error(`autonomy: no preset for kind ${peer.kind}`);
    const selectedForm = nextForm(peer, selected, preset, matrix, lookup);
    if (!selectedForm) continue;
    const startKey = `peers.${peer.id}.start_mode`;
    if (matrix.keys["peers.<peer>.start_mode"]?.appliesTo?.includes(peer.kind) || lookup?.(startKey)) add(startKey, selectedForm, true);
    const mode = entry.permission[selectedForm];
    if (mode !== null) add(`permission_modes.${peer.id}`, mode, true);
  }
  return operations;
}

/** Fixed removal scope from shipped data and host peer ids, never ownership metadata or a selected environment. */
export function autonomyRemovalKeys(peers: readonly Pick<AutonomyPeer, "id" | "kind">[] = Object.keys(autonomyPreset().kinds).map(kind => ({ id: kind, kind })), preset: AutonomyPreset = autonomyPreset()): string[] {
  const keys = new Set(Object.keys(preset.hub));
  if (Object.values(preset.environments).some(row => row.terminalOpen !== null)) keys.add("terminal.open");
  for (const peer of peers) {
    if (!peerId(peer.id)) throw new Error(`autonomy: invalid peer id ${peer.id}`);
    const entry = preset.kinds[peer.kind];
    if (!entry) continue;
    if (Object.values(entry.permission).some(mode => mode !== null)) {
      keys.add(`permission_modes.${peer.id}`);
      keys.add(`permission.${peer.id}`);
    }
    if (Object.values(entry.start).some(form => form !== null)) keys.add(`peers.${peer.id}.start_mode`);
  }
  return [...keys];
}

/** Current observations only: neither preset intent nor a kind name establishes a live hook, native sandbox or GitHub guard. */
export function autonomyStatus(input: AutonomyStatusInput): AutonomyPeerStatus[] {
  const preset = input.preset ?? autonomyPreset(), matrix = input.matrix ?? confirmationMatrix();
  checkedPreset(preset, matrix);
  const environment = environmentOf(input.environment, preset), rows = input.rows ?? matrix.rows;
  return input.peers.map(peer => {
    const facts = matrix.kinds[peer.kind], entry = preset.kinds[peer.kind];
    const desiredForm = nextForm(peer, environment, preset, matrix), currentForm = peer.form ?? desiredForm;
    const mode = currentForm && entry ? entry.permission[currentForm] : null;
    const desiredMode = peer.lockedMode ?? (desiredForm && entry ? entry.permission[desiredForm] : null);
    const effectiveMode = peer.permissionMode ?? (!facts || !entry || !currentForm ? "unknown" : mode === null ? "unmanaged" : "unknown");
    const missing: string[] = [];
    if (peer.lockedMode) missing.push(`The ${peer.lockedMode} permission ceiling is locked; the preset does not change it.`);
    if (!facts || !entry) missing.push(`No autonomy preset or confirmation inventory exists for kind ${peer.kind}.`);
    if (!desiredForm) missing.push(`No ${preset.environments[environment]!.matrixEnvironment} base start is available for this peer; use an explicit supported instance or a person-owned terminal.`);
    if (mode === null && facts && entry && currentForm) missing.push("Native permissions are not managed by the hub in this form; configure them in the native client.");
    else if (peer.permissionMode === undefined || peer.permissionMode === "unknown") missing.push("The current runtime permission mode is unknown.");
    if (!peer.lockedMode && desiredMode !== null && effectiveMode !== desiredMode) missing.push(`Current mode ${effectiveMode}; the preset requests ${desiredMode} for the next peer start. Apply the project defaults and restart the peer to use it.`);
    if (currentForm === "tui" && input.terminalOpener?.available !== true) missing.push(`${input.terminalOpener?.reason ?? "No verified terminal opener is available."} ${preset.environments[environment]!.instruction}`);
    const rowEnvironment = currentForm === "headless" ? "headless" : preset.environments[environment]!.matrixEnvironment;
    const applicable = rows.filter(row => row.kinds.includes(peer.kind) && row.environments.includes(rowEnvironment) && (row.form === "any" || row.form === currentForm));
    for (const row of applicable) for (const unknown of row.unknowns ?? []) missing.push(unknown);
    const classed = applicable.filter(row => row.point === "classed-action");
    const visible = classed.length > 0 && classed.every(row => row.hubSeesBeforeRun === "yes" || row.hubSeesBeforeRun === "partial");
    if (classed.length && !visible) missing.push("The confirmation inventory does not establish pre-run visibility for every turn of this form.");
    const floor = preset.floorClasses.map((action): AutonomyFloorStatus => {
      const proof = input.floorEnforcement?.[peer.id]?.[action];
      if (proof?.status === "hub-enforced" && proof.reason.trim() && peer.actionEnforcement?.enforced === true && visible) return { class: action, status: "hub-enforced", reason: proof.reason };
      if (proof?.status === "not-enforced" && proof.reason.trim()) {
        missing.push(`${action}: ${proof.reason}`);
        return { class: action, status: "not-enforced", reason: proof.reason };
      }
      const guard = peer.structuralGuards?.[action];
      if (guard?.verified === true && guard.reason.trim()) return { class: action, status: "structural-guard", reason: guard.reason };
      const reason = `Hub floor enforcement is not available until #582.${peer.actionEnforcement?.reason ? ` ${peer.actionEnforcement.reason}` : ""}`;
      missing.push(`${action}: ${reason} No verified structural guard was supplied.`);
      return { class: action, status: "not-enforced", reason };
    });
    return { id: peer.id, kind: peer.kind, form: currentForm, effectiveMode, nextForm: desiredForm, nextMode: desiredMode, applies: "next peer start", floor, missing: [...new Set(missing)] };
  });
}
