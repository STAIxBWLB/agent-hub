/** Roadmap data and closed validation. Authority and public projections belong to Tasks. */
export const MILESTONE_STATES = ["proposed", "planned", "active", "done", "dropped"] as const;
export const MILESTONE_HORIZONS = ["now", "next", "later"] as const;
export const MILESTONE_LINK_KINDS = ["spec", "issue", "task", "release"] as const;
export const MILESTONE_HISTORY_LIMIT = 256;
export interface RoadmapConfig { github_mirror: boolean; github_write: "off" | "conductor" }
export function roadmapConfig(raw: unknown): RoadmapConfig {
  if (raw === undefined) return { github_mirror: false, github_write: "off" };
  const row = object(raw);
  if (Object.keys(row).some(key => key !== "github_mirror" && key !== "github_write") || row.github_mirror !== undefined && typeof row.github_mirror !== "boolean" || row.github_write !== undefined && row.github_write !== "off" && row.github_write !== "conductor") throw new Error("roadmap config requires github_mirror boolean and github_write off or conductor");
  return { github_mirror: row.github_mirror === true, github_write: row.github_write === "conductor" ? "conductor" : "off" };
}
export const MILESTONE_LIMITS = Object.freeze({ title: 300, outcome: 4000, spec: 160, issue: 300, actor: 64 });
export type MilestoneState = typeof MILESTONE_STATES[number];
export type MilestoneHorizon = typeof MILESTONE_HORIZONS[number];
export type MilestoneLinkKind = typeof MILESTONE_LINK_KINDS[number];
export interface MilestoneHistoryEntry {
  at: number; by: string; event: "created" | "edited" | "linked" | "unlinked" | "ordered" | "state";
  fields?: string[]; kind?: MilestoneLinkKind;
}
export interface MilestoneInput {
  title: string; outcome: string; state?: MilestoneState; horizon?: MilestoneHorizon; order?: number;
  target?: string | null; parent?: number | null;
}
export type MilestonePatch = Partial<MilestoneInput>;
export interface Milestone {
  id: number; title: string; outcome: string; state: MilestoneState; horizon: MilestoneHorizon; order: number;
  target: string | null; parent: number | null; revision: number; history: MilestoneHistoryEntry[]; created: number; updated: number;
}
export interface MilestoneLink { milestone: number; kind: MilestoneLinkKind; ref: string; by: string; at: number }
const FIELDS = ["title", "outcome", "state", "horizon", "order", "target", "parent"] as const;
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new Error("roadmap fields must be a plain object");
  return raw as Record<string, unknown>;
}
export function milestoneId(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) throw new Error("roadmap id must be a positive integer");
  return raw;
}
export function milestoneRevision(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) throw new Error("roadmap revision must be a nonnegative integer");
  return raw;
}
export function milestoneActor(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > MILESTONE_LIMITS.actor || !/^[a-z][a-z0-9-]*$/.test(raw)) throw new Error("roadmap actor is invalid");
  return raw;
}
function text(raw: unknown, max: number, field: string): string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > max || /[\p{Cc}\p{Cf}]/u.test(raw)) throw new Error(`roadmap ${field} must be bounded printable text`);
  return raw.trim();
}
function target(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error("roadmap target must be a valid YYYY-MM-DD date");
  const date = new Date(`${raw}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== raw) throw new Error("roadmap target must be a valid YYYY-MM-DD date");
  return raw;
}
export function parseMilestonePatch(raw: unknown): MilestonePatch {
  const value = object(raw), result: MilestonePatch = {};
  if (!Object.keys(value).length || Object.keys(value).some(key => !(FIELDS as readonly string[]).includes(key))) throw new Error("roadmap fields are empty or unknown");
  if (Object.hasOwn(value, "title")) result.title = text(value.title, MILESTONE_LIMITS.title, "title");
  if (Object.hasOwn(value, "outcome")) result.outcome = text(value.outcome, MILESTONE_LIMITS.outcome, "outcome");
  if (Object.hasOwn(value, "state")) {
    if (!(MILESTONE_STATES as readonly unknown[]).includes(value.state)) throw new Error("roadmap state is invalid");
    result.state = value.state as MilestoneState;
  }
  if (Object.hasOwn(value, "horizon")) {
    if (!(MILESTONE_HORIZONS as readonly unknown[]).includes(value.horizon)) throw new Error("roadmap horizon is invalid");
    result.horizon = value.horizon as MilestoneHorizon;
  }
  if (Object.hasOwn(value, "order")) result.order = milestoneRevision(value.order);
  if (Object.hasOwn(value, "target")) result.target = target(value.target);
  if (Object.hasOwn(value, "parent")) result.parent = value.parent === null ? null : milestoneId(value.parent);
  return result;
}
export function parseMilestoneInput(raw: unknown): Required<MilestoneInput> {
  const parsed = parseMilestonePatch(raw);
  if (!parsed.title || !parsed.outcome) throw new Error("roadmap title and outcome are required");
  return { title: parsed.title, outcome: parsed.outcome, state: parsed.state ?? "proposed", horizon: parsed.horizon ?? "later", order: parsed.order ?? 0, target: parsed.target ?? null, parent: parsed.parent ?? null };
}
export function milestoneLinkRef(kind: MilestoneLinkKind, raw: unknown): string {
  if (!(MILESTONE_LINK_KINDS as readonly unknown[]).includes(kind)) throw new Error("roadmap link kind is invalid");
  if (kind === "task" || kind === "release") {
    const value = typeof raw === "string" && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : raw;
    return String(milestoneId(value));
  }
  if (kind === "issue") {
    if (typeof raw !== "string" || raw.length > MILESTONE_LIMITS.issue) throw new Error("roadmap issue needs bounded owner/repo#N");
    const match = /^([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)#([1-9][0-9]*)$/.exec(raw);
    if (!match) throw new Error("roadmap issue needs owner/repo#N");
    return `${match[1]!.toLowerCase()}#${milestoneId(Number(match[2]))}`;
  }
  const value = text(raw, MILESTONE_LIMITS.spec, "spec id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) throw new Error("roadmap spec id is invalid");
  return value;
}
export function milestoneHistory(raw: unknown): MilestoneHistoryEntry[] {
  if (!Array.isArray(raw) || raw.length > MILESTONE_HISTORY_LIMIT) throw new Error("roadmap history is full or invalid");
  return raw.map(value => {
    const row = object(value);
    if (Object.keys(row).some(key => !["at", "by", "event", "fields", "kind"].includes(key)) || !["created", "edited", "linked", "unlinked", "ordered", "state"].includes(String(row.event))) throw new Error("roadmap history event is invalid");
    const entry: MilestoneHistoryEntry = { at: milestoneId(row.at), by: milestoneActor(row.by), event: row.event as MilestoneHistoryEntry["event"] };
    if (row.fields !== undefined) {
      if (!Array.isArray(row.fields) || row.fields.length > FIELDS.length || new Set(row.fields).size !== row.fields.length || row.fields.some(field => !(FIELDS as readonly unknown[]).includes(field))) throw new Error("roadmap history fields are invalid");
      entry.fields = [...row.fields] as string[];
    }
    if (row.kind !== undefined) {
      if (!(MILESTONE_LINK_KINDS as readonly unknown[]).includes(row.kind)) throw new Error("roadmap history link kind is invalid");
      entry.kind = row.kind as MilestoneLinkKind;
    }
    return entry;
  });
}

/** R3: a qualified GitHub repository, lower-cased the way issue refs are. */
export function githubRepo(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > MILESTONE_LIMITS.issue || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(raw)) throw new Error("roadmap repo needs owner/name");
  return raw.toLowerCase();
}

