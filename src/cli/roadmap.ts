import { milestoneId, milestoneRevision, milestoneLinkRef, parseMilestoneInput, parseMilestonePatch, type MilestoneLinkKind } from "../hub/roadmap.ts";
import { terminalText, wrap } from "./console-state.ts";

const optionalFields = "[--horizon now|next|later] [--order <n>] [--target YYYY-MM-DD|none] [--parent <id>|none]";
export const ROADMAP_FORMS = {
  list: "[list] [--json]", show: "show <id> [--json]",
  new: `new --title <text> --outcome <text> ${optionalFields}`,
  edit: `edit <id> --revision <n> [--title <text>] [--outcome <text>] ${optionalFields}`,
  link: "link <id> <spec|issue|task|release> <ref>", unlink: "unlink <id> <kind> <ref>",
  order: "order <id> <n>", state: "state <id> <proposed|planned|active|done|dropped>",
} as const;
export const ROADMAP_USAGE = `usage: ${Object.values(ROADMAP_FORMS).map(form => `ahub roadmap ${form}`).join(" | ")}`;
export interface RoadmapArgs {
  op: "hub_roadmap_list" | "hub_roadmap_show" | "hub_roadmap_edit";
  args: Record<string, unknown>;
  json: boolean;
}
const fieldFlags = ["title", "outcome", "horizon", "order", "target", "parent"];
const usage = (message: string): never => { throw new Error(`${message}; ${ROADMAP_USAGE}`); };
function integer(value: string | undefined, zero = false): number {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) return usage("roadmap needs a whole-number operand");
  return zero ? milestoneRevision(Number(value)) : milestoneId(Number(value));
}

/** Closed argv only. Values consumed by a text flag remain literal text, including '--json'. */
export function parseRoadmapArgs(argv: readonly string[]): RoadmapArgs {
  let index = 0, json = false;
  if (argv[index] === "--json") { json = true; index++; }
  const command = argv[index] ?? "list";
  if (argv[index] !== undefined) index++;
  if (!["list", "show", "new", "edit", "link", "unlink", "order", "state"].includes(command)) return usage("unknown roadmap command");
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
  if (Array.isArray(view.milestones)) {
    add(`Roadmap (${view.milestones.length} milestones)`);
    if (!view.milestones.length) add("No milestones recorded.");
    for (const item of view.milestones) { lines.push(""); milestone(item); }
  } else if (view.id !== undefined) milestone(view);
  else if (view.milestone !== undefined) milestone(view.milestone);
  else add("Roadmap unavailable: the hub returned no readable milestone view.");
  return lines.join("\n");
}
