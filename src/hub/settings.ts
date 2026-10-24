import { ACTION_CLASSES } from "./action-class.ts";
import { definitionOf, type KindMap, type ProjectAdapterCatalog, ADAPTERS, PLANNER_PEERS, SUPPORTED_PEERS, START_MODE_PEERS } from "../adapters/registry.ts";
import { createHash } from "node:crypto";
import { types } from "node:util";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CLASSES, type TaskClass } from "./board.ts";
import { configTracked, configRepositoryPresent } from "./config-trust.ts";
import { PERMISSION_MODES, permissionBoundary } from "./permission-mode.ts";
import { START_MODES } from "./start-mode.ts";
import { OVERLAY_FILE, overlayToml, parseOverlay, parseRouting, routingText, type Routing, type RoutingOverlay } from "./routing.ts";

/**
 * #269: the settings a person may change from the dashboard or `ahub settings`. A key that is not in SETTINGS cannot be
 * written by either. Writes go only to the machine-local files (`.agenthub/config.local.json`,
 * `.agenthub/routing.local.toml`), never to a tracked one.
 */
export const SETTING_PEERS = SUPPORTED_PEERS;
/** `null` removes the machine-local value, so the shared file's or the default applies again. */
export type SettingValue = string | boolean | number | string[] | null;
export interface SettingDef {
  /** Fixed host policy; no authority can edit or undo this row. */
  locked?: string;
  key: string;
  group: "Permissions" | "Start" | "Routing" | "Switches" | "Roster" | "Roles";
  label: string;
  type: "enum" | "boolean" | "peers" | "roles" | "integer" | "number";
  min?: number; max?: number;
  /** The closed values of an enum; a route setting takes the project's own route ids instead. */
  values?: readonly string[];
  /** `runtime` lives in the running hub only; the others are the machine-local file that holds the value. */
  store: "runtime" | "config" | "routing";
  /** `next use` keeps an active turn/session intact; `restart` retains the running value until a new daemon. */
  applies: "live" | "next use" | "restart";
  restartReason?: string;
  /** `raises`: only a settings session or a person's terminal may set it, except to `floor`. */
  risk: "safe" | "raises";
  floor?: string | boolean | number;
  /** Where the value sits inside its file (or, for `runtime`, the peer). */
  path: readonly string[];
}

