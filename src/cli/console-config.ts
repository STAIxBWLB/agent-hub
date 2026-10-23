/**
 * #689: the console's structural config form (Settings panel, key `c`). A pure reducer: it collects answers, builds the one request the
 * hub validates (`config_edit_preview`, then `config_edit_apply`) and never judges a value itself. The loaders' reasons come back from
 * the hub and are shown as they are. A tier 3 key is confirmed by typing its name, never by `y`.
 */
export interface ConfigEditBody { file: "config.local.json" | "sdlc.toml"; revision: string; set: { path: string[]; value: unknown }[] }
export type ConfigFormKind = "instance" | "sdlc" | "other";
export interface ConfigForm {
  kind: ConfigFormKind; token: number;
  /** True until the person has chosen what to edit (1, 2 or 3). */
  choosing?: boolean;
  phase: "fields" | "preview" | "reason" | "confirm" | "typed";
  step: number; answers: string[]; text: string;
  edit?: ConfigEditBody; lines?: string[]; reason?: string;
  /** The key a tier 3 edit must be confirmed with, from the hub's preview. */
  typed?: string; warning?: string;
}
export type ConfigFormEffect =
  | { type: "config_preview"; token: number; edit: ConfigEditBody }
  | { type: "config_write"; edit: ConfigEditBody; reason: string; confirm?: string };
export interface ConfigFormStep { form?: ConfigForm; effect?: ConfigFormEffect; note?: string }

const FIELDS: Record<ConfigFormKind, readonly { name: string; ask: string }[]> = {
  instance: [
    { name: "id", ask: "instance id, <kind>-<name> (e.g. codex-review)" }, { name: "kind", ask: "kind (claude, codex, kimi, jcode, ...)" },
    { name: "roles", ask: "roles, comma list (planner, implementer, verifier, reviewer; empty keeps the kind's)" },
    { name: "start_mode", ask: "start_mode (headless; empty leaves it unset)" }, { name: "review_mode", ask: "review_mode (fresh; empty leaves it unset)" },
    { name: "worktree", ask: "worktree path (empty leaves it unset)" }, { name: "permission_mode", ask: "permission_mode (ask, ask-when-needed, never-ask; empty leaves it unset)" },
    { name: "readOnly", ask: "readOnly (true or false; empty leaves it unset)" },
  ],
  sdlc: [{ name: "mode", ask: "sdlc mode (off, advise, enforce; empty leaves it)" }, { name: "required_checks", ask: "required checks, comma list (empty leaves them)" }],
  other: [{ name: "path", ask: "key path, dot separated (e.g. review.pool)" }, { name: "json", ask: "JSON value (empty removes the key)" }],
};
const list = (text: string): string[] => text.split(",").map(item => item.trim()).filter(Boolean);

/** `1` an instance, `2` the lifecycle, `3` another structural key; anything else opens nothing. */
export function openConfigForm(choice: string, token: number): ConfigForm | undefined {
  const kind = ({ "1": "instance", "2": "sdlc", "3": "other" } as const)[choice as "1"];
  return kind ? { kind, token, phase: "fields", step: 0, answers: [], text: "" } : undefined;
}

export function configFormPrompt(form: ConfigForm): string {
  if (form.choosing) return "edit: 1 instance  2 sdlc lifecycle  3 another key  Esc cancel";
  if (form.phase === "fields") return `${FIELDS[form.kind][form.step]!.ask}: ${form.text}`;
  if (form.phase === "preview") return "checking the change with the hub's loaders; Esc cancels";
  if (form.phase === "reason") return `reason: ${form.text}`;
  if (form.phase === "typed") return `${form.warning ?? "this runs code with the daemon's rights"}; type ${form.typed} to confirm: ${form.text}`;
  return `write ${form.edit?.file} (${form.reason})? y/N`;
}

