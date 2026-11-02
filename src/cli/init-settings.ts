/**
 * #1065 T1: the settings `ahub init` can set, as one table. A row names the flag, the file and key it writes, the closed set of values it accepts and how
 * to read it back, so a new setting (the specs rows of #1064 T3) is one more row here and nothing else. Executables, secrets, models, providers, instances
 * and permissions are deliberately not rows: they stay file edits.
 *
 * Pure: this module reads and writes no file. `planInitSettings` takes the current text of the three files and returns the next text of those it changes
 * plus one row per changed key (`{ key, file, from, to }`, values from closed sets, so nothing secret can appear in a preview).
 */
import { checkStartAgents, START_AGENTS_ALLOWED } from "../hub/start-agents.ts";
import { editSdlcText } from "../hub/config-edit.ts";
import { ADAPTERS } from "../adapters/registry.ts";

export type InitSettingFile = "config.json" | "config.local.json" | "sdlc.toml";
export const SDLC_MODES = ["off", "advise", "enforce"] as const;
export const COORDINATION_MODES = ["advisory", "turn-free"] as const;
export const AUTONOMY_CHOICES = ["inherit", "off"] as const;

/** One changed key, as `ahub init --dry-run --json` shows it. `from` is `undefined` (absent in JSON) when the key was not set before. */
export interface InitSettingRow { key: string; file: InitSettingFile; from: unknown; to: unknown }

interface InitSettingDef {
  /** The request key and the row's `key` (the config path, dotted). */
  id: string;
  /** Flags that set it, with the value each gives: a value flag reads its argument, a switch gives a fixed value. */
  flags: readonly { flag: string; value?: unknown }[];
  file: InitSettingFile;
  /** The key's path inside the file. */
  path: readonly string[];
  /** The closed set shown in a refusal, and in help. */
  allowed: string;
  /** Reads a flag's text into the value to write, or throws a reason that names the allowed values. */
  parse(text: string): unknown;
  /** What the setting is, for a refusal or a plan line. */
  describe: string;
}

const choice = <T extends string>(id: string, flag: string, values: readonly T[]) => (text: string): T => {
  if ((values as readonly string[]).includes(text)) return text as T;
  throw new Error(`${flag}: "${text.slice(0, 48)}" is not ${values.join(", ")}; nothing was written`);
};

export const INIT_SETTINGS: readonly InitSettingDef[] = [
  { id: "start.agents", flags: [{ flag: "--agents" }], file: "config.local.json", path: ["start", "agents"], allowed: `${START_AGENTS_ALLOWED.join(", ")} or none`, describe: "agents ahub up starts",
    parse: text => {
      const words = text.split(/[\s,]+/).filter(Boolean);
      try { return checkStartAgents(words.length === 1 && words[0] === "none" ? [] : words, "--agents"); }
      catch (error) { throw new Error(`${(error as Error).message}; allowed: ${START_AGENTS_ALLOWED.join(", ")} or none; nothing was written`); }
    } },
  { id: "sdlc.mode", flags: [{ flag: "--sdlc" }], file: "sdlc.toml", path: ["mode"], allowed: SDLC_MODES.join("|"), describe: "SDLC mode", parse: choice("sdlc.mode", "--sdlc", SDLC_MODES) },
  { id: "coordination", flags: [{ flag: "--coordination" }], file: "config.json", path: ["coordination"], allowed: COORDINATION_MODES.join("|"), describe: "coordination mode", parse: choice("coordination", "--coordination", COORDINATION_MODES) },
  { id: "memory.enabled", flags: [{ flag: "--memory", value: true }, { flag: "--no-memory", value: false }], file: "config.json", path: ["memory", "enabled"], allowed: "on|off", describe: "shared memory", parse: () => { throw new Error("unreachable"); } },
  { id: "snapshots.enabled", flags: [{ flag: "--snapshots", value: true }, { flag: "--no-snapshots", value: false }], file: "config.json", path: ["snapshots", "enabled"], allowed: "on|off", describe: "per-turn snapshots", parse: () => { throw new Error("unreachable"); } },
  // One row per adapter that still has a legacy `<kind>.enabled` switch in config.json (its definition says so with `enabledSwitchStartOnly`): no peer is named here, so a second
  // such adapter gets its `--<kind>` / `--no-<kind>` flags and its row from its own definition (#451: peer policy lives in the registry, not in generic code).
  ...ADAPTERS.filter(definition => definition.enabledSwitchStartOnly === true).map((definition): InitSettingDef => ({
    id: `${definition.kind}.enabled`, flags: [{ flag: `--${definition.kind}`, value: true }, { flag: `--no-${definition.kind}`, value: false }],
    file: "config.json", path: [definition.kind, "enabled"], allowed: "on|off", describe: `the ${definition.displayName} peer`, parse: () => { throw new Error("unreachable"); },
  })),
];