const READ_ONLY_LOCK = "read-only instance: permission mode is locked by its declaration";
const PEER = /^[a-z][a-z0-9-]{0,31}$/;
const PEERS_MAX = 8;
const perClass = (name: TaskClass): SettingDef[] => [
  { key: `routing.classes.${name}.peers`, group: "Routing", label: `${name}: owner preference order`, type: "peers", store: "routing", applies: "live", risk: "raises", path: ["classes", name, "peers"] },
  { key: `routing.classes.${name}.escalate_to`, group: "Routing", label: `${name}: escalation order`, type: "peers", store: "routing", applies: "live", risk: "raises", path: ["classes", name, "escalate_to"] },
  { key: `routing.classes.${name}.route`, group: "Routing", label: `${name}: local worker route`, type: "enum", store: "routing", applies: "live", risk: "raises", path: ["classes", name, "route"] },
  { key: `routing.classes.${name}.pi_backend`, group: "Routing", label: `${name}: Pi backend`, type: "enum", values: ["dgx", "mlx"], store: "routing", applies: "live", risk: "raises", path: ["classes", name, "pi_backend"] },
];
export const SETTINGS: readonly SettingDef[] = [
  ...["enabled", "auto_reassign"].map((key): SettingDef => ({ key: `task_sweep.${key}`, group: "Switches", label: `Task sweep: ${key}`, type: "boolean", store: "config", applies: "live", risk: "raises", floor: false, path: ["task_sweep", key] })),
  { key: "task_sweep.no_writes_turns", group: "Switches", label: "Consecutive owner turns without writes (0 disables)", type: "integer", min: 0, max: Number.MAX_SAFE_INTEGER, store: "config", applies: "live", risk: "raises", path: ["task_sweep", "no_writes_turns"] },
  ...["interval_s", "unaccepted_min", "idle_min", "review_min", "ready_min", "ladder_min"].map((key): SettingDef => ({ key: `task_sweep.${key}`, group: "Switches", label: `Task sweep: ${key}`, type: "number", min: 1, max: 2_147_483_647 / (key === "interval_s" ? 1000 : 60_000), store: "config", applies: "live", risk: "raises", path: ["task_sweep", key] })),
  ...SETTING_PEERS.map((peer): SettingDef => ({ key: `tasks.wip_limits.${peer}`, group: "Routing", label: `${peer}: planner WIP limit`, type: "integer", min: 0, max: 32, store: "config", applies: "live", risk: "raises", floor: 0, path: ["tasks", "wip_limits", peer] })),
  { key: "tasks.escalate_after", group: "Routing", label: "Escalate after N consecutive changes_requested", type: "integer", min: 1, max: 10, store: "config", applies: "live", risk: "raises", path: ["tasks", "escalate_after"] },
  { key: "planner", group: "Roles", label: "Planners (task-local selection)", type: "peers", values: PLANNER_PEERS, store: "config", applies: "live", risk: "raises", path: ["planner"] },
  ...SETTING_PEERS.map((peer): SettingDef => ({ key: `catalog_roles.${peer}`, group: "Roles", label: `${peer}: catalog guidance`, type: "roles", store: "config", applies: "next use", risk: "safe", path: ["catalog_roles", peer] })),
  { key: "scoped_grants.protect_instructions", group: "Permissions", label: "Ask before writing instruction files", type: "boolean", store: "config", applies: "live", risk: "raises", floor: true, path: ["protect_instruction_files"] },
  ...SETTING_PEERS.map((peer): SettingDef => ({ key: `roster.${peer}`, group: "Roster", label: `${peer}: participates`, type: "boolean", store: "config", applies: "live", risk: "raises", floor: false, path: ["roster", peer] })),
  { key: "action_policy.enabled", group: "Permissions", label: "Always-ask action policy", type: "boolean", store: "config", applies: "live", risk: "raises", floor: true, path: ["action_policy", "enabled"] },
  ...ACTION_CLASSES.map((kind): SettingDef => ({ key: `action_policy.budgets.${kind}`, group: "Permissions", label: `${kind}: approved session budget`, type: "integer", min: 0, max: 1000, store: "config", applies: "live", risk: "raises", floor: 0, path: ["action_policy", "budgets", kind] })),
  ...SETTING_PEERS.filter(peer => !definitionOf(peer)?.permission.unmanaged).map((peer): SettingDef => ({ key: `permission.${peer}`, group: "Permissions", label: `${peer}: mode now`, type: "enum", values: PERMISSION_MODES, store: "runtime", applies: "live", risk: "raises", floor: "ask", path: [peer] })),
  ...SETTING_PEERS.filter(peer => !definitionOf(peer)?.permission.unmanaged).map((peer): SettingDef => ({ key: `permission_modes.${peer}`, group: "Permissions", label: `${peer}: mode at next peer start`, type: "enum", values: PERMISSION_MODES, store: "config", applies: "next use", risk: "raises", floor: "ask", path: ["permission_modes", peer] })),
  ...START_MODE_PEERS.map((peer): SettingDef => ({ key: `peers.${peer}.start_mode`, group: "Start", label: `${peer}: start mode (tui unless set)`, type: "enum", values: START_MODES, store: "config", applies: "next use", risk: "raises", floor: "tui", path: ["peers", peer, "start_mode"] })),
  ...ADAPTERS.flatMap(adapter => adapter.configuration?.settings ?? []),
  { key: "routing.stay_switch", group: "Routing", label: "Stay or switch (hub/auto and stage routes)", type: "enum", values: ["off", "shadow", "enforce"], store: "routing", applies: "live", risk: "raises", path: ["stay_switch"] },
  ...CLASSES.flatMap(perClass),
  { key: "research.enabled", group: "Switches", label: "Research records", type: "boolean", store: "config", applies: "live", risk: "safe", path: ["research", "enabled"] },
  { key: "approvals.notify", group: "Switches", label: "Desktop notice for a waiting approval", type: "boolean", store: "config", applies: "live", risk: "safe", path: ["approvals", "notify"] },
  { key: "snapshots.enabled", group: "Switches", label: "Per-turn snapshots", type: "boolean", store: "config", applies: "live", risk: "safe", path: ["snapshots", "enabled"] },
  { key: "coordination", group: "Switches", label: "Coordination of overlapping owners", type: "enum", values: ["advisory", "turn-free"], store: "config", applies: "next use", risk: "safe", path: ["coordination"] },
];

/**
 * Never editable from settings, whatever the session: these choose what the hub executes or where secrets and task
 * text go. A key equal to an entry, or below it, is refused by name.
 */
export const NEVER_EDITABLE = ["kimi_cmd", "qwen_cmd", "jcode_cmd", "jcode_home", "jcode_provider_profile", "codex_bin", "pi.cmd", "checks", "mlx", "omniroute", "memory.worker_url", "local.read_allow", "local.bash_network", "local.network_allow", "bench.enabled", "terminal", "instances", "adapters", "adapter_modules"] as const;