/** R3 suggestions: model-written placements, kept apart from milestones until a person or planner accepts one. */
export const SUGGESTION_ITEM_KINDS = ["issue", "task", "spec"] as const;
export const SUGGESTION_STATES = ["pending", "accepted", "rejected", "superseded"] as const;
export type SuggestionItemKind = typeof SUGGESTION_ITEM_KINDS[number];
export type SuggestionState = typeof SUGGESTION_STATES[number];
export interface MilestoneSuggestion {
  id: number; kind: SuggestionItemKind; ref: string;
  /** An existing milestone, or null with `proposal` for "new milestone: <title>". */
  milestone: number | null; proposal: { title: string; outcome: string } | null;
  /** Words copied from the milestone (title or outcome) and from the item text that the model matched. */
  citeMilestone: string | null; citeItem: string;
  state: SuggestionState; by: string; created: number; settled: number | null; settledBy: string | null;
}

/**
 * R2 (#1480): a model-written decomposition of one milestone. Advisory data like a suggestion: it is stored apart from the
 * roadmap, no accept path links anything from part 1, and a later intake reads it by id.
 */
export const DECOMPOSE_INTAKES = ["spec", "task"] as const;
export const DECOMPOSITION_STATES = ["pending", "accepted", "rejected", "superseded"] as const;
export const DECOMPOSE_LIMITS = Object.freeze({ parts: 8, title: 300, detail: 1200, cites: 16 });
export type DecomposeIntake = typeof DECOMPOSE_INTAKES[number];
export type DecompositionState = typeof DECOMPOSITION_STATES[number];
export interface DecomposePart {
  title: string;
  /** What the part changes and how it is verified. */
  detail: string;
  /** A hub task class, named `class` as a `hub_backlog_split` part names it. */
  class: string;
  /** `spec`: the part changes behaviour and needs its own spec issue; `task`: a mechanical chore that goes straight to a task. */
  intake: DecomposeIntake;
  /** Ids copied from what the model was shown: linked spec ids and issue refs. */
  cites: string[];
}
export interface MilestoneDecomposition {
  id: number; milestone: number; parts: DecomposePart[]; state: DecompositionState;
  by: string; created: number; settled: number | null; settledBy: string | null;
}
