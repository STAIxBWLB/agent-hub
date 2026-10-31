import { createHash } from "node:crypto";
import { types } from "node:util";
import { canonicalJson } from "./packs.ts";

export type ResearchCampaignStatus = "draft" | "approved" | "superseded" | "closed";
export interface ResearchUnit {
  id: string;
  round: number;
  question: string;
  perspective: string;
  requiredOutput: string;
  sourceIds: string[];
  dependsOn: string[];
  purpose: "discovery" | "independent_check" | "analysis" | "synthesis";
  adoptTaskId?: number;
}
export interface ResearchCampaignContract {
  question: string;
  scope: string;
  exclusions: string[];
  sourceIds: string[];
  units: ResearchUnit[];
  deliverableSections: { id: string; title: string; ownerUnitId: string }[];
  stopPolicy: { maxUnits: number; maxFollowUpRounds: number; deadline: string };
  budget?: { id: string; hardCap: ("model_calls" | "tool_calls" | "elapsed_ms" | "tokens")[] };
}

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/, SOURCE = /^src:[0-9a-f]{16}$/;
const SHORT = 512, LONG = 4096, BODY = 64 * 1024;
const PURPOSES = ["discovery", "independent_check", "analysis", "synthesis"] as const;
const RESOURCES = ["model_calls", "tool_calls", "elapsed_ms", "tokens"] as const;
export const RESEARCH_RESOURCES = RESOURCES;
export type ResearchResource = typeof RESOURCES[number];
function fail(field: string, reason: string): never { throw new Error(`${field}: ${reason}`); }