/** Derive project-bound rows from the same builtin templates used by lookup, without registering aliases globally. */
export function projectSettings(instances?: KindMap, adapterCatalog?: ProjectAdapterCatalog): readonly SettingDef[] {
  const resolve = adapterCatalog?.definitionOf ?? definitionOf;
  const extra: SettingDef[] = [];
  const plannerValues = [...PLANNER_PEERS];
  const headless = (peer: string): SettingDef => Object.freeze({ key: `peers.${peer}.start_mode`, group: "Start", label: `${peer}: start mode (headless only)`,
    type: "enum", values: Object.freeze(["headless"]), store: "config", applies: "next use", risk: "raises", floor: "headless", path: Object.freeze(["peers", peer, "start_mode"]) });
  for (const adapter of adapterCatalog?.definitions ?? []) {
    if (definitionOf(adapter.kind)) continue;
    const peer = adapter.kind;
    extra.push(
      { key: `roster.${peer}`, group: "Roster", label: `${adapter.displayName} (${peer}): participates`, type: "boolean", store: "config", applies: "live", risk: "raises", floor: false, path: ["roster", peer] },
      { ...SETTINGS.find(def => def.key.startsWith("tasks.wip_limits."))!, key: `tasks.wip_limits.${peer}`, label: `${peer}: planner WIP limit`, path: ["tasks", "wip_limits", peer] },
      headless(peer),
    );
    const values = Object.keys(adapter.permission.genericAcp?.modes ?? {});
    if (!adapter.permission.unmanaged && values.length) for (const runtime of [true, false]) extra.push({
      key: `${runtime ? "permission" : "permission_modes"}.${peer}`, group: "Permissions", label: `${peer}: mode ${runtime ? "now" : "at next peer start"}`,
      type: "enum", values, store: runtime ? "runtime" : "config", applies: runtime ? "live" : "next use", risk: "raises", ...(values.includes("ask") ? { floor: "ask" } : {}), path: runtime ? [peer] : ["permission_modes", peer],
    });
  }
  const baseSettings = [...SETTINGS, ...extra];
  const validInstances = instances && typeof instances === "object" && !types.isProxy(instances) && !Array.isArray(instances)
    && [Object.prototype, null].includes(Object.getPrototypeOf(instances)) && !Object.getOwnPropertySymbols(instances).length;
  for (const peer of validInstances ? Object.keys(instances!) : []) {
    if (resolve(peer)) continue; // An explicit declaration never changes a canonical setting definition.
    const adapter = resolve(peer, instances);
    if (!adapter) continue;
    const entry = Object.getOwnPropertyDescriptor(instances!, peer)?.value;
    if (PEER.test(peer) && peer.startsWith(`${adapter.kind}-`) && /^[a-z0-9][a-z0-9-]*$/.test(peer.slice(adapter.kind.length + 1))
      && adapter.projection?.plannerEligible === true
      && (!adapter.instances?.roles || adapter.instances.roles.includes("planner"))
      && (!adapter.routing?.allowedRoles || adapter.routing.allowedRoles.includes("planner"))) plannerValues.push(peer);
    const readOnly = entry && typeof entry === "object" && !types.isProxy(entry) && Object.getOwnPropertyDescriptor(entry, "readOnly")?.value === true && !!adapter.permission.genericAcp?.readOnly;
    const copy = (base: SettingDef, key: string): SettingDef => Object.freeze({ ...base, key,
      label: base.label.replace(`${adapter.kind}:`, `${peer}:`),
      path: Object.freeze(base.path.map(part => part === adapter.kind ? peer : part)),
      ...(base.values ? { values: Object.freeze([...base.values]) } : {}),
    });
    for (const prefix of ["roster", "permission", "permission_modes", "tasks.wip_limits"]) {
      if (readOnly && (prefix === "permission" || prefix === "permission_modes")) continue;
      const base = baseSettings.find(def => def.key === `${prefix}.${adapter.kind}`);
      if (base) extra.push(copy(base, `${prefix}.${peer}`));
    }
    if (readOnly) for (const runtime of [true, false]) extra.push(Object.freeze({
      key: `${runtime ? "permission" : "permission_modes"}.${peer}`, group: "Permissions", label: `${peer}: read-only (locked)`,
      type: "enum", values: Object.freeze(["read-only"]), store: runtime ? "runtime" : "config", applies: runtime ? "live" : "next use", risk: "safe",
      path: Object.freeze(runtime ? [peer] : ["permission_modes", peer]), locked: READ_ONLY_LOCK,
    } satisfies SettingDef));
    extra.push(headless(peer));
  }
  const settings = plannerValues.length === PLANNER_PEERS.length ? SETTINGS : SETTINGS.map(def => def.key === "planner"
    ? Object.freeze({ ...def, values: Object.freeze(plannerValues) }) : def);
  return extra.length ? Object.freeze([...settings, ...extra]) : settings;
}

