import { milestoneId, milestoneRevision, milestoneLinkRef, parseMilestoneInput, parseMilestonePatch, githubRepo, type MilestoneLinkKind } from "../hub/roadmap.ts";
import { terminalText, wrap } from "./console-state.ts";

const optionalFields = "[--horizon now|next|later] [--order <n>] [--target YYYY-MM-DD|none] [--parent <id>|none]";
export const ROADMAP_FORMS = {
  list: "[list] [--json]", show: "show <id> [--json]",
  new: `new --title <text> --outcome <text> ${optionalFields}`,
  edit: `edit <id> --revision <n> [--title <text>] [--outcome <text>] ${optionalFields}`,
  link: "link <id> <spec|issue|task|release> <ref>", unlink: "unlink <id> <kind> <ref>",
  order: "order <id> <n>", state: "state <id> <proposed|planned|active|done|dropped>",
  unplaced: "unplaced [--repo <owner/name>] [--json]",
  triage: "triage [--repo <owner/name>] [--list] [--json]",
  decompose: "decompose <id> [--json]",
  accept: "accept <suggestion>", reject: "reject <suggestion>",
  importGithub: "import-github [--repo <owner/name>] [--apply] [--json]",
  check: "check [--json]", sync: "sync [--apply --confirm <fingerprint>] [--json]",
  export: "export [--write | --issue <n> [--apply --confirm <fingerprint>]] [--json]",
} as const;
export const ROADMAP_USAGE = `usage: ${Object.values(ROADMAP_FORMS).map(form => `ahub roadmap ${form}`).join(" | ")}`;
export interface RoadmapArgs {
  op: "hub_roadmap_list" | "hub_roadmap_show" | "hub_roadmap_check" | "hub_roadmap_edit" | "hub_roadmap_unplaced" | "hub_roadmap_triage" | "hub_roadmap_decompose" | "roadmap_import_github" | "roadmap_sync" | "roadmap_sync_apply" | "roadmap_export" | "roadmap_export_apply";
  args: Record<string, unknown>;
  json: boolean;
  write?: boolean;
}
/** R3 commands: their flags are not milestone fields, so they are parsed apart from new/edit. */
const R3_COMMANDS = ["unplaced", "triage", "decompose", "accept", "reject", "import-github"];
const R3_JSON = ["unplaced", "triage", "decompose", "import-github"];
const fieldFlags = ["title", "outcome", "horizon", "order", "target", "parent"];
const usage = (message: string): never => { throw new Error(`${message}; ${ROADMAP_USAGE}`); };

function parseR4(command: string, rest: readonly string[], jsonSeen: boolean): RoadmapArgs {
  let json = jsonSeen, apply = false, write = false, issue: number | undefined, confirm: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i]!;
    if (word === "--json" && !json) json = true;
    else if (word === "--apply" && !apply && command !== "check") apply = true;
    else if (word === "--write" && !write && command === "export") write = true;
    else if (word === "--issue" && issue === undefined && command === "export") issue = integer(rest[++i]);
    else if (word === "--confirm" && confirm === undefined && command !== "check") { confirm = rest[++i]; if (!confirm || !/^[a-f0-9]{64}$/.test(confirm)) return usage("roadmap confirmation needs a full fingerprint"); }
    else return usage("unknown or duplicate roadmap option");
  }
  if (confirm && !apply || apply && !confirm || write && (apply || issue !== undefined) || command === "export" && apply && issue === undefined) return usage("roadmap apply needs its preview fingerprint and export --write is separate from --issue");
  if (command === "check") return { op: "hub_roadmap_check", args: {}, json };
  if (command === "sync") return { op: apply ? "roadmap_sync_apply" : "roadmap_sync", args: apply ? { apply, confirm } : {}, json };
  return { op: apply ? "roadmap_export_apply" : "roadmap_export", args: { ...(issue === undefined ? {} : { issue }), ...(apply ? { apply, confirm } : {}) }, json, ...(write ? { write } : {}) };
}
function integer(value: string | undefined, zero = false): number {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) return usage("roadmap needs a whole-number operand");
  return zero ? milestoneRevision(Number(value)) : milestoneId(Number(value));
}

