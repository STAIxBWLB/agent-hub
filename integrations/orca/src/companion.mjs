// agent-hub companion for Orca: the pure decisions (#1198 O1). No Orca API, no child process and no file write live here: the worker injects its ports, so every rule below is
// testable against the O0 fixtures (test/helpers/orca-companion-host.ts, test/fakes/orca-companion-cli.ts) and none of it can reach a real Orca or a real ahub.
//
// What this file will not do, by construction: approve, assign, complete, retry, stop or upgrade anything; start or bootstrap a hub; pass `--json` to `ahub ui`; keep a CLI output,
// a ticket, a task body or a credential anywhere. The one value that is ever returned is a `ahub ui` fallback link, as a transient in-memory string, to the panel that asked.
import { isAbsolute } from "node:path";
import { realpathSync } from "node:fs";

/** The closed set of refusals. A refusal carries one of these and a fixed sentence, never a CLI line, a path or a name. */
export const REFUSALS = Object.freeze({
  inventory_unavailable: "Orca did not list its workspaces. Reopen the panel; nothing was run.",
  truncated: "Orca's workspace list was cut short, so no workspace can be told apart safely. Nothing was run.",
  malformed: "Orca returned a workspace this companion cannot read exactly. Nothing was run.",
  duplicate: "Two workspaces share one id. Nothing was run; select again after Orca's list is fixed.",
  missing: "That workspace is no longer in Orca's list. Select again.",
  changed: "That workspace changed (its id, host, kind or root) since you selected it. Select it again.",
  host_unknown: "Orca did not say which machine this workspace is on. If it is this Mac, say so in the plugin setting \"Treat a missing host id as this Mac\", then reopen the panel.",
  remote: "This workspace is on another host. Run `ahub console` there; nothing was run on this Mac.",
  unreal_root: "The workspace's folder is not a real absolute folder on this Mac. Nothing was run.",
  invalid_setting: "A plugin setting is not valid (\"ahub executable\" must be an absolute path to a file named ahub). Fix it in the plugin settings.",
  not_offered: "This Orca does not offer what that needs. Open a terminal in the workspace yourself and run the command shown.",
  cli_missing: "The ahub command was not found. Set \"ahub executable\" in the plugin settings, or open a terminal and run `ahub ui`.",
  cli_failed: "ahub did not succeed. Check that this project's hub is running (`ahub up` in a terminal), then try again.",
  cli_timeout: "ahub did not answer in time. Nothing was left running.",
  cli_output_too_large: "ahub printed more than expected, so its answer was not used.",
  unrecognized_output: "ahub answered in a form this companion does not recognize, so nothing was opened. Run `ahub ui` in a terminal.",
  bad_request: "That request was not valid.",
  unsupported_platform: "This companion is not qualified on this operating system, so it runs nothing here. Open a terminal in the workspace yourself and run `ahub console`.",
});

/** @typedef {keyof typeof REFUSALS} RefusalCode */
/** @typedef {{ id: string, hostId: string | null, root: string, kind: "worktree" | "folder" }} Binding */
/** @typedef {{ ok: false, refusal: RefusalCode, guidance: string }} Refusal */

export const refuse = /** @returns {Refusal} */ (/** @type {RefusalCode} */ code) => ({ ok: false, refusal: code, guidance: REFUSALS[code] });

const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_ROWS = 500;
const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && !CONTROL.test(value);

/** The same quoting as src/cli/shell-quote.ts (a plugin folder cannot import from the package; test/orca-companion-entry.test.ts pins the two equal). */
export function shellQuote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }
export const terminalCommand = argv => argv.map(shellQuote).join(" ");