/** The definition of a key, or why there is none. */
export function settingDef(key: unknown, instances?: KindMap, adapterCatalog?: ProjectAdapterCatalog): SettingDef | string {
  if (typeof key !== "string" || key.length > 80) return "unknown setting";
  const found = projectSettings(instances, adapterCatalog).find((s) => s.key === key);
  if (found) return found;
  if (NEVER_EDITABLE.some((never) => key === never || key.startsWith(`${never}.`))) return `${key} chooses what the hub runs or where secrets and task text go: it is never editable from settings; edit .agenthub/config.local.json in your editor`;
  return "unknown setting; run ahub settings list";
}

/** The checked value, or a thrown reason. `routes`: the route ids the project's routing defines. */
export function checkSettingValue(def: SettingDef, raw: unknown, routes: readonly string[] = []): SettingValue {
  if (def.locked) throw new Error(def.locked);
  if (raw === null) {
    if (def.store === "runtime") throw new Error(`${def.key} has no stored value to remove`);
    return null;
  }
  if (def.type === "integer" || def.type === "number") {
    if (typeof raw !== "number" || !(def.type === "integer" ? Number.isSafeInteger(raw) : Number.isFinite(raw)) || raw < (def.min ?? 0) || raw > (def.max ?? Number.MAX_SAFE_INTEGER)) throw new Error(`${def.key} takes ${def.type === "integer" ? "an integer" : "a number"} from ${def.min ?? 0} to ${def.max ?? Number.MAX_SAFE_INTEGER}`);
    return raw;
  }
  if (def.type === "boolean") {
    if (typeof raw !== "boolean") throw new Error(`${def.key} takes true or false`);
    return raw;
  }
  if (def.type === "roles") {
    const allowed = def.values ?? routes;
    if (!Array.isArray(raw) || raw.length > 2 || new Set(raw).size !== raw.length || raw.some(id => typeof id !== "string" || !allowed.includes(id))) throw new Error(`${def.key} takes at most two distinct compatible catalog ids; allowed: ${allowed.join(", ") || "(none)"}`);
    return [...raw] as string[];
  }
  if (def.type === "peers") {
    if (def.key === "planner") {
      const peers = typeof raw === "string" ? [raw] : raw;
      if (!Array.isArray(peers) || peers.length === 0 || peers.length > PEERS_MAX || new Set(peers).size !== peers.length
        || peers.some(peer => typeof peer !== "string" || !PEER.test(peer) || !(def.values ?? PLANNER_PEERS).includes(peer))) {
        throw new Error(`${def.key} must be one of ${(def.values ?? PLANNER_PEERS).join(", ")}, or a list of one to ${PEERS_MAX} distinct eligible planner peer ids`);
      }
      return peers.length === 1 ? peers[0] as string : [...peers] as string[];
    }
    if (!Array.isArray(raw) || raw.length > PEERS_MAX || raw.some((p) => typeof p !== "string" || !PEER.test(p)) || new Set(raw).size !== raw.length) throw new Error(`${def.key} takes up to ${PEERS_MAX} distinct peer ids`);
    return [...(raw as string[])];
  }
  const values = def.values ?? routes;
  if (typeof raw !== "string" || !values.includes(raw)) throw new Error(`${def.key} takes one of: ${values.join(", ") || "(the project defines no route)"}`);
  return raw;
}

/** A terminal's text for a value: `inherit` removes the machine-local value, a peers setting takes a comma list. */
export function parseSettingText(def: SettingDef, text: string): unknown {
  if (text === "inherit") return null;
  if (def.type === "number") return text.trim() && Number.isFinite(Number(text)) ? Number(text) : text;
  if (def.type === "integer") return /^(0|[1-9]\d*)$/.test(text) ? Number(text) : text;
  if (def.type === "boolean") return text === "true" ? true : text === "false" ? false : text;
  if (def.type === "peers" || def.type === "roles") return text.split(",").map((p) => p.trim()).filter(Boolean);
  return text;
}
export const settingText = (value: unknown): string => value === null || value === undefined ? "(not set)" : Array.isArray(value) ? value.join(",") || "(none)" : String(value);

/** `ordinary`: a dashboard session from `ahub ui`. `settings`: one from `ahub ui --settings`. `terminal`: `ahub settings`. */
export type SettingAuthority = "ordinary" | "settings" | "terminal";
/** Why this authority may not set this value, or undefined. Removing a stored value can raise, so it counts as one. */
export function settingRefusal(def: SettingDef | string, value: SettingValue, authority: SettingAuthority): string | undefined {
  if (typeof def === "string") return def || "invalid setting definition";
  if (def.locked) return def.locked;
  if (def.risk === "safe" || authority !== "ordinary") return undefined;
  if (value !== null && value === def.floor) return undefined;
  return `${def.key} can widen what agents do without asking: open a settings session with ahub ui --settings, or use ahub settings in a terminal`;
}

