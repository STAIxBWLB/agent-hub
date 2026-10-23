/** #689: `ahub settings edit` and `ahub settings backups`. Parsing and rendering only; the hub validates, previews and writes. */
export interface SettingsEditArgs { file: "config.local.json" | "sdlc.toml"; set: { path: string[]; value: unknown }[]; reason?: string; preview: boolean; yes: boolean }
export const SETTINGS_EDIT_USAGE = "usage: ahub settings edit <config.local.json|sdlc.toml> (set <path> <json> | remove <path>)... [--reason <text>] [--preview] [--yes] | ahub settings backups [--json]";

/** The request a command line asks for, or the usage line. Values are JSON, so a string needs its quotes. */
export function parseSettingsEditArgs(argv: readonly string[]): SettingsEditArgs | string {
  const [file, ...rest] = argv;
  if (file !== "config.local.json" && file !== "sdlc.toml") return SETTINGS_EDIT_USAGE;
  const set: SettingsEditArgs["set"] = [];
  let reason: string | undefined, preview = false, yes = false;
  const path = (text: string | undefined): string[] | undefined => {
    if (!text || text.startsWith(".") || text.endsWith(".") || text.includes("..")) return undefined;
    return text.split(".");
  };
  for (let index = 0; index < rest.length; index++) {
    const word = rest[index]!;
    if (word === "--preview") preview = true;
    else if (word === "--yes") yes = true;
    else if (word === "--reason") { reason = rest[++index]; if (reason === undefined) return SETTINGS_EDIT_USAGE; }
    else if (word === "set") {
      const target = path(rest[++index]), text = rest[++index];
      if (!target || text === undefined) return SETTINGS_EDIT_USAGE;
      try { set.push({ path: target, value: JSON.parse(text) }); } catch { return SETTINGS_EDIT_USAGE; }
    } else if (word === "remove") {
      const target = path(rest[++index]);
      if (!target) return SETTINGS_EDIT_USAGE;
      set.push({ path: target, value: null });
    } else return SETTINGS_EDIT_USAGE;
  }
  if (!set.length) return SETTINGS_EDIT_USAGE;
  return { file, set, ...(reason !== undefined ? { reason } : {}), preview, yes };
}

/** What a person reads before confirming: the diff lines, the warning of a tier 3 key and the word to type. */
export function renderEditPreview(reply: { ok?: unknown; lines?: unknown; warning?: unknown; confirm?: unknown }): string[] {
  const lines = Array.isArray(reply.lines) ? reply.lines.map(line => String(line)) : [];
  if (typeof reply.warning === "string") lines.push(`warning: ${reply.warning}`);
  if (typeof reply.confirm === "string") lines.push(`type ${reply.confirm} to confirm`);
  return lines;
}

export interface SettingsEditPorts {
  request: (message: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Asks one line on a terminal; null when there is none. */
  ask: (prompt: string) => Promise<string | null>;
  print: (line: string) => void;
}
/**
 * The whole command, with its ports injected. The person's terminal is the only place a tier 3 key can be changed, and only by
 * typing the key's name: `--yes` confirms an ordinary structural edit and never a tier 3 one.
 */
export async function runSettingsEdit(argv: readonly string[], ports: SettingsEditPorts): Promise<string | undefined> {
  const { request, ask, print } = ports;
  if (argv[0] === "backups") {
    if (argv.length > 2 || (argv[1] !== undefined && argv[1] !== "--json")) return SETTINGS_EDIT_USAGE;
    const view = await request({ t: "config_edit_get" });
    const backups = Array.isArray(view.backups) ? view.backups as { name: string; file: string; at: number; bytes: number }[] : [];
    if (argv[1] === "--json") print(JSON.stringify(backups, null, 2));
    else if (!backups.length) print("no config backups yet");
    else for (const item of backups) print(`${new Date(item.at).toISOString()}  ${item.file}  ${item.bytes} bytes  ${item.name}`);
    return undefined;
  }
  const parsed = parseSettingsEditArgs(argv[0] === "edit" ? argv.slice(1) : argv);
  if (typeof parsed === "string") return parsed;
  const view = await request({ t: "config_edit_get" });
  const revisions = view.revisions as Record<string, string> | undefined;
  const revision = revisions?.[parsed.file];
  if (typeof revision !== "string") return "the running hub does not report config revisions: upgrade and restart it to use ahub settings edit";
  const body = { file: parsed.file, revision, set: parsed.set };
  const preview = await request({ t: "config_edit_preview", edit: body });
  for (const line of renderEditPreview(preview)) print(line);
  if (parsed.preview) { print("preview only; nothing was changed"); return undefined; }
  const typed = typeof preview.confirm === "string" ? preview.confirm : undefined;
  let confirm: string | undefined;
  if (typed) {
    const answer = await ask(`Type ${typed} to confirm: `);
    if (answer === null) return "not a terminal: a key that runs code or locates secrets is confirmed by typing its name; nothing was changed";
    if (answer.trim() !== typed) { print("nothing was changed"); return undefined; }
    confirm = typed;
  } else if (!parsed.yes) {
    const answer = await ask("Write this change? [y/N] ");
    if (answer === null) return "not a terminal: nothing was changed; rerun with --yes after reviewing the preview";
    if (!/^(y|yes)$/i.test(answer.trim())) { print("nothing was changed"); return undefined; }
  }
  const result = await request({ t: "config_edit_apply", edit: body, ...(confirm ? { confirm } : {}), ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}) });
  print(String(result.text ?? "config written"));
  if (Array.isArray(result.restartPending) && result.restartPending.length) print(`restart pending: ${result.restartPending.join(", ")}; restart the hub (ahub restart) to apply`);
  return undefined;
}