function parseR3(command: string, rest: readonly string[], jsonSeen: boolean): RoadmapArgs {
  let json = jsonSeen, list = false, apply = false, repo: string | undefined;
  const operands: string[] = [];
  for (let at = 0; at < rest.length; at++) {
    const word = rest[at]!;
    if (word === "--json") { if (json) return usage("duplicate roadmap --json flag"); json = true; continue; }
    if (word === "--list" && command === "triage") { if (list) return usage("duplicate roadmap --list flag"); list = true; continue; }
    if (word === "--apply" && command === "import-github") { if (apply) return usage("duplicate roadmap --apply flag"); apply = true; continue; }
    if ((word === "--repo" || word.startsWith("--repo=")) && ["unplaced", "triage", "import-github"].includes(command)) {
      if (repo !== undefined) return usage("duplicate roadmap --repo option");
      const value = word === "--repo" ? rest[++at] : word.slice("--repo=".length);
      if (value === undefined) return usage("roadmap --repo needs owner/name");
      try { repo = githubRepo(value); } catch { return usage("roadmap --repo needs owner/name"); }
      continue;
    }
    if (word.startsWith("-")) return usage("unknown roadmap option");
    operands.push(word);
  }
  if (json && !R3_JSON.includes(command)) return usage(`roadmap ${command} has no --json form`);
  if (command === "accept" || command === "reject") {
    if (operands.length !== 1) return usage(`roadmap ${command} needs one suggestion id`);
    return { op: "hub_roadmap_edit", args: { op: command, suggestion: integer(operands[0]) }, json };
  }
  if (command === "decompose") {
    if (operands.length !== 1) return usage("roadmap decompose needs one milestone id");
    return { op: "hub_roadmap_decompose", args: { id: integer(operands[0]) }, json };
  }
  if (operands.length) return usage(`roadmap ${command} takes no operands`);
  const base = repo === undefined ? {} : { repo };
  if (command === "unplaced") return { op: "hub_roadmap_unplaced", args: base, json };
  if (command === "triage") return { op: "hub_roadmap_triage", args: { ...base, ...(list ? { list: true } : {}) }, json };
  return { op: "roadmap_import_github", args: { ...base, ...(apply ? { apply: true } : {}) }, json };
}

/** Closed argv only. Values consumed by a text flag remain literal text, including '--json'. */
export function parseRoadmapArgs(argv: readonly string[]): RoadmapArgs {
  let index = 0, json = false;
  if (argv[index] === "--json") { json = true; index++; }
  const command = argv[index] ?? "list";
  if (argv[index] !== undefined) index++;
  if (["check", "sync", "export"].includes(command)) return parseR4(command, argv.slice(index), json);
  if (!["list", "show", "new", "edit", "link", "unlink", "order", "state", ...R3_COMMANDS].includes(command)) return usage("unknown roadmap command");
  if (R3_COMMANDS.includes(command)) return parseR3(command, argv.slice(index), json);
  const operands: string[] = [], flags = new Map<string, string>();
  for (; index < argv.length; index++) {
    const word = argv[index]!;
    if (word === "--json") {
      if (json) return usage("duplicate roadmap --json flag");
      json = true; continue;
    }
    if (word.startsWith("--")) {
      const equal = word.indexOf("="), name = word.slice(2, equal < 0 ? undefined : equal);
      if (command !== "new" && command !== "edit" || ![...fieldFlags, ...(command === "edit" ? ["revision"] : [])].includes(name)) return usage("unknown roadmap option");
      if (flags.has(name)) return usage("duplicate roadmap field option");
      const value = equal < 0 ? argv[++index] : word.slice(equal + 1);
      if (value === undefined) return usage("roadmap field option needs a value");
      flags.set(name, value); continue;
    }
    if (word.startsWith("-")) return usage("unknown roadmap option");
    operands.push(word);
  }
  if (json && command !== "list" && command !== "show") return usage("roadmap --json is available on list and show only");
  if (command === "list") {
    if (operands.length) return usage("roadmap list takes no operands");
    return { op: "hub_roadmap_list", args: {}, json };
  }
  if (command === "show") {
    if (operands.length !== 1) return usage("roadmap show needs one id");
    return { op: "hub_roadmap_show", args: { id: integer(operands[0]) }, json };
  }
  if (command === "new" || command === "edit") {
    if (operands.length !== (command === "new" ? 0 : 1)) return usage("roadmap new takes flags; edit needs one id");
    const fields: Record<string, unknown> = {};
    for (const name of fieldFlags) if (flags.has(name)) {
      const value = flags.get(name)!;
      fields[name] = name === "order" ? integer(value, true) : name === "parent" ? value === "none" ? null : integer(value) : name === "target" && value === "none" ? null : value;
    }
    // Validate without substituting normalized values: free text is passed exactly as supplied.
    if (command === "new") parseMilestoneInput(fields); else parseMilestonePatch(fields);
    const args: Record<string, unknown> = { op: command, fields };
    if (command === "edit") {
      if (!flags.has("revision")) return usage("roadmap edit requires --revision from roadmap show");
      args.id = integer(operands[0]); args.revision = integer(flags.get("revision"), true);
    }
    return { op: "hub_roadmap_edit", args, json };
  }
  const required = command === "link" || command === "unlink" ? 3 : 2;
  if (operands.length !== required) return usage("roadmap operation has missing or unused operands");
  const id = integer(operands[0]);
  if (command === "link" || command === "unlink") {
    const kind = operands[1] as MilestoneLinkKind;
    return { op: "hub_roadmap_edit", args: { op: command, id, kind, ref: milestoneLinkRef(kind, operands[2]) }, json };
  }
  if (command === "order") return { op: "hub_roadmap_edit", args: { op: command, id, order: integer(operands[1], true) }, json };
  const fields = parseMilestonePatch({ state: operands[1] });
  return { op: "hub_roadmap_edit", args: { op: command, id, state: fields.state }, json };
}

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === "string" || typeof value === "number" ? terminalText(value) : "unknown";
const count = (value: unknown): string => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : "unknown";
const ratio = (value: unknown, field: string): string => { const r = row(value); return `${count(r[field])}/${count(r.total)}`; };