const CONFIG_LOCAL = "config.local.json";
type StoredFile = typeof CONFIG_LOCAL | typeof OVERLAY_FILE;
interface UndoRecord { file: StoredFile; key: string; previous: string | null; written: string | null; at: number }
const undoFile = (stateDir: string): string => join(stateDir, "settings-undo.json");
const digest = (text: string | null): string | null => text === null ? null : createHash("sha256").update(text).digest("hex");
/** The file's text, or null when it is not there. Any other failure is named by its code: its own text holds absolute paths. */
const readText = (file: string): string | null => {
  try { return readFileSync(file, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`.agenthub/${basename(file)} could not be read (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`);
  }
};
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function parseObject(text: string, name: string): Record<string, unknown> {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { throw new Error(`.agenthub/${name} is not valid JSON; fix it in your editor first`); }
  if (!isObject(doc)) throw new Error(`.agenthub/${name} must hold a JSON object`);
  return doc;
}
/** Temp file and rename in the same directory: a reader sees the old file or the new one, never half of it. */
function atomicWrite(file: string, text: string): void {
  let mode = 0o600;
  try { mode = statSync(file).mode & 0o777; } catch { /* a new file is the owner's alone */ }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, { mode, flag: "wx" });
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* nothing was written */ }
    throw error;
  }
}
/** A settings write never changes a file git tracks: the machine-local files are meant to stay out of the repository. */
function refuseTracked(cwd: string, file: StoredFile): void {
  const tracked = configTracked(cwd, file);
  if (tracked) throw new Error(`.agenthub/${file} is committed to git; settings write only machine-local files. Remove it from the repository (git rm --cached) and ignore it`);
  // Unknown is not untracked where there is a repository to ask; only a project outside git has nothing tracked.
  if (tracked === undefined && configRepositoryPresent(cwd)) throw new Error(`git could not confirm that .agenthub/${file} is untracked; nothing was written`);
}
/** Keeps the one previous version, then replaces (or removes) the file. */
function store(cwd: string, stateDir: string, file: StoredFile, key: string, previous: string | null, next: string | null): void {
  refuseTracked(cwd, file);
  replaceFile(join(cwd, ".agenthub", file), file, next);
  // The record follows the file: a write that failed leaves the earlier record valid, because the file is as it left it.
  const record: UndoRecord = { file, key, previous, written: digest(next), at: Date.now() };
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    rmSync(undoFile(stateDir), { force: true });
    writeFileSync(undoFile(stateDir), JSON.stringify(record), { mode: 0o600 });
  } catch {
    rmSync(undoFile(stateDir), { force: true }); // this write has no undo, and an older record must not offer one
  }
}
/** Replaces or removes the file. A file-system failure is reported by its code only: its text names absolute paths, and this reaches the dashboard. */
function replaceFile(path: string, file: StoredFile, text: string | null): void {
  try {
    if (text === null) rmSync(path, { force: true });
    else atomicWrite(path, text);
  } catch (error) {
    throw new Error(`.agenthub/${file} could not be written (${(error as NodeJS.ErrnoException).code ?? "unknown error"}); nothing was changed`);
  }
}

/** The value a config file holds at a path, or undefined. */
export function valueAt(doc: unknown, path: readonly string[]): unknown {
  let node = doc;
  for (const part of path) {
    if (!isObject(node) || !Object.hasOwn(node, part)) return undefined;
    node = node[part];
  }
  return node;
}

/**
 * Sets (or with null removes) one key of `.agenthub/config.local.json`. `validate` gets a scratch project that holds
 * the shared config and the candidate, and throws when the hub's own loader would refuse it: nothing is written then.
 */