/** Orca's inventory, read exactly or refused as a whole: one unreadable row makes every row untrustworthy. */
export function readInventory(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.workspaces) || typeof raw.truncated !== "boolean") return refuse("inventory_unavailable");
  if (raw.truncated) return refuse("truncated");
  if (raw.workspaces.length > MAX_ROWS) return refuse("truncated");
  const seen = new Set();
  const rows = [];
  for (const row of raw.workspaces) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return refuse("malformed");
    const { id, kind, name, path, branch, hostId } = row;
    if (!text(id, 512) || !["worktree", "folder"].includes(kind) || typeof name !== "string" || name.length > 512 || !text(path, 4096)
      || !(branch === null || typeof branch === "string" && branch.length <= 512) || !(hostId === null || text(hostId, 256))) return refuse("malformed");
    if (seen.has(id)) return refuse("duplicate");
    seen.add(id);
    rows.push({ id, kind, name, path, branch, hostId });
  }
  return { ok: true, rows };
}

/**
 * What the person has said about this Mac, from plugin settings read through the host (never inferred). `localHostIds` is a comma separated list of the host ids that mean this machine;
 * `nullHostIsLocal` says a workspace with no host id is on it. Both default to nothing, so a host id the person has not declared is never run locally.
 */
export function parseSettings(raw) {
  const settings = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const ids = typeof settings.localHostIds === "string" ? settings.localHostIds.split(",").map(s => s.trim()).filter(s => s.length > 0 && s.length <= 256 && !CONTROL.test(s)).slice(0, 16) : [];
  // The raw value is judged, not a trimmed copy: a path with a stray newline or a trailing space is a mistake to refuse, not one to quietly repair into a different executable.
  const raw_ = typeof settings.ahubPath === "string" ? settings.ahubPath : "";
  const ahub = raw_;
  const ahubValid = ahub === "" || isAbsolute(ahub) && !CONTROL.test(ahub) && ahub === ahub.trim() && ahub.length <= 4096 && /(^|[\\/])ahub$/.test(ahub);
  return { localHostIds: ids, nullHostIsLocal: settings.trustNullHostAsLocal === true, ahubPath: ahubValid && ahub !== "" ? ahub : undefined, ahubInvalid: !ahubValid };
}

/** The one command shown for a workspace on another host: the existing remote console, as fixed words to run there. Never a link, never a project path. */
export const REMOTE_COMMAND = terminalCommand(["ahub", "console"]);

/** The default canonicalizer: this machine's own real path. A remote path is never resolved here, because a remote host is refused before it is reached. */
export const canonicalizeHere = path => realpathSync(path);

/**
 * Bind one inventory row, chosen by its exact id (never by name or branch), to this Mac. The host must be declared local and the root must canonicalize here.
 * `ctx`: { settings: parseSettings(..), canonicalize(path) => string }.
 * @returns {{ ok: true, binding: Binding } | Refusal}
 */
export function bindRow(row, ctx) {
  // The entries build a POSIX-quoted command line and expect an `ahub` executable, which are not right for a Windows shell, and no Windows receipt exists. An unqualified platform runs nothing
  // rather than something close to right; the identity checks below are not loosened for any platform. `ctx.platform` is injected (the worker passes process.platform).
  if (ctx.platform === "win32") return refuse("unsupported_platform");
  if (row.hostId === null) { if (!ctx.settings.nullHostIsLocal) return refuse("host_unknown"); }
  else if (!ctx.settings.localHostIds.includes(row.hostId)) return refuse("remote");
  if (!isAbsolute(row.path)) return refuse("unreal_root");
  let root;
  try { root = ctx.canonicalize(row.path); } catch { return refuse("unreal_root"); }
  if (typeof root !== "string" || !isAbsolute(root) || CONTROL.test(root)) return refuse("unreal_root");
  return { ok: true, binding: { id: row.id, hostId: row.hostId, root, kind: row.kind } };
}

/** Bind the row with exactly this id out of a raw inventory. */
export function bindWorkspace(rawInventory, id, ctx) {
  const inventory = readInventory(rawInventory);
  if (!inventory.ok) return inventory;
  if (!text(id, 512)) return refuse("bad_request");
  const row = inventory.rows.find(candidate => candidate.id === id);
  return row ? bindRow(row, ctx) : refuse("missing");
}