/** Only inert JSON-shaped data reaches validation or canonical hashing; never invoke a caller's accessor/toJSON. */
function record(input: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Object.getOwnPropertySymbols(input).length ||
    Object.values(Object.getOwnPropertyDescriptors(input)).some(descriptor => !Object.hasOwn(descriptor, "value"))) fail(field, "expected a plain data object");
  for (const key of Object.keys(input)) if (!keys.includes(key)) {
    const named = key === key.trim() && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) ? `${field}.${key}` : field;
    fail(named, "unknown field");
  }
  return input as Record<string, unknown>;
}
function list(input: unknown, max: number, field: string, min = 0): unknown[] {
  if (!Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length < min || input.length > max || Object.getOwnPropertySymbols(input).length) fail(field, `expected a list of ${min} to ${max} items`);
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.keys(descriptors).some(key => key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)) ||
    Array.from({ length: input.length }, (_, index) => descriptors[String(index)]).some(descriptor => !descriptor || !Object.hasOwn(descriptor, "value"))) fail(field, "expected a dense data list");
  return Array.from({ length: input.length }, (_, index) => descriptors[String(index)]!.value);
}
const utf8 = (value: string) => Buffer.from(value, "utf8").toString("utf8") === value;
function text(input: unknown, max: number, field: string): string {
  if (typeof input !== "string" || input.length > max || Buffer.byteLength(input, "utf8") > max || !input.trim() || !utf8(input)) fail(field, `expected non-empty UTF-8 text of at most ${max} bytes`);
  return input;
}
function id(input: unknown, field: string, source = false): string {
  if (typeof input !== "string" || input !== input.trim() || !(source ? SOURCE : ID).test(input)) fail(field, source ? "expected a source id (src:<16 hex>)" : "expected a lowercase id of 1 to 64 characters");
  return input;
}
function integer(input: unknown, min: number, max: number, field: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < min || input > max) fail(field, `expected an integer from ${min} to ${max}`);
  return input;
}
function distinct(values: readonly (string | number)[], field: string): void {
  if (new Set(values).size !== values.length) fail(field, "duplicate values");
}
function ids(input: unknown, max: number, field: string, source = false): string[] {
  const values = list(input, max, field).map((item, index) => id(item, `${field}[${index}]`, source));
  distinct(values, field);
  return values;
}
function deadline(input: unknown, field: string): string {
  const value = text(input, SHORT, field);
  const match = /^(\d{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?([Zz]|[+-][0-9]{2}:[0-9]{2})$/.exec(value);
  if (!match || match[0] !== value) fail(field, "expected an ISO timestamp with an explicit time zone");
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (!days || day < 1 || day > days || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59 || !Number.isFinite(Date.parse(value))) fail(field, "expected a valid ISO timestamp");
  return value;
}

/** Structural contract only. Source existence, adoption authority, approval time and handoff advancement belong to Tasks. */
export function parseResearchCampaign(input: unknown): ResearchCampaignContract {
  const raw = record(input, ["question", "scope", "exclusions", "sourceIds", "units", "deliverableSections", "stopPolicy", "budget"], "campaign");
  const stop = record(raw.stopPolicy, ["maxUnits", "maxFollowUpRounds", "deadline"], "campaign.stopPolicy");
  const stopPolicy = {
    maxUnits: integer(stop.maxUnits, 1, 32, "campaign.stopPolicy.maxUnits"),
    maxFollowUpRounds: integer(stop.maxFollowUpRounds, 0, 5, "campaign.stopPolicy.maxFollowUpRounds"),
    deadline: deadline(stop.deadline, "campaign.stopPolicy.deadline"),
  };
  const sourceIds = ids(raw.sourceIds, 64, "campaign.sourceIds", true), sourceSet = new Set(sourceIds);
  const units = list(raw.units, 32, "campaign.units", 1).map((value, index): ResearchUnit => {
    const field = `campaign.units[${index}]`, unit = record(value, ["id", "round", "question", "perspective", "requiredOutput", "sourceIds", "dependsOn", "purpose", "adoptTaskId"], field);
    if (typeof unit.purpose !== "string" || !(PURPOSES as readonly string[]).includes(unit.purpose)) fail(`${field}.purpose`, "expected discovery, independent_check, analysis or synthesis");
    const sources = ids(unit.sourceIds, 16, `${field}.sourceIds`, true);
    if (sources.some(source => !sourceSet.has(source))) fail(`${field}.sourceIds`, "must be a subset of campaign.sourceIds");
    return {
      id: id(unit.id, `${field}.id`), round: integer(unit.round, 0, stopPolicy.maxFollowUpRounds, `${field}.round`),
      question: text(unit.question, LONG, `${field}.question`), perspective: text(unit.perspective, SHORT, `${field}.perspective`), requiredOutput: text(unit.requiredOutput, SHORT, `${field}.requiredOutput`),
      sourceIds: sources, dependsOn: ids(unit.dependsOn, 16, `${field}.dependsOn`), purpose: unit.purpose as ResearchUnit["purpose"],
      ...(unit.adoptTaskId !== undefined ? { adoptTaskId: integer(unit.adoptTaskId, 1, Number.MAX_SAFE_INTEGER, `${field}.adoptTaskId`) } : {}),
    };
  });
  if (units.length > stopPolicy.maxUnits) fail("campaign.units", "exceeds stopPolicy.maxUnits");
  distinct(units.map(unit => unit.id), "campaign.units.id");
  distinct(units.flatMap(unit => unit.adoptTaskId === undefined ? [] : [unit.adoptTaskId]), "campaign.units.adoptTaskId");
  const byId = new Map(units.map(unit => [unit.id, unit]));
  for (const [index, unit] of units.entries()) for (const dependency of unit.dependsOn) {
    const previous = byId.get(dependency);
    if (!previous) fail(`campaign.units[${index}].dependsOn`, "names an unknown unit");
    if (previous.round > unit.round) fail(`campaign.units[${index}].dependsOn`, "cannot depend on a later round");
  }
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (unit: ResearchUnit): void => {
    if (visiting.has(unit.id)) fail("campaign.units.dependsOn", "dependency cycle");
    if (visited.has(unit.id)) return;
    visiting.add(unit.id);
    for (const dependency of unit.dependsOn) visit(byId.get(dependency)!);
    visiting.delete(unit.id); visited.add(unit.id);
  };
  for (const unit of units) visit(unit);
  const sections = list(raw.deliverableSections, 32, "campaign.deliverableSections").map((value, index) => {
    const field = `campaign.deliverableSections[${index}]`, section = record(value, ["id", "title", "ownerUnitId"], field);
    const ownerUnitId = id(section.ownerUnitId, `${field}.ownerUnitId`), owner = byId.get(ownerUnitId);
    if (!owner || owner.purpose !== "synthesis") fail(`${field}.ownerUnitId`, "must name an existing synthesis unit");
    return { id: id(section.id, `${field}.id`), title: text(section.title, SHORT, `${field}.title`), ownerUnitId };
  });
  distinct(sections.map(section => section.id), "campaign.deliverableSections.id");
  let budget: ResearchCampaignContract["budget"];
  if (raw.budget !== undefined) {
    const value = record(raw.budget, ["id", "hardCap"], "campaign.budget");
    // Reference ids retain ExecutionBudget.configure's existing exact, non-empty <=200-character contract.
    if (typeof value.id !== "string" || !value.id || value.id.length > 200 || !utf8(value.id)) fail("campaign.budget.id", "expected an existing budget id of 1 to 200 characters");
    const hardCap = list(value.hardCap, RESOURCES.length, "campaign.budget.hardCap").map((resource, index) => {
      if (typeof resource !== "string" || !(RESOURCES as readonly string[]).includes(resource)) fail(`campaign.budget.hardCap[${index}]`, "unknown resource");
      return resource as NonNullable<ResearchCampaignContract["budget"]>["hardCap"][number];
    });
    distinct(hardCap, "campaign.budget.hardCap");
    budget = { id: value.id, hardCap };
  }
  const result: ResearchCampaignContract = {
    question: text(raw.question, LONG, "campaign.question"), scope: text(raw.scope, LONG, "campaign.scope"),
    exclusions: list(raw.exclusions, 32, "campaign.exclusions").map((value, index) => text(value, SHORT, `campaign.exclusions[${index}]`)),
    sourceIds, units, deliverableSections: sections, stopPolicy, ...(budget ? { budget } : {}),
  };
  if (Buffer.byteLength(canonicalJson(result), "utf8") > BODY) fail("campaign", "stored body exceeds 64 KiB");
  return result;
}

/** Content identity only: ordering of lists and the person's literal text remains significant. */
export function campaignHash(contract: ResearchCampaignContract): string {
  return createHash("sha256").update(canonicalJson(parseResearchCampaign(contract))).digest("hex");
}

// ---- #930 T2 (task #597): handoffs, coverage and stop projection, and the dispatch hold. Pure: data in, data out. No clock, no I/O, no model call; every time is an argument.

export interface ResearchHandoff {
  campaignId: string;
  revision: number;
  unitId: string;
  taskId: number;
  evidence: { sourceId: string; locator: string }[];
  unresolved: string[];
  contradictions: { sourceIds: string[]; note: string }[];
  limitations: string[];
  insufficientEvidence?: string;
}
const HANDOFF_REQUIRED = ["campaignId", "revision", "unitId", "taskId", "evidence", "unresolved", "contradictions", "limitations"] as const;

/** Every problem in one throw: a handoff with three missing fields is reported once, with all three named, never one per attempt. */
export function parseResearchHandoff(input: unknown): ResearchHandoff {
  const problems: string[] = [];
  const keep = <T>(work: () => T): T | undefined => { try { return work(); } catch (error) { problems.push(error instanceof Error ? error.message : "invalid handoff"); return undefined; } };
  const raw = keep(() => record(input, [...HANDOFF_REQUIRED, "insufficientEvidence"], "handoff"));
  if (!raw) throw new Error(problems.join("; "));
  for (const key of HANDOFF_REQUIRED) if (!Object.hasOwn(raw, key)) problems.push(`handoff.${key}: required`);
  const has = (key: string) => Object.hasOwn(raw, key);
  const campaignId = has("campaignId") ? keep(() => { if (typeof raw.campaignId !== "string" || !/^rc-[0-9a-f]{12}$/.test(raw.campaignId)) fail("handoff.campaignId", "expected a campaign id (rc-<12 hex>)"); return raw.campaignId; }) : undefined;
  const revision = has("revision") ? keep(() => integer(raw.revision, 1, Number.MAX_SAFE_INTEGER, "handoff.revision")) : undefined;
  const unitId = has("unitId") ? keep(() => id(raw.unitId, "handoff.unitId")) : undefined;
  const taskId = has("taskId") ? keep(() => integer(raw.taskId, 1, Number.MAX_SAFE_INTEGER, "handoff.taskId")) : undefined;
  const evidence = has("evidence") ? keep(() => list(raw.evidence, 64, "handoff.evidence").map((value, index) => {
    const field = `handoff.evidence[${index}]`, row = record(value, ["sourceId", "locator"], field);
    return { sourceId: id(row.sourceId, `${field}.sourceId`, true), locator: text(row.locator, SHORT, `${field}.locator`) };
  })) : undefined;
  const shorts = (key: "unresolved" | "limitations") => has(key) ? keep(() => list(raw[key], 16, `handoff.${key}`).map((value, index) => text(value, SHORT, `handoff.${key}[${index}]`))) : undefined;
  const unresolved = shorts("unresolved"), limitations = shorts("limitations");
  const contradictions = has("contradictions") ? keep(() => list(raw.contradictions, 16, "handoff.contradictions").map((value, index) => {
    const field = `handoff.contradictions[${index}]`, row = record(value, ["sourceIds", "note"], field);
    const sources = list(row.sourceIds, 16, `${field}.sourceIds`, 1).map((source, at) => id(source, `${field}.sourceIds[${at}]`, true));
    distinct(sources, `${field}.sourceIds`);
    return { sourceIds: sources, note: text(row.note, SHORT, `${field}.note`) };
  })) : undefined;
  const insufficientEvidence = has("insufficientEvidence") && raw.insufficientEvidence !== undefined ? keep(() => text(raw.insufficientEvidence, SHORT, "handoff.insufficientEvidence")) : undefined;
  if (problems.length) throw new Error(problems.join("; "));
  const result: ResearchHandoff = { campaignId: campaignId!, revision: revision!, unitId: unitId!, taskId: taskId!, evidence: evidence!, unresolved: unresolved!, contradictions: contradictions!, limitations: limitations!,
    ...(insufficientEvidence !== undefined ? { insufficientEvidence } : {}) };
  if (Buffer.byteLength(canonicalJson(result), "utf8") > BODY) fail("handoff", "stored body exceeds 64 KiB");
  return result;
}

/**
 * What a unit's latest handoff amounts to for coverage. A model's "done" is not coverage (spec): only recorded evidence, or a recorded reason there is none, closes a unit.
 * `insufficient` wins when the reason is recorded, even beside some evidence: the unit says its own coverage is partial.
 */
export type HandoffState = "none" | "incomplete" | "insufficient" | "complete";
export function handoffState(handoff: Pick<ResearchHandoff, "evidence" | "insufficientEvidence"> | undefined): HandoffState {
  if (!handoff) return "none";
  if (handoff.insufficientEvidence !== undefined) return "insufficient";
  return handoff.evidence.length > 0 ? "complete" : "incomplete";
}
const closedState = (state: HandoffState | undefined) => state === "complete" || state === "insufficient";

/**
 * A revision that adds a follow-up round (a unit whose round is not the one it had before) is refused while any discovery unit of the round before still has neither a complete
 * handoff nor an insufficient-evidence reason. `previous` is the units the revision is made from; `states` holds the latest handoff state per unit id (absent means none).
 */
export function followUpProblem(contract: ResearchCampaignContract, previous: readonly ResearchUnit[] | undefined, states: ReadonlyMap<string, HandoffState>): string | undefined {
  const had = new Map((previous ?? []).map(unit => [unit.id, unit.round]));
  for (const added of contract.units.filter(unit => unit.round > 0 && had.get(unit.id) !== unit.round)) {
    const open = contract.units.filter(unit => unit.round === added.round - 1 && unit.purpose === "discovery" && !closedState(states.get(unit.id))).map(unit => unit.id);
    if (open.length) return `follow-up round ${added.round} waits: discovery unit${open.length === 1 ? "" : "s"} ${open.join(", ")} of round ${added.round - 1} ha${open.length === 1 ? "s" : "ve"} neither a complete handoff nor an insufficient-evidence reason`;
  }
  return undefined;
}

/** Why a campaign-bound task is held. One list, shared by the dispatch gate and the projection, so the two cannot disagree. */
export type StudyHold = "campaign_not_approved" | "unit_not_in_revision" | "deadline_passed" | "round_over_limit" | "unit_count_over_limit" | "owner_not_eligible" | "budget_not_covering" | "state_unreadable";
export const STUDY_HOLD_TEXT: Readonly<Record<StudyHold, string>> = Object.freeze({
  campaign_not_approved: "the campaign's approved revision is superseded, closed or revoked",
  unit_not_in_revision: "its unit is not part of the approved revision",
  deadline_passed: "the campaign deadline has passed",
  round_over_limit: "its unit's round is above the campaign's follow-up limit",
  unit_count_over_limit: "the approved revision has more units than the campaign allows",
  owner_not_eligible: "this owner is not in the campaign's budget-eligible set",
  budget_not_covering: "the named budget does not currently cover this task and owner with every hard-capped resource limited",
  state_unreadable: "the campaign or its budget could not be read",
});

/** The campaign-level hold for one unit, from the active approved revision only (never from a request). `status` and `contract` are the active approved revision's, or undefined when there is none. */
export function campaignDispatchHold(input: { status: ResearchCampaignStatus | undefined; contract: ResearchCampaignContract | undefined; unitId: string; now: number }): StudyHold | undefined {
  if (!Number.isFinite(input.now)) return "state_unreadable";
  if (input.status !== "approved" || !input.contract) return "campaign_not_approved";
  const unit = input.contract.units.find(value => value.id === input.unitId);
  if (!unit) return "unit_not_in_revision";
  const { maxUnits, maxFollowUpRounds, deadline } = input.contract.stopPolicy;
  if (Date.parse(deadline) <= input.now) return "deadline_passed";
  if (unit.round > maxFollowUpRounds) return "round_over_limit";
  if (input.contract.units.length > maxUnits) return "unit_count_over_limit";
  return undefined;
}

/** The budget-id-specific hold for a chosen owner: only for a campaign that asked for a hard cap. `covered` is the ledger's own id-specific answer (`ExecutionBudget.covers`), or undefined when it could not be read. */
export function budgetDispatchHold(input: { hardCap: readonly ResearchResource[]; eligibleOwners: readonly string[] | undefined; owner: string; covered: boolean | undefined }): StudyHold | undefined {
  if (!input.hardCap.length) return undefined;
  if (!input.eligibleOwners?.includes(input.owner)) return "owner_not_eligible";
  if (input.covered === undefined) return "state_unreadable";
  return input.covered ? undefined : "budget_not_covering";
}

/** Budget facts the projection needs, as data: the ledger status read once, the instrumented peers, and per unit whether the named budget covers its task and owner. */
export interface ResearchBudgetFacts {
  read: "ok" | "unreadable";
  id: string;
  hardCap: readonly ResearchResource[];
  eligibleOwners?: readonly string[];
  kind?: "task" | "run";
  peers?: readonly string[];
  limits?: Partial<Record<ResearchResource, number>>;
  usage?: Partial<Record<ResearchResource, { used: number; limit: number; remaining: number; reason?: "exhausted" | "unknown_usage" }>>;
  instrumentedPeers?: readonly string[];
}
export interface ResearchProjectionUnit {
  unitId: string;
  taskId?: number;
  taskState?: string;
  owner?: string | null;
  handoff?: { evidenceSources: readonly string[]; insufficientEvidence: boolean; incomplete: boolean };
  /** `ExecutionBudget.covers` for this unit's task and owner, per resource: true only when the named budget meters this exact task and owner and limits that resource. Absent when there is no owner yet or it could not be read. */
  covered?: Partial<Record<ResearchResource, boolean>>;
}
export interface ResearchProjectionInput {
  campaign: { id: string; revision: number; status: ResearchCampaignStatus; contract: ResearchCampaignContract };
  now: number;
  units: readonly ResearchProjectionUnit[];
  budget?: ResearchBudgetFacts;
}
export type BudgetLabel = "enforceable" | "advisory" | "unavailable" | "unknown";
export interface ResearchProjection {
  campaignId: string;
  revision: number;
  status: ResearchCampaignStatus;
  stop: { deadline: string; deadlineExpired: boolean; maxUnits: number; unitCount: number; maxFollowUpRounds: number; currentRound: number;
    followUp: { state: "available" | "held"; reason?: "campaign_not_approved" | "deadline_passed" | "round_limit" | "round_open" } };
  units: {
    id: string; round: number; purpose: ResearchUnit["purpose"]; label: "discovery" | "independent review" | "analysis" | "synthesis";
    taskId?: number; taskState?: string; handoff: HandoffState;
    sources: { declared: string[]; covered: string[]; uncovered: string[] };
    /** A discovery unit: sources another discovery unit is also assigned. An independent review unit: sources it re-checks that a discovery unit also holds. Never mixed. */
    duplicateSources: string[]; reviewOf: string[];
    dispatch: { state: "open" | "held"; reason?: StudyHold };
    budget?: Record<ResearchResource, BudgetLabel>;
  }[];
  coverage: {
    sources: number; unassigned: string[];
    duplicates: { sourceId: string; units: string[] }[];
    independentReview: { sourceId: string; units: string[] }[];
    rounds: { round: number; discovery: number; closed: boolean }[];
  };
  budget?: { id: string; read: "ok" | "unreadable"; scope?: "peer-wide" | "task"; shared: boolean; campaignExclusive: false; hardCap: ResearchResource[];
    eligibleOwners: string[]; usage: Partial<Record<ResearchResource, { used: number | "unknown"; limit: number; remaining: number | "unknown" }>> };
}

/**
 * The coverage and stop projection of one approved or draft revision. Ids, enums, counts and times only: never a question, scope, locator or note, so it is the same for a private campaign.
 * Labels follow the spec's budget support map: `unavailable` for tokens (the ledger cannot count them) and for an owner no budget can meter, `unknown` before an owner exists or when the
 * budget cannot be read, `enforceable` only when the named budget covers this unit's task and owner and the resource has a limit, `advisory` otherwise. Display is not enforcement.
 */
export function studyProjection(input: ResearchProjectionInput): ResearchProjection {
  const { campaign, now } = input, contract = campaign.contract, byUnit = new Map(input.units.map(unit => [unit.unitId, unit]));
  const states = new Map<string, HandoffState>();
  for (const unit of contract.units) {
    const handoff = byUnit.get(unit.id)?.handoff;
    states.set(unit.id, !handoff ? "none" : handoff.insufficientEvidence ? "insufficient" : handoff.incomplete ? "incomplete" : "complete");
  }
  const holders = (purpose: ResearchUnit["purpose"]) => {
    const map = new Map<string, string[]>();
    for (const unit of contract.units.filter(value => value.purpose === purpose)) for (const source of unit.sourceIds) map.set(source, [...(map.get(source) ?? []), unit.id]);
    return map;
  };
  const discovery = holders("discovery"), checks = holders("independent_check");
  const duplicates = [...discovery].filter(([, units]) => units.length > 1).map(([sourceId, units]) => ({ sourceId, units })).sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  const independentReview = [...checks].filter(([source]) => discovery.has(source)).map(([sourceId, units]) => ({ sourceId, units: [...new Set([...(discovery.get(sourceId) ?? []), ...units])] })).sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  const assigned = new Set(contract.units.flatMap(unit => unit.purpose === "discovery" || unit.purpose === "independent_check" ? unit.sourceIds : []));
  const currentRound = Math.max(0, ...contract.units.map(unit => unit.round));
  const roundRows = [...new Set(contract.units.map(unit => unit.round))].sort((a, b) => a - b).map(round => {
    const found = contract.units.filter(unit => unit.round === round && unit.purpose === "discovery");
    return { round, discovery: found.length, closed: found.every(unit => closedState(states.get(unit.id))) };
  });
  const deadline = Date.parse(contract.stopPolicy.deadline), expired = !(deadline > now);
  const roundClosed = roundRows.find(row => row.round === currentRound)?.closed ?? true;
  const followUpReason = campaign.status !== "approved" ? "campaign_not_approved" as const : expired ? "deadline_passed" as const
    : currentRound >= contract.stopPolicy.maxFollowUpRounds ? "round_limit" as const : !roundClosed ? "round_open" as const : undefined;
  const budget = input.budget, limits = budget?.limits ?? {}, instrumented = new Set(budget?.instrumentedPeers ?? []);
  const cell = (resource: ResearchResource, unit: ResearchProjectionUnit | undefined): BudgetLabel => {
    if (resource === "tokens") return "unavailable";
    if (!budget || budget.read !== "ok") return "unknown";
    const owner = unit?.owner;
    if (!owner) return "unknown";
    if (!instrumented.has(owner)) return "unavailable";
    return unit.covered?.[resource] === true && limits[resource] !== undefined ? "enforceable" : "advisory";
  };
  const units = contract.units.map(unit => {
    const facts = byUnit.get(unit.id), state = states.get(unit.id)!;
    const evidence = new Set(facts?.handoff?.evidenceSources ?? []);
    const covered = unit.sourceIds.filter(source => evidence.has(source));
    const hold = campaign.status === "approved" ? campaignDispatchHold({ status: campaign.status, contract, unitId: unit.id, now }) : "campaign_not_approved" as const;
    return {
      id: unit.id, round: unit.round, purpose: unit.purpose,
      label: unit.purpose === "independent_check" ? "independent review" as const : unit.purpose,
      ...(facts?.taskId !== undefined ? { taskId: facts.taskId } : {}), ...(facts?.taskState !== undefined ? { taskState: facts.taskState } : {}),
      handoff: state,
      sources: { declared: [...unit.sourceIds], covered, uncovered: unit.sourceIds.filter(source => !evidence.has(source)) },
      duplicateSources: unit.purpose === "discovery" ? unit.sourceIds.filter(source => (discovery.get(source)?.length ?? 0) > 1) : [],
      reviewOf: unit.purpose === "independent_check" ? unit.sourceIds.filter(source => discovery.has(source)) : [],
      dispatch: hold ? { state: "held" as const, reason: hold } : { state: "open" as const },
      ...(budget ? { budget: Object.fromEntries(RESOURCES.map(resource => [resource, cell(resource, facts)])) as Record<ResearchResource, BudgetLabel> } : {}),
    };
  });
  return {
    campaignId: campaign.id, revision: campaign.revision, status: campaign.status,
    stop: { deadline: contract.stopPolicy.deadline, deadlineExpired: expired, maxUnits: contract.stopPolicy.maxUnits, unitCount: contract.units.length, maxFollowUpRounds: contract.stopPolicy.maxFollowUpRounds, currentRound,
      followUp: followUpReason ? { state: "held", reason: followUpReason } : { state: "available" } },
    units,
    coverage: { sources: contract.sourceIds.length, unassigned: contract.sourceIds.filter(source => !assigned.has(source)), duplicates, independentReview, rounds: roundRows },
    ...(budget ? { budget: { id: budget.id, read: budget.read, ...(budget.kind ? { scope: budget.kind === "run" ? "peer-wide" as const : "task" as const } : {}), shared: budget.kind === "run", campaignExclusive: false as const,
      hardCap: [...budget.hardCap], eligibleOwners: [...(budget.eligibleOwners ?? [])],
      usage: Object.fromEntries(Object.entries(budget.usage ?? {}).map(([resource, row]) => [resource, resource === "tokens" || row!.reason === "unknown_usage"
        ? { used: "unknown" as const, limit: row!.limit, remaining: "unknown" as const } : { used: row!.used, limit: row!.limit, remaining: row!.remaining }])) } } : {}),
  };
}