/** The request the answers describe, or the first reason they cannot. */
function build(form: ConfigForm, revisions: Record<string, string>): { edit: ConfigEditBody } | { note: string } {
  const [a0 = "", a1 = "", a2 = "", a3 = "", a4 = "", a5 = "", a6 = "", a7 = ""] = form.answers;
  if (form.kind === "instance") {
    const value: Record<string, unknown> = { kind: a1 };
    if (a2) value.roles = list(a2);
    if (a3) value.start_mode = a3;
    if (a4) value.review_mode = a4;
    if (a5) value.worktree = a5;
    if (a6) value.permission_mode = a6;
    if (a7) { if (a7 !== "true" && a7 !== "false") return { note: "readOnly is true or false" }; value.readOnly = a7 === "true"; }
    return { edit: { file: "config.local.json", revision: revisions["config.local.json"] ?? "absent", set: [{ path: ["instances", a0], value }] } };
  }
  if (form.kind === "sdlc") {
    const set: ConfigEditBody["set"] = [];
    if (a0) set.push({ path: ["mode"], value: a0 });
    if (a1) set.push({ path: ["required_checks"], value: list(a1) });
    if (!set.length) return { note: "give a mode or the required checks" };
    return { edit: { file: "sdlc.toml", revision: revisions["sdlc.toml"] ?? "absent", set } };
  }
  let value: unknown = null;
  if (a1.trim()) { try { value = JSON.parse(a1); } catch { return { note: "the value is not valid JSON (strings need their quotes)" }; } }
  return { edit: { file: "config.local.json", revision: revisions["config.local.json"] ?? "absent", set: [{ path: a0.split("."), value }] } };
}

/** One key. A chunk longer than one key is pasted text: it is text in a text phase and never an answer to y/N. */
export function reduceConfigForm(form: ConfigForm, key: string, revisions: Record<string, string>): ConfigFormStep {
  if (key === "\x1b") return { form: undefined };
  if (form.choosing) {
    const chosen = key.length === 1 ? openConfigForm(key, form.token) : undefined;
    return { form: chosen ?? form };
  }
  if (form.phase === "preview") return { form };
  if (form.phase === "confirm") {
    if (key === "n") return { form: undefined };
    if (key !== "y") return { form };
    return { form: undefined, effect: { type: "config_write", edit: form.edit!, reason: form.reason! } };
  }
  const text = (current: ConfigForm): ConfigFormStep => {
    if (key === "\x7f" || key === "\b") return { form: { ...current, text: Array.from(current.text).slice(0, -1).join("") } };
    if (key === "\x15") return { form: { ...current, text: "" } };
    if (key.startsWith("\x1b") || key === "\r" || key === "\n") return { form: current };
    return { form: { ...current, text: (current.text + key.replace(/[\x00-\x1f\x7f]/g, "")).slice(0, 4000) } };
  };
  if (key !== "\r" && key !== "\n") return text(form);
  const answer = form.text.trim();
  if (form.phase === "reason") {
    if (!answer || Buffer.byteLength(answer) > 400) return { form, note: "give a reason from 1 to 400 UTF-8 bytes" };
    return { form: { ...form, reason: answer, text: "", phase: form.typed ? "typed" : "confirm" } };
  }
  if (form.phase === "typed") {
    if (answer !== form.typed) return { form, note: `type exactly ${form.typed}` };
    return { form: undefined, effect: { type: "config_write", edit: form.edit!, reason: form.reason!, confirm: form.typed } };
  }
  // phase "fields"
  if (form.kind === "instance" && form.step === 0 && !answer) return { form, note: "an instance id is required" };
  if (form.kind === "instance" && form.step === 1 && !answer) return { form, note: "the kind is required" };
  if (form.kind === "other" && form.step === 0 && (!answer || answer.startsWith(".") || answer.endsWith(".") || answer.includes(".."))) return { form, note: "give a key path such as review.pool" };
  const answers = [...form.answers, answer];
  if (form.step + 1 < FIELDS[form.kind].length) return { form: { ...form, answers, step: form.step + 1, text: "" } };
  const built = build({ ...form, answers }, revisions);
  if ("note" in built) return { form: { ...form, answers: answers.slice(0, -1), text: answer }, note: built.note };
  return { form: { ...form, answers, text: "", phase: "preview", edit: built.edit }, effect: { type: "config_preview", token: form.token, edit: built.edit } };
}