export function writeConfigSetting(cwd: string, stateDir: string, def: SettingDef, value: SettingValue, validate: (scratch: string) => unknown): boolean {
  const file = join(cwd, ".agenthub", CONFIG_LOCAL);
  const before = readText(file);
  const doc = before === null ? {} : parseObject(before, CONFIG_LOCAL);
  // Nothing to change: no file is created or rewritten, and the undo record keeps the last real write.
  const held = valueAt(doc, def.path);
  if (value === null ? held === undefined : same(held, value)) return false;
  // The loader gives a project that has any config file its project defaults (snapshots, limits, the budget relay,
  // the approval notice). A settings write must not be what silently makes the first one.
  if (before === null && !existsSync(join(cwd, ".agenthub", "config.json"))) throw new Error("this project has no .agenthub/config.json: run ahub init first. A first config file also turns on the project defaults (snapshots, limits, the budget relay), which a settings write does not do for you");
  let node = doc;
  const trail: [Record<string, unknown>, string][] = [];
  for (const part of def.path.slice(0, -1)) {
    if (node[part] === undefined) {
      if (value === null) { node = {}; break; } // nothing to remove below a block that is not there
      node[part] = {};
    }
    const next = node[part];
    if (!isObject(next)) throw new Error(`.agenthub/${CONFIG_LOCAL}: ${part} is not an object; fix it in your editor first`);
    trail.push([node, part]);
    node = next;
  }
  const leaf = def.path.at(-1)!;
  if (value === null) {
    delete node[leaf];
    // A block the removal emptied goes with it, so setting a value and removing it again leaves the file as it was.
    for (const [parent, part] of trail.reverse()) {
      if (Object.keys(parent[part] as object).length) break;
      delete parent[part];
    }
  } else node[leaf] = value;
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  checkConfigText(cwd, text, validate);
  store(cwd, stateDir, CONFIG_LOCAL, def.key, before, text);
  return true;
}
/** Runs `validate` on a scratch project holding the shared config and this candidate for the machine-local one. */
function checkConfigText(cwd: string, text: string | null, validate: (scratch: string) => unknown): void {
  const scratch = mkdtempSync(join(tmpdir(), "ahub-settings-"));
  try {
    mkdirSync(join(scratch, ".agenthub"));
    if (existsSync(join(cwd, ".agenthub", "config.json"))) copyFileSync(join(cwd, ".agenthub", "config.json"), join(scratch, ".agenthub", "config.json"));
    if (text !== null) writeFileSync(join(scratch, ".agenthub", CONFIG_LOCAL), text);
    validate(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Sets (or with null removes) one key of `.agenthub/routing.local.toml`; the real parser reads the result first, and
 * `check` may refuse the policy it yields. Undefined when the overlay already holds that value: nothing is written.
 */
export function writeRoutingSetting(cwd: string, stateDir: string, def: SettingDef, value: SettingValue, check?: (routing: Routing, overlay?: RoutingOverlay) => void): Routing | undefined {
  const file = join(cwd, ".agenthub", OVERLAY_FILE);
  const before = readText(file);
  const current = before === null ? {} : parseOverlay(before);
  const held = def.path[0] === "stay_switch" ? current.stay_switch : (current.classes?.[def.path[1] as TaskClass] as Record<string, unknown> | undefined)?.[def.path[2]!];
  if (value === null ? held === undefined : same(held, value)) return undefined;
  const overlay = routingCandidate(current, def, value);
  const routing = parseRouting(routingText(cwd), overlay);
  check?.(routing, overlay);
  const empty = !overlay.stay_switch && !Object.keys(overlay.classes ?? {}).length;
  store(cwd, stateDir, OVERLAY_FILE, def.key, before, empty ? null : overlayToml(overlay));
  return routing;
}
/** An overlay with one key set or removed: the candidate a write stores and a preview only reads. */
export function routingCandidate(current: RoutingOverlay, def: SettingDef, value: SettingValue): RoutingOverlay {
  const overlay: RoutingOverlay = { ...(current.stay_switch ? { stay_switch: current.stay_switch } : {}), classes: Object.fromEntries(Object.entries(current.classes ?? {}).map(([name, entry]) => [name, { ...entry }])) };
  if (def.path[0] === "stay_switch") {
    if (value === null) delete overlay.stay_switch;
    else overlay.stay_switch = value as RoutingOverlay["stay_switch"];
    return overlay;
  }
  const [, name, field] = def.path as [string, TaskClass, "peers" | "escalate_to" | "route" | "pi_backend"];
  const entry: Record<string, unknown> = { ...overlay.classes![name] };
  if (value === null) delete entry[field];
  else entry[field] = value;
  if (Object.keys(entry).length) overlay.classes![name] = entry;
  else delete overlay.classes![name];
  return overlay;
}
/** The overlay on disk, or an empty one. */
export function readOverlay(cwd: string): RoutingOverlay {
  const text = readText(join(cwd, ".agenthub", OVERLAY_FILE));
  return text === null ? {} : parseOverlay(text);
}

/**
 * Puts back the one previous version of the file the last settings write changed. Refused when the file changed since
 * that write (a hand edit would be lost), when the loaders no longer accept that version, or when there is nothing to undo.
 */
export interface UndoIdentity { key: string; undoDigest: string }
export function undoSetting(cwd: string, stateDir: string, validate: (scratch: string) => unknown, checkRouting?: (routing: Routing, overlay?: RoutingOverlay) => void, expected?: UndoIdentity): { key: string; file: StoredFile } {
  const raw = readText(undoFile(stateDir));
  if (raw === null) throw new Error("nothing to undo");
  let record: UndoRecord;
  try { record = JSON.parse(raw) as UndoRecord; } catch { throw new Error("nothing to undo"); }
  if (expected && (record.key !== expected.key || digest(raw) !== expected.undoDigest)) throw new Error("undo record changed since preview; preview again; nothing was undone");
  if (record.file !== CONFIG_LOCAL && record.file !== OVERLAY_FILE) throw new Error("nothing to undo");
  const path = join(cwd, ".agenthub", record.file);
  if (digest(readText(path)) !== record.written) throw new Error(`.agenthub/${record.file} changed since the last settings write; nothing was undone`);
  if (record.previous !== null && typeof record.previous !== "string") throw new Error("nothing to undo");
  refuseTracked(cwd, record.file);
  if (record.file === OVERLAY_FILE) {
    // The parser always reads what is put back; the caller's check is on top of it.
    const overlay = record.previous === null ? undefined : parseOverlay(record.previous);
    const restored = parseRouting(routingText(cwd), overlay);
    checkRouting?.(restored, overlay);
  }
  else checkConfigText(cwd, record.previous, validate);
  if (expected && readText(undoFile(stateDir)) !== raw) throw new Error("undo record changed since preview; preview again; nothing was undone");
  replaceFile(path, record.file, record.previous);
  rmSync(undoFile(stateDir), { force: true });
  return { key: String(record.key), file: record.file };
}
/** Whether the machine-local config file holds a value for this setting now. */
export function storedLocally(cwd: string, def: SettingDef): boolean {
  try { return valueAt(JSON.parse(readFileSync(join(cwd, ".agenthub", CONFIG_LOCAL), "utf8")), def.path) !== undefined; } catch { return false; }
}
/** What the shared `.agenthub/config.json` holds for the key, or undefined: a removal here only ever touches the machine-local file. */
export function sharedValue(cwd: string, def: SettingDef): unknown {
  try { return valueAt(JSON.parse(readFileSync(join(cwd, ".agenthub", "config.json"), "utf8")), def.path); } catch { return undefined; }
}
/**
 * For a config setting: the value the config files would hold for it after the pending undo (the previous version of
 * the machine-local file, else the shared file), or, with `inherit`, after the machine-local value is removed (the
 * shared file's). Undefined when neither sets it or nothing reads.
 */
export function restoredValue(cwd: string, stateDir: string, def: SettingDef, inherit = false): unknown {
  const parse = (text: string | null): unknown => { try { return text === null ? {} : JSON.parse(text); } catch { return {}; } };
  let local: unknown = {};
  if (!inherit) {
    try { const record = JSON.parse(readFileSync(undoFile(stateDir), "utf8")) as UndoRecord;
      if (record.file === OVERLAY_FILE && def.store === "routing") return valueAt(parseRouting(routingText(cwd), record.previous === null ? undefined : parseOverlay(record.previous)), def.path);
      if (record.file !== CONFIG_LOCAL) return undefined; local = parse(record.previous);
    } catch { return undefined; }
  }
  return valueAt(local, def.path) ?? valueAt(parse(readText(join(cwd, ".agenthub", "config.json"))), def.path);
}
/** The key the next undo would put back, if any. */
export function pendingUndo(stateDir: string): string | undefined {
  return pendingUndoIdentity(stateDir)?.key;
}
/** Snapshot identity of the exact record, including its previous bytes, file and write time. */
export function pendingUndoIdentity(stateDir: string): UndoIdentity | undefined {
  try {
    const raw = readFileSync(undoFile(stateDir), "utf8"), record = JSON.parse(raw) as UndoRecord;
    return typeof record.key === "string" && record.key.length > 0 ? { key: record.key, undoDigest: digest(raw)! } : undefined;
  } catch { return undefined; }
}

/** The loader's line saying it ignored this setting's field in the machine-local file, if it did (config trust, #17). */
export function ignoredLine(ignored: readonly string[] | undefined, def: SettingDef): string | undefined {
  return ignored?.find((line) => {
    const at = line.indexOf(` in .agenthub/${CONFIG_LOCAL} ignored:`);
    return at > 0 && line.slice(0, at).split(", ").some((field) => field === def.path[0] || field === def.path.slice(0, 2).join("."));
  });
}
export interface SettingRow {
  locked?: string;
  key: string; group: SettingDef["group"]; label: string; type: SettingDef["type"]; values?: readonly string[]; min?: number; max?: number;
  /** The file a write goes to, or "this hub run". */
  file: string;
  applies: SettingDef["applies"] | "peer start" | "hub start"; risk: SettingDef["risk"]; floor?: string | boolean | number;
  /** What is in force now; null when nothing sets it. */
  value: SettingValue;
  /** Optional for replies from pre-#439 daemons; current projections always supply it. */
  fileValue?: SettingValue;
  restartReason?: string;
  /** Which file the value in force comes from. */
  source: string;
  /** The stored value the next hub start reads, when it differs from the one in force. */
  pending?: SettingValue;
  /** Why the row cannot be changed now. */
  note?: string;
  /** For a permission row: the bounds the peer's tools run in, whatever the mode. */
  hint?: string;
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * One row per setting, for the dashboard and `ahub settings list`. `running` is the configuration the hub started
 * with, `next` what its loader reads from the files now (undefined when they do not load), `mode` a peer's mode now.
 */
export function settingRows(input: {
  cwd: string; routing: Routing;
  /** Captured trusted declarations for this daemon/project, never taken from a settings request. */
  instances?: KindMap;
  adapterCatalog: ProjectAdapterCatalog;
  running: (path: readonly string[]) => unknown;
  next: ((path: readonly string[]) => unknown) | undefined;
  mode: (peer: string) => { value?: string; note?: string };
  /** Why the overlay does not load, when it does not: the rows then show the last policy that did. */
  routingProblem?: string;
  /** The loader's own lines about machine-local fields it ignored (`HubConfig.ignored`). */
  ignored?: string[];
  roles?: (peer: string) => { value: SettingValue; pending?: SettingValue; values: string[]; note?: string };
}): SettingRow[] {
  const raw = (name: string): unknown => { try { return JSON.parse(readFileSync(join(input.cwd, ".agenthub", name), "utf8")); } catch { return undefined; } };
  const local = raw(CONFIG_LOCAL), shared = raw("config.json");
  const projectRouting = existsSync(join(input.cwd, ".agenthub", "routing.toml"));
  const routes = Object.keys(input.routing.hub_routes ?? {});
  const scalar = (value: unknown): SettingValue => typeof value === "string" || typeof value === "boolean" || typeof value === "number" ? value : Array.isArray(value) ? value.map(String) : null;
  return projectSettings(input.instances, input.adapterCatalog).map((def): SettingRow => {
    const base = { key: def.key, group: def.group, label: def.label, type: def.type, ...(["integer", "number"].includes(def.type) ? { min: def.min, max: def.max } : {}), applies: def.applies, ...(def.restartReason ? { restartReason: def.restartReason } : {}), risk: def.risk, ...(def.floor === undefined ? {} : { floor: def.floor }),
      ...(def.key === "scoped_grants.protect_instructions" ? { hint: "AGENTS.md, CLAUDE.md and QWEN.md remain grantable by default; enabling this asks before scoped writes and edits" } : def.key.startsWith("action_policy.") ? { hint: "enforced for Claude (PreToolUse hook) and hub-owned ACP peers in ask mode; ahub status lists each peer that is not enforceable" } : def.group === "Permissions" ? { hint: permissionBoundary(def.path.at(-1)!, input.instances, input.adapterCatalog) } : {}) };
    if (def.locked) return { ...base, values: def.values, file: def.store === "runtime" ? "this hub run" : CONFIG_LOCAL,
      source: "instance declaration", value: "read-only", fileValue: "read-only", locked: def.locked, note: def.locked };
    if (def.store === "runtime") {
      const mode = input.mode(def.path[0]!);
      return { ...base, values: def.values!, file: "this hub run", value: mode.value ?? null, fileValue: mode.value ?? null, source: "this hub run", ...(mode.note ? { note: mode.note } : {}) };
    }
    if (def.store === "routing") {
      const value = scalar(def.path[0] === "stay_switch" ? input.routing.stay_switch : (input.routing.classes[def.path[1] as TaskClass] as Record<string, unknown> | undefined)?.[def.path[2]!]);
      return { ...base, ...(def.type === "enum" ? { values: def.values ?? routes } : {}), file: OVERLAY_FILE, value, fileValue: value, source: input.routing.sources?.[def.key.slice("routing.".length)] ?? (value === null ? "default" : projectRouting ? "routing.toml" : "default"),
        ...(input.routingProblem ? { note: `the routing files do not load, so the last policy that did stays in force: ${input.routingProblem}` } : {}) };
    }
    if (def.type === "roles" && input.roles) { const roles = input.roles(def.path[1]!); return { ...base, ...roles, fileValue: roles.pending !== undefined ? roles.pending : roles.value, file: CONFIG_LOCAL, source: valueAt(local, def.path) !== undefined ? CONFIG_LOCAL : valueAt(shared, def.path) !== undefined ? "config.json" : "profile/default", hint: "Guidance only; grants no tool or permission. At most two roles, applied at the next peer start." }; }
    const value = scalar(input.running(def.path));
    const stored = input.next ? scalar(input.next(def.path)) : value;
    const source = valueAt(local, def.path) !== undefined ? CONFIG_LOCAL : !def.key.startsWith("action_policy.") && valueAt(shared, def.path) !== undefined ? "config.json" : "default";
    const dropped = ignoredLine(input.ignored, def);
    return { ...base, ...(def.values ? { values: def.values } : {}), file: CONFIG_LOCAL, value, fileValue: stored, source, ...(same(value, stored) ? {} : { pending: stored }),
      ...(!input.next ? { note: "the config files do not load; fix them in your editor" } : dropped ? { note: `the hub does not read this value: ${dropped}` } : {}) };
  });
}