/** `--autonomy inherit|off` is not a config key: it decides whether a new project inherits the machine's autonomy preset (person-only, main.ts applies it). */
export interface InitSettingsRequest {
  /** Keyed by `InitSettingDef.id`; absent means "not asked for", which on an existing project changes nothing. */
  values: Record<string, unknown>;
  autonomy?: typeof AUTONOMY_CHOICES[number];
}

/** The usage line `ahub init` prints for a bad argument; help.ts shows the same flags. */
export const INIT_USAGE = "usage: ahub init [--profile dev|research|writing|general|<pack>] [--agents <a,b,...|none>] [--sdlc off|advise|enforce] [--coordination advisory|turn-free] [--memory|--no-memory] [--snapshots|--no-snapshots] [--pi|--no-pi] [--autonomy inherit|off] [--shadow] [--release-guard] [--dry-run --json]";

/** Every flag the table and the two non-key choices own, for the caller's own argument loop and for help. */
export const INIT_SETTING_FLAGS: readonly string[] = [...INIT_SETTINGS.flatMap(row => row.flags.map(flag => flag.flag)), "--autonomy"];

/**
 * Separates the setting flags from the rest of an `ahub init` argv. A value flag takes the next word; a switch takes none. A flag given twice with different
 * values is refused, so the last one never silently wins. Throws a reason that names the allowed values.
 */
export function parseInitSettings(args: readonly string[]): { request: InitSettingsRequest; rest: string[] } {
  const request: InitSettingsRequest = { values: {} };
  const rest: string[] = [];
  const set = (id: string, flag: string, value: unknown) => {
    if (Object.hasOwn(request.values, id) && JSON.stringify(request.values[id]) !== JSON.stringify(value)) throw new Error(`${flag} conflicts with another flag for ${id}; give one; nothing was written`);
    request.values[id] = value;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--autonomy") {
      const text = args[++i];
      if (text === undefined) throw new Error(`--autonomy needs a value: ${AUTONOMY_CHOICES.join("|")}; nothing was written`);
      if (!(AUTONOMY_CHOICES as readonly string[]).includes(text)) throw new Error(`--autonomy: "${text.slice(0, 48)}" is not ${AUTONOMY_CHOICES.join(", ")}; nothing was written`);
      if (request.autonomy !== undefined && request.autonomy !== text) throw new Error("--autonomy was given twice with different values; give one; nothing was written");
      request.autonomy = text as typeof AUTONOMY_CHOICES[number];
      continue;
    }
    const row = INIT_SETTINGS.find(def => def.flags.some(flag => flag.flag === arg));
    if (!row) { rest.push(arg); continue; }
    const flag = row.flags.find(entry => entry.flag === arg)!;
    if ("value" in flag) { set(row.id, arg, flag.value); continue; }
    const text = args[++i];
    if (text === undefined) throw new Error(`${arg} needs a value: ${row.allowed}; nothing was written`);
    set(row.id, arg, row.parse(text));
  }
  return { request, rest };
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const valueAt = (doc: Record<string, unknown>, path: readonly string[]): unknown => path.reduce<unknown>((at, key) => isObject(at) ? at[key] : undefined, doc);