/** Person-first plain text; rendering never reads the terminal, environment, files or network. */
export function renderRoadmap(input: unknown, width = 80): string {
  if (typeof input === "string") {
    try { input = JSON.parse(input); }
    catch { return terminalText(input); }
  }
  const columns = Number.isFinite(width) && width >= 1 ? Math.floor(width) : 80;
  const view = row(input), lines: string[] = [];
  const add = (value: string) => { lines.push(...wrap(value, columns)); };
  const milestone = (value: unknown) => {
    const m = row(value), progress = row(m.rollup), specs = row(progress.specs), issues = row(progress.issues), releases = row(progress.releases);
    add(`Milestone ${count(m.id)}: ${text(m.title)}`);
    add(`  ${text(m.state)} | ${text(m.horizon)} | order ${count(m.order)} | revision ${count(m.revision)}`);
    add(`  Outcome: ${text(m.outcome)}`);
    if (m.target !== null && m.target !== undefined) add(`  Target: ${text(m.target)}`);
    if (m.parent !== null && m.parent !== undefined) add(`  Parent: ${count(m.parent)}`);
    add(`  Tasks approved: ${ratio(progress.tasks, "approved")}; issues closed: ${ratio(issues, "closed")} (unknown ${count(issues.unknown)})`);
    add(`  Specs: fresh ${count(specs.fresh)}, stale ${count(specs.stale)}, unverified ${count(specs.unverified)}, unknown ${count(specs.unknown)}; total ${count(specs.total)}`);
    add(`  Releases shipped: ${ratio(releases, "shipped")} (unknown ${count(releases.unknown)})`);
    if (m.withheld !== undefined) add(`  Private tasks withheld: ${count(m.withheld)}`);
    const tree = row(m.tree);
    if (m.tree !== undefined && Number(tree.children) > 0) add(`  With children (${count(tree.children)}): tasks ${ratio(tree.tasks, "approved")}, issues ${ratio(tree.issues, "closed")}, releases ${ratio(tree.releases, "shipped")}`);
    const ready = row(m.readyToClose);
    if (ready.ready === true) add("  Ready to close: every linked item is closed or approved. Only the person records done: ahub roadmap state " + count(m.id) + " done");
    else if (m.readyToClose !== undefined && list(ready.reasons).length) add(`  Not ready to close: ${list(ready.reasons).map(text).join("; ")}`);
    for (const value of list(m.links)) {
      const link = row(value); add(`  Link ${text(link.kind)}: ${text(link.ref)}`);
    }
    for (const value of list(m.tasks)) {
      const task = row(value), placement = row(task.placement);
      const issue = /^(.+)#([1-9][0-9]*)$/.exec(text(placement.issue));
      const basis = placement.rule === "source-issue" || placement.rule === "inherited" ? issue ? `inherited from #${issue[2]} (${issue[1]})` : `inherited from ${text(placement.issue)}` : placement.rule === "explicit" ? "explicit link" : "placement unknown";
      add(`  Task ${count(task.id)}: ${text(task.title)} (${text(task.state)}; ${basis})`);
    }
  };
  const names = (rows: unknown[], one: (value: Row) => string) => { for (const value of rows) add(one(row(value))); };
  if (Array.isArray(view.findings) && Array.isArray(view.unknown)) {
    add(`Roadmap drift (${view.findings.length} findings)`);
    names(view.findings, finding => `  Rule ${count(finding.rule)}, milestone ${finding.milestone === null ? "none" : count(finding.milestone)}: ${text(finding.cause)}; ${list(finding.items).map(text).join(", ")}. Next: ${text(finding.remedy)}`);
    if (view.unknown.length) add(`Unknown evidence for rules: ${view.unknown.map(count).join(", ")}`);
    if (view.truncated === true) add("More findings exist; narrow the roadmap before relying on this list.");
    return lines.join("\n");
  }
  if (Array.isArray(view.calls) && typeof view.fingerprint === "string") {
    add(`GitHub mirror: ${view.applied ? "applied" : "dry run"}`);
    for (const call of view.calls) if (Array.isArray(call)) add(`  gh ${call.map(value => `'${String(value).replaceAll("'", "'\\''")}'`).join(" ")}`);
    for (const binding of list(view.bindings)) { const b = row(binding); add(`  Bind local milestone ${count(b.milestone)} to GitHub milestone ${count(b.number)}`); }
    if (!view.applied) add(`Apply this exact preview: ahub roadmap sync --apply --confirm ${text(view.fingerprint)}`);
    return lines.join("\n");
  }
  if (typeof view.markdown === "string" && typeof view.fingerprint === "string") {
    add(view.markdown);
    const endpoint = Array.isArray(view.call) ? view.call[1] : undefined;
    const issue = typeof endpoint === "string" ? /\/issues\/([1-9][0-9]*)$/.exec(endpoint)?.[1] : undefined;
    if (issue && !view.applied) add(`Apply this exact issue preview: ahub roadmap export --issue ${issue} --apply --confirm ${text(view.fingerprint)}`);
    if (view.applied) add("GitHub issue update confirmed.");
    return lines.join("\n");
  }
  if (Array.isArray(view.issues) && Array.isArray(view.tasks) && Array.isArray(view.specs) && view.privateTasks !== undefined) {
    add(`Unplaced work${view.repo ? ` (${text(view.repo)})` : ""}`);
    if (view.partial === true) add("Partial: the GitHub read stopped early or a list was cut, so these lists are a lower bound.");
    for (const name of list(view.unavailable)) add(`Unavailable: ${text(name)} could not be read, so none are listed.`);
    add(`Issues (${view.issues.length}${Number(row(view.more).issues) > 0 ? `, ${count(row(view.more).issues)} more` : ""})`);
    names(view.issues, issue => `  ${text(issue.ref)}: ${text(issue.title)}\n    why: ${text(issue.reason)}`);
    add(`Tasks (${view.tasks.length}${Number(row(view.more).tasks) > 0 ? `, ${count(row(view.more).tasks)} more` : ""})`);
    names(view.tasks, task => `  #${count(task.id)} ${text(task.title)} (${text(task.state)})\n    why: ${text(task.reason)}`);
    add(`Specs (${view.specs.length}${Number(row(view.more).specs) > 0 ? `, ${count(row(view.more).specs)} more` : ""})`);
    names(view.specs, spec => `  ${text(spec.id)}: ${text(spec.title)} (${text(spec.status)})\n    why: ${text(spec.reason)}`);
    add(`Private tasks counted, not listed: ${count(view.privateTasks)}`);
    return lines.join("\n");
  }
  if (Array.isArray(view.parts) && typeof view.milestone === "number") {
    add(`Milestone ${count(view.milestone)} decomposition`);
    if (view.unavailable) add(`Decompose unavailable: ${text(view.unavailable)}`);
    const saved = row(view.saved);
    if (view.saved !== null && view.saved !== undefined) add(`${count(view.parts.length)} part${view.parts.length === 1 ? "" : "s"} saved as pending model answer ${count(saved.id)}; nothing is intaken, linked or published.`);
    if (Number(view.dropped) > 0) add(`Dropped ${count(view.dropped)} model part${Number(view.dropped) === 1 ? "" : "s"} that cited nothing it was shown or did not fit the split schema.`);
    for (const value of list(view.parts)) {
      const part = row(value);
      add(`  ${text(part.title)} -> ${part.intake === "spec" ? "needs its own spec issue" : "goes straight to a task"} (${text(part.class)})`);
      add(`    cites: ${list(part.cites).map(text).join(", ")}`);
      add(`    ${text(part.detail)}`);
    }
    if (!list(view.parts).length && !view.unavailable) add("The model proposed no part that cited an id it was shown.");
    return lines.join("\n");
  }
  if (Array.isArray(view.suggestions)) {
    add(`Triage suggestions (${view.suggestions.length})`);
    if (view.unavailable) add(`Triage unavailable: ${text(view.unavailable)}`);
    if (view.partial === true) add("Partial: more unplaced work remains; run triage again after deciding these.");
    if (view.asked !== undefined) add(`Asked about ${count(view.asked)} item${view.asked === 1 ? "" : "s"}; ${count(view.dropped)} model answer${view.dropped === 1 ? "" : "s"} dropped as unsupported.`);
    names(view.suggestions, s => {
      const proposal = row(s.proposal), target = s.milestone === null || s.milestone === undefined ? `new milestone: ${text(proposal.title)}` : `milestone ${count(s.milestone)}`;
      return `  #${count(s.id)} ${text(s.kind)} ${text(s.ref)} -> ${target}\n    item words: "${text(s.citeItem)}"${s.citeMilestone ? `\n    milestone words: "${text(s.citeMilestone)}"` : ""}\n    apply: ahub roadmap accept ${count(s.id)}   drop: ahub roadmap reject ${count(s.id)}`;
    });
    if (!view.suggestions.length) add("Nothing pending. Nothing is linked until you run ahub roadmap accept <id>.");
    return lines.join("\n");
  }
  if (view.suggestion !== undefined && typeof view.suggestion === "object") {
    const s = row(view.suggestion);
    add(`Suggestion ${count(s.id)} ${text(s.state)}: ${text(s.kind)} ${text(s.ref)}`);
    if (view.milestone !== undefined) milestone(view.milestone);
    return lines.join("\n");
  }
  if (Array.isArray(view.milestones) && view.apply !== undefined) {
    add(`GitHub milestones (${text(view.repo)}): ${view.apply === true ? "applied" : "dry run, nothing written; add --apply to create them"}`);
    if (view.partial === true) add("Partial: the GitHub read stopped early, so this list is a lower bound.");
    names(view.milestones, m => `  GitHub #${count(m.number)} ${text(m.title)}: ${m.action === "create" ? "would create" : "already imported as"}${m.milestone ? ` milestone ${count(m.milestone)}` : ""}; ${list(m.issues).length} issue${list(m.issues).length === 1 ? "" : "s"}, ${count(m.newLinks)} new link${m.newLinks === 1 ? "" : "s"}`);
    if (view.apply === true) add(`Created ${count(view.created)} milestone${view.created === 1 ? "" : "s"}, linked ${count(view.linked)} issue${view.linked === 1 ? "" : "s"}.`);
    if (Number(view.withheld) > 0) add(`Withheld ${count(view.withheld)} milestone${view.withheld === 1 ? "" : "s"} whose text was not cleared for public planning.`);
    return lines.join("\n");
  }
  if (Array.isArray(view.milestones)) {
    add(`Roadmap (${view.milestones.length} milestones)`);
    if (!view.milestones.length) add("No milestones recorded.");
    for (const item of view.milestones) { lines.push(""); milestone(item); }
  } else if (view.id !== undefined) milestone(view);
  else if (view.milestone !== undefined) milestone(view.milestone);
  else add("Roadmap unavailable: the hub returned no readable milestone view.");
  return lines.join("\n");
}