const same = (a, b) => a.id === b.id && a.hostId === b.hostId && a.root === b.root && a.kind === b.kind;
/** The snapshot the person selected, as a panel sends it back: only its four closed fields, nothing else. */
export function readSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 4 || !["id", "hostId", "root", "kind"].every(key => keys.includes(key))) return undefined;
  const { id, hostId, root, kind } = value;
  if (!text(id, 512) || !(hostId === null || text(hostId, 256)) || !text(root, 4096) || !["worktree", "folder"].includes(kind)) return undefined;
  return { id, hostId, root, kind };
}

/** Before every effect: read a complete inventory again and require the same id, host, kind and real root as the person selected. A difference is `changed`, never a quiet retarget. */
export function verifyBinding(snapshotValue, rawInventory, ctx) {
  const snapshot = readSnapshot(snapshotValue);
  if (!snapshot) return refuse("bad_request");
  const fresh = bindWorkspace(rawInventory, snapshot.id, ctx);
  if (!fresh.ok) return fresh;
  return same(snapshot, fresh.binding) ? fresh : refuse("changed");
}

export const ENTRY_KINDS = Object.freeze(["dashboard", "console", "family"]);

/**
 * The effect of one entry point, as data. Dashboard: the installed `ahub ui` run as a short-lived child (the project root is its working directory, and nothing else: not an argument, not a
 * shell string, not a URL). Console and family console: a terminal created in the workspace whose command is fixed words only, so no project text reaches a shell. `acon ui` serves until its
 * terminal closes, so it belongs to a terminal the person can see and close, never to a child of this worker.
 */
export function entryFor(kind, binding, settings) {
  if (kind === "dashboard") return { via: "cli", executable: settings?.ahubPath ?? "ahub", argv: ["ui"], cwd: binding.root, hostId: binding.hostId };
  if (kind === "console") return { via: "terminal", workspaceId: binding.id, title: "ahub console", argv: ["ahub", "console"] };
  if (kind === "family") return { via: "terminal", workspaceId: binding.id, title: "acon (family console)", argv: ["acon", "ui"] };
  return undefined;
}

const OPENED = /^Dashboard opened\./;
/**
 * Read what `ahub ui` printed. Either its own opener ran ("Dashboard opened.", no link), or it printed exactly one local one-time link. Anything else (no output, two links, a link to another host,
 * a link with credentials, a different scheme, both an opened line and a link) is `unrecognized_output`: nothing is opened and no text of the output is kept or returned.
 */
export function parseDashboardOutput(stdout) {
  if (typeof stdout !== "string") return refuse("unrecognized_output");
  const links = stdout.match(/\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s<>"']+/g) ?? [];
  const opened = stdout.split("\n").some(line => OPENED.test(line.trim()));
  if (opened && links.length === 0) return { ok: true, status: "opened" };
  if (opened || links.length !== 1) return refuse("unrecognized_output");
  let url;
  try { url = new URL(links[0]); } catch { return refuse("unrecognized_output"); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "http:" || !loopback || url.port === "" || url.username !== "" || url.password !== "") return refuse("unrecognized_output");
  return { ok: true, status: "link", url: url.href };
}

export const CLI_LIMITS = Object.freeze({ timeoutMs: 15_000, maxOutputBytes: 8192 });

/** Run one fixed CLI entry through an injected port and return only a closed status; a refusal never carries the CLI's text. */
export async function runCli(port, entry) {
  let result;
  try { result = await port({ executable: entry.executable, argv: [...entry.argv], cwd: entry.cwd, hostId: entry.hostId, ...CLI_LIMITS }); }
  catch (error) { return refuse(error && typeof error === "object" && error.code === "ENOENT" ? "cli_missing" : "cli_failed"); }
  if (!result || typeof result !== "object") return refuse("cli_failed");
  if (result.timedOut === true) return refuse("cli_timeout");
  if (result.truncated === true) return refuse("cli_output_too_large");
  if (result.exitCode !== 0) return refuse("cli_failed");
  return parseDashboardOutput(result.stdout);
}