// ---- A text-level JSON editor: it changes one key and leaves every other byte of the file where it was (AC2: the formatting of untouched keys is preserved). ----
// The input is always text JSON.parse already accepted, so the scanner only has to find where values start and end.
const skip = (text: string, at: number): number => { while (at < text.length && /\s/.test(text[at]!)) at++; return at; };
function stringEnd(text: string, at: number): number { at++; while (text[at] !== '"') { if (text[at] === "\\") at++; at++; } return at + 1; }
interface Member { key: string; keyStart: number; valueStart: number; valueEnd: number }
interface ObjectSpan { start: number; end: number; members: Member[] }
function valueEnd(text: string, from: number): number {
  let at = skip(text, from);
  const c = text[at];
  if (c === '"') return stringEnd(text, at);
  if (c === "{") return objectSpan(text, at).end;
  if (c === "[") {
    at = skip(text, at + 1);
    if (text[at] === "]") return at + 1;
    for (;;) { at = skip(text, valueEnd(text, at)); if (text[at] === ",") { at = skip(text, at + 1); continue; } return at + 1; }
  }
  while (at < text.length && !/[\s,\]}]/.test(text[at]!)) at++;
  return at;
}
function objectSpan(text: string, start: number): ObjectSpan {
  const members: Member[] = [];
  let at = skip(text, start + 1);
  if (text[at] === "}") return { start, end: at + 1, members };
  for (;;) {
    at = skip(text, at);
    const keyStart = at, keyEnd = stringEnd(text, at);
    const key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
    at = skip(text, skip(text, keyEnd) + 1);
    const end = valueEnd(text, at);
    members.push({ key, keyStart, valueStart: at, valueEnd: end });
    at = skip(text, end);
    if (text[at] === ",") { at++; continue; }
    return { start, end: at + 1, members };
  }
}
const indentOf = (text: string, at: number): string => { const lineStart = text.lastIndexOf("\n", at - 1) + 1; return /^[ \t]*/.exec(text.slice(lineStart))![0]; };
/** A value as the project's own files write it: scalars as JSON, a list of scalars on one line, an object over lines (or one line when `inline`). */
function render(value: unknown, indent: string, inline: boolean): string {
  if (Array.isArray(value)) return `[${value.map(item => render(item, indent, true)).join(", ")}]`;
  if (!isObject(value)) return JSON.stringify(value);
  const entries = Object.entries(value);
  if (!entries.length) return "{}";
  if (inline) return `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${render(item, indent, true)}`).join(", ")} }`;
  const inner = `${indent}  `;
  return `{\n${entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${render(item, inner, false)}`).join(",\n")}\n${indent}}`;
}
/** Sets `path` to `value` in JSON `text`, keeping everything else byte for byte. A missing key is added after the last member; a missing parent is created. */
export function editJsonText(text: string, path: readonly string[], value: unknown): string {
  const [head, ...tail] = path;
  const span = objectSpan(text, skip(text, 0));
  return editObject(text, span, head!, tail, value, indentOf(text, span.start));
}
function editObject(text: string, span: ObjectSpan, head: string, tail: readonly string[], value: unknown, parentIndent: string): string {
  // JSON.parse (and so the daemon's loader) keeps the LAST occurrence of a repeated key: edit that one, or the file would read as unchanged (#1065 review).
  const found = span.members.findLast(member => member.key === head);
  if (found) {
    if (!tail.length) return text.slice(0, found.valueStart) + render(value, indentOf(text, found.keyStart), !text.slice(span.start, span.end).includes("\n")) + text.slice(found.valueEnd);
    if (text[found.valueStart] !== "{") throw new Error(`${head} in the project config is not an object, so ${[head, ...tail].join(".")} cannot be set; fix it in your editor, then run ahub init again; nothing was written`);
    return editObject(text, objectSpan(text, found.valueStart), tail[0]!, tail.slice(1), value, indentOf(text, found.keyStart));
  }
  const nested = tail.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value);
  const multiline = text.slice(span.start, span.end).includes("\n") || !span.members.length;
  if (!span.members.length) {
    const inner = `${parentIndent}  `;
    return `${text.slice(0, span.start)}{\n${inner}${JSON.stringify(head)}: ${render(nested, inner, false)}\n${parentIndent}}${text.slice(span.end)}`;
  }
  const last = span.members.at(-1)!, indent = indentOf(text, last.keyStart);
  const member = `${JSON.stringify(head)}: ${render(nested, indent, !multiline)}`;
  return `${text.slice(0, last.valueEnd)},${multiline ? `\n${indent}` : " "}${member}${text.slice(last.valueEnd)}`;
}

/** The current text of each file init may write (`null` when absent), and what the plan makes of them. */
export type InitSettingTexts = Record<InitSettingFile, string | null>;
export interface InitSettingsPlan { rows: InitSettingRow[]; next: Partial<Record<InitSettingFile, string>>; }

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function parseJsonObject(file: string, text: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error(`.agenthub/${file} is not valid JSON; fix it in your editor, then run ahub init again; nothing was written`); }
  if (!isObject(parsed)) throw new Error(`.agenthub/${file} must hold a JSON object; fix it in your editor, then run ahub init again; nothing was written`);
  return parsed;
}

/**
 * What the requested settings change, given the current files. `texts["config.json"]` is the text the file will have (the template, with the profile applied, for
 * a new project). A key that already holds the requested value makes no row and no write; an absent key is written. Only the named keys change: an existing file is edited in place by
 * `editJsonText` (and `editSdlcText` for sdlc.toml), a missing config.local.json is created with just the keys asked for. The same key given twice is
 * refused by the parser, so each key appears at most once.
 */
export function planInitSettings(request: InitSettingsRequest, texts: InitSettingTexts): InitSettingsPlan {
  const rows: InitSettingRow[] = [], next: Partial<Record<InitSettingFile, string>> = {};
  const current: Record<"config.json" | "config.local.json", string | null> = { "config.json": texts["config.json"], "config.local.json": texts["config.local.json"] };
  const parsed = (file: "config.json" | "config.local.json") => current[file] === null ? {} : parseJsonObject(file, current[file]!);
  for (const row of INIT_SETTINGS) {
    if (!Object.hasOwn(request.values, row.id)) continue;
    const to = request.values[row.id];
    if (row.file === "sdlc.toml") {
      let from: unknown = "off";
      if (texts["sdlc.toml"] !== null) {
        try { const mode = (Bun.TOML.parse(texts["sdlc.toml"]) as Record<string, unknown>).mode; if (mode !== undefined) from = mode; }
        catch { throw new Error(".agenthub/sdlc.toml is not valid TOML; fix it in your editor, then run ahub init again; nothing was written"); }
      }
      if (same(from, to)) continue; // off with no file is the shipped state: no file is written for it
      const text = editSdlcText(next["sdlc.toml"] ?? texts["sdlc.toml"], [{ path: ["mode"], value: to }]);
      if (text !== null) next["sdlc.toml"] = text;
      rows.push({ key: row.id, file: "sdlc.toml", from, to });
      continue;
    }
    const file = row.file, doc = parsed(file);
    const held = valueAt(doc, row.path);
    if (held !== undefined && same(held, to)) continue; // a key that already holds the value is a no-op; an absent key is written, so the choice is explicit and a team can commit it
    current[file] = current[file] === null ? editJsonText("{}\n", row.path, to) : editJsonText(current[file]!, row.path, to);
    next[file] = current[file]!;
    rows.push({ key: row.id, file, ...(held === undefined ? {} : { from: held }), to } as InitSettingRow);
  }
  return { rows, next };
}
